// Edit-to-remote latency under load: N editor clients spread over M server nodes
// sharing one Redis bus, all editing one board. Records p50/p95/p99 of the time
// from an edit being applied locally to it being applied on every other client.
//
//   TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @tandem/server bench
//
// Writes results/load.json next to the repo root.
import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { Doc } from "@tandem/crdt";
import { startServer, type RunningServer } from "../src/server.js";
import { MemoryMetaStore } from "../src/meta.js";
import { PostgresOpStore, type OpStore } from "../src/store.js";
import { PostgresMetaStore, type MetaStore } from "../src/meta.js";
import { RedisBus } from "../src/bus.js";
import { SyncClient } from "../../web/src/lib/sync.js";

const NODES = Number(process.env.LOAD_NODES ?? 2);
const EDITORS = Number(process.env.LOAD_EDITORS ?? 20);
const EDITS_PER_EDITOR = Number(process.env.LOAD_EDITS ?? 40);
const DATABASE_URL = process.env.DATABASE_URL;

interface Sample {
  editor: string;
  ms: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[idx]!;
}

async function runConfig(
  editorsCount: number,
  nodesCount: number,
): Promise<Record<string, unknown>> {
  const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
  const meta: MetaStore = DATABASE_URL
    ? new PostgresMetaStore(DATABASE_URL)
    : new MemoryMetaStore();
  const store: OpStore = DATABASE_URL
    ? new PostgresOpStore(DATABASE_URL)
    : new (await import("../src/store.js")).MemoryOpStore();
  await meta.init();
  await store.init();

  const nodes: RunningServer[] = [];
  for (let i = 0; i < nodesCount; i++) {
    const bus = new RedisBus(redisUrl);
    await bus.connect();
    nodes.push(await startServer({ port: 0, metaStore: meta, store, bus }));
  }

  // one owner account, one board, every editor added as editor
  const suffix = Date.now();
  const reg = async (
    email: string,
  ): Promise<{ userId: string; token: string }> => {
    const res = await fetch(
      `http://127.0.0.1:${nodes[0]!.port}/auth/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password123" }),
      },
    );
    return (await res.json()) as { userId: string; token: string };
  };
  const owner = await reg(`load-owner-${suffix}@test.local`);
  const breg = await fetch(`http://127.0.0.1:${nodes[0]!.port}/boards`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${owner.token}`,
    },
    body: "{}",
  });
  const { boardId } = (await breg.json()) as { boardId: string };

  const editors = [owner];
  for (let i = 1; i < editorsCount; i++) {
    const email = `load-e${i}-${suffix}@test.local`;
    editors.push(await reg(email));
    await fetch(
      `http://127.0.0.1:${nodes[0]!.port}/boards/${boardId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({ email, role: "editor" }),
      },
    );
  }

  const clients: SyncClient[] = [];
  const docs: Doc[] = [];
  for (let i = 0; i < editorsCount; i++) {
    const acc = editors[i]!;
    const doc = new Doc(acc.userId);
    const client = new SyncClient({
      doc,
      boardId,
      token: acc.token,
      userId: acc.userId,
      name: `e${i}`,
      color: "#3355ff",
      url: `ws://127.0.0.1:${nodes[i % nodesCount]!.port}/ws`,
      socketFactory: (u) => new WebSocket(u) as unknown as WebSocket,
    });
    await client.start();
    docs.push(doc);
    clients.push(client);
  }
  await Promise.all(
    clients.map(
      (c) =>
        new Promise<void>((res) => {
          const check = (): void =>
            c.status === "open" ? res() : setTimeout(check, 20);
          check();
        }),
    ),
  );

  // seed the board so every client has a shared base
  await clients[0]!.edit([
    { t: "putObject", objId: "board:base", type: "rect" },
    { t: "zInsert", objId: "board:base", parent: null },
  ]);
  await new Promise((r) => setTimeout(r, 300));

  const samples: Sample[] = [];
  const edits: Promise<void>[] = [];
  const tStart = performance.now();
  for (let round = 0; round < EDITS_PER_EDITOR; round++) {
    for (let i = 0; i < editorsCount; i++) {
      const client = clients[i]!;
      const acc = editors[i]!;
      const key = `k${round}`;
      const t0 = performance.now();
      const promise = client
        .edit([
          {
            t: "putProp",
            objId: "board:base",
            key,
            value: { kind: "int", v: i },
          },
        ])
        .then(
          () =>
            new Promise<void>((res, rej) => {
              // latency = from the edit being issued to it being applied on
              // every *other* replica (queueing included)
              const poll = (): void => {
                const others = docs.filter((_, j) => j !== i);
                if (
                  others.every((d) =>
                    d.opList.some(
                      (op) => op.spec.t === "putProp" && op.spec.key === key,
                    ),
                  )
                ) {
                  samples.push({
                    editor: acc.userId,
                    ms: performance.now() - t0,
                  });
                  res();
                } else if (performance.now() - t0 > 20_000) {
                  rej(new Error(`fan-out timeout for ${key}`));
                } else {
                  setTimeout(poll, 2);
                }
              };
              poll();
            }),
        );
      edits.push(promise);
    }
  }
  await Promise.all(edits);
  const elapsed = performance.now() - tStart;

  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const totalOps = editorsCount * EDITS_PER_EDITOR;
  const result = {
    date: new Date().toISOString(),
    hardware: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 1024 ** 3)}GB RAM, node ${process.version}`,
    config: {
      nodes: nodesCount,
      editors: editorsCount,
      editsPerEditor: EDITS_PER_EDITOR,
      database: DATABASE_URL ? "postgres" : "memory",
    },
    fanout: {
      samples: ms.length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      p99: percentile(ms, 99),
      max: ms[ms.length - 1],
    },
    throughputOpsPerSec: Math.round((totalOps / elapsed) * 1000),
    elapsedMs: Math.round(elapsed),
  };

  for (const c of clients) c.close();
  // let in-flight batches finish before tearing the bus down, otherwise the
  // tail of the run logs publish failures that are really just shutdown order
  await new Promise((r) => setTimeout(r, 500));
  for (const n of nodes) await n.close();
  await meta.close();
  await store.close();
  return result;
}

async function main(): Promise<void> {
  fs.mkdirSync(new URL("../../../results", import.meta.url), {
    recursive: true,
  });

  // LOAD_SWEEP="20,50,100,200,400" records a scaling curve instead of one point
  const sweep = process.env.LOAD_SWEEP;
  if (sweep) {
    const points: Record<string, unknown>[] = [];
    for (const count of sweep.split(",").map((n) => Number(n.trim()))) {
      const r = await runConfig(count, NODES);
      points.push(r);
      console.log(
        `editors=${count} p50=${r.fanout!.p50!.toFixed(1)}ms p95=${r.fanout!.p95!.toFixed(1)}ms p99=${r.fanout!.p99!.toFixed(1)}ms ops/s=${r.throughputOpsPerSec}`,
      );
    }
    fs.writeFileSync(
      new URL("../../../results/scale.json", import.meta.url),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          hardware: points[0]?.hardware,
          sloNote: "target: p95 < 300ms for 50 editors on one board",
          points,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("wrote results/scale.json");
    return;
  }

  const result = await runConfig(EDITORS, NODES);
  console.log(JSON.stringify(result, null, 2));
  fs.writeFileSync(
    new URL("../../../results/load.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log("wrote results/load.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
