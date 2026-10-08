// Cold board load (design SLO R4: < 2 s for a board with 100k ops of history).
// Seeds a board's op log in Postgres, then for each run starts a fresh server
// process (empty cache) and times a new client from hello to a fully applied
// board, with and without a snapshot.
//
//   docker compose up -d --wait postgres
//   DATABASE_URL=postgres://tandem:tandem@localhost:5434/tandem pnpm --filter @tandem/server coldload
//
// Writes results/coldload.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { Doc, encodeOp, type Op } from "@tandem/crdt";
import { packSyncResponse } from "@tandem/protocol";
import { SyncClient } from "../../web/src/lib/sync.js";
import { PostgresOpStore } from "../src/store.js";

const HISTORY = Number(process.env.COLDLOAD_OPS ?? 100_000);
const SHAPES = 2_000;
// The server snapshots every 2,000 applied ops, so this is the longest tail
// a real board can have behind its latest snapshot.
const TAIL = 2_000;
const RUNS = Number(process.env.COLDLOAD_RUNS ?? 5);
const PORT = 9200;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

async function post(
  path: string,
  body: unknown,
  token?: string,
): Promise<Record<string, string>> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as Record<string, string>;
}

async function withServer<T>(f: () => Promise<T>): Promise<T> {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(PORT), DATABASE_URL },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/readyz`)).ok) break;
      } catch {
        if (i > 100) throw new Error("server never became ready");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return await f();
  } finally {
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));
  }
}

function history(actor: string): Op[] {
  const doc = new Doc(actor);
  const ops: Op[] = [];
  let s = 42;
  const rand = (): number => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let i = 1; i <= SHAPES; i++)
    ops.push(
      ...doc.applyLocal([
        { t: "putObject", objId: `${actor}:${i}`, type: "rect" },
        { t: "zInsert", objId: `${actor}:${i}`, parent: null },
      ]),
    );
  while (ops.length < HISTORY) {
    const objId = `${actor}:${1 + Math.floor(rand() * SHAPES)}`;
    ops.push(
      ...doc.applyLocal([
        {
          t: "putProp",
          objId,
          key: rand() < 0.5 ? "x" : "y",
          value: { kind: "double", v: rand() * 1000 },
        },
      ]),
    );
  }
  return ops;
}

async function loadOnce(
  boardId: string,
  token: string,
  userId: string,
): Promise<{ ms: number; ops: number; shapes: number }> {
  return withServer(async () => {
    const doc = new Doc(userId);
    let applied = 0;
    const apply = doc.applyRemote.bind(doc);
    doc.applyRemote = (op) => {
      applied++;
      return apply(op);
    };
    const client = new SyncClient({
      doc,
      boardId,
      token,
      userId,
      name: "loader",
      color: "#3355ff",
      url: `ws://127.0.0.1:${PORT}/ws`,
      socketFactory: (u) => new WebSocket(u) as unknown as globalThis.WebSocket,
    });
    const t0 = performance.now();
    await client.start();
    await new Promise<void>((res) => {
      const check = (): void =>
        client.status === "open" ? res() : void setTimeout(check, 1);
      check();
    });
    const ms = performance.now() - t0;
    client.close();
    return { ms, ops: applied, shapes: doc.shapes().length };
  });
}

// Two-sided 95% Student t critical values, indexed by degrees of freedom.
const T95 = [NaN, 12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26];

function summarize(xs: number[]): { mean: number; ci95: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  return { mean, ci95: ((T95[n - 1] ?? 1.96) * sd) / Math.sqrt(n) };
}

const store = new PostgresOpStore(DATABASE_URL);
await store.init();
const { boardId, token, userId } = await withServer(async () => {
  const account = await post("/auth/register", {
    email: `coldload-${Date.now()}@test.local`,
    password: "password123",
  });
  const board = await post("/boards", {}, account.token);
  return {
    boardId: board.boardId!,
    token: account.token!,
    userId: account.userId!,
  };
});

const ops = history(userId);
for (let i = 0; i < ops.length; i += 5_000)
  await store.appendOps(
    boardId,
    ops.slice(i, i + 5_000).map((op) => ({ ...op, data: encodeOp(op) })),
  );

const results: Record<string, unknown> = {};
for (const variant of ["log only", "snapshot + 2,000-op tail"]) {
  if (variant !== "log only") {
    const head = new Doc("snapshotter");
    head.merge(ops.slice(0, ops.length - TAIL));
    await store.saveSnapshot(
      boardId,
      packSyncResponse(
        Object.fromEntries(head.stateVector()),
        head.compactOps().map((op) => encodeOp(op)),
      ),
    );
  }
  const runs = [];
  for (let r = 0; r < RUNS; r++)
    runs.push(await loadOnce(boardId, token, userId));
  if (runs.some((r) => r.shapes !== SHAPES))
    throw new Error(`${variant}: board loaded incompletely`);
  const ms = summarize(runs.map((r) => r.ms));
  results[variant] = { ms, opsSentToClient: runs[0]!.ops, runs };
  console.log(
    `${variant}: ${ms.mean.toFixed(0)} ms, ${runs[0]!.ops} ops to the client`,
  );
}
await store.close();

fs.writeFileSync(
  new URL("../../../results/coldload.json", import.meta.url),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      hardware: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)}GB RAM, ${os.platform()} ${os.release()}, node ${process.version}`,
      method:
        "fresh server process per run (cold cache); time from client start to a fully applied board; Postgres in Docker on the same machine",
      history: { ops: HISTORY, shapes: SHAPES, snapshotTail: TAIL },
      slo: { ms: 2000 },
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote results/coldload.json");
