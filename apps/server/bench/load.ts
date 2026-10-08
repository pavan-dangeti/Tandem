// Edit-to-remote latency under sustained load. Server nodes run as separate
// processes (the production bundle) sharing Postgres and Redis; simulated
// editors run in worker processes. Latency is measured from an edit being
// issued to it being applied on every other replica of its board.
//
//   docker compose up -d --wait postgres redis
//   DATABASE_URL=postgres://tandem:tandem@localhost:5434/tandem pnpm --filter @tandem/server bench
//
// Writes results/scale.json.
import { fork, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { FromWorker, ToWorker, WorkerClient } from "./load-worker.js";

const NODES = Number(process.env.LOAD_NODES ?? 2);
const RATE = Number(process.env.LOAD_RATE ?? 2);
const DURATION_MS = Number(process.env.LOAD_SECONDS ?? 10) * 1000;
const REPEATS = Number(process.env.LOAD_REPEATS ?? 3);
const WORKERS = Number(
  process.env.LOAD_WORKERS ?? Math.max(1, os.cpus().length - NODES - 2),
);
// "boards x editors-per-board"
const SWEEP = (
  process.env.LOAD_SWEEP ?? "1x20,1x50,1x100,1x150,1x200,1x300,25x8"
).split(",");
const SLO_P95_MS = 300;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
if (!DATABASE_URL)
  throw new Error("DATABASE_URL is required: nodes share boards via Postgres");

interface NodeProc {
  proc: ChildProcess;
  port: number;
}

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`node on ${port} never became ready`);
}

async function startNodes(): Promise<NodeProc[]> {
  const nodes = Array.from({ length: NODES }, (_, i) => {
    const port = 9100 + i;
    const proc = spawn("node", ["dist/index.js"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL,
        REDIS_URL,
        AUTH_SECRET: "load-test-secret-load-test-secret",
        SHARE_SECRET: "load-test-share-secret-load-test",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    return { proc, port };
  });
  await Promise.all(nodes.map((n) => waitReady(n.port)));
  return nodes;
}

async function processStats(
  port: number,
): Promise<{ cpuSeconds: number; rssBytes: number }> {
  const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
  const read = (name: string): number =>
    Number(new RegExp(`^${name} (\\S+)$`, "m").exec(text)?.[1] ?? NaN);
  return {
    cpuSeconds: read("tandem_process_cpu_seconds_total"),
    rssBytes: read("tandem_process_resident_memory_bytes"),
  };
}

async function post(
  port: number,
  path: string,
  body: unknown,
  token?: string,
): Promise<Record<string, string>> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
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

async function setup(
  nodes: NodeProc[],
  boards: number,
  editors: number,
): Promise<WorkerClient[]> {
  const port = nodes[0]!.port;
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = (b: number, i: number): string =>
    `load-${run}-b${b}-e${i}@test.local`;
  const clients: WorkerClient[] = [];
  for (let b = 0; b < boards; b++) {
    const register = (i: number): Promise<Record<string, string>> =>
      post(port, "/auth/register", {
        email: email(b, i),
        password: "password123",
      });
    const owner = await register(0);
    const { boardId } = await post(port, "/boards", {}, owner.token);
    const accounts = [owner];
    for (let i = 1; i < editors; i += 20) {
      const batch = Array.from(
        { length: Math.min(20, editors - i) },
        (_, j) => i + j,
      );
      accounts.push(...(await Promise.all(batch.map(register))));
    }
    await Promise.all(
      accounts
        .slice(1)
        .map((_, i) =>
          post(
            port,
            `/boards/${boardId}/members`,
            { email: email(b, i + 1), role: "editor" },
            owner.token,
          ),
        ),
    );
    accounts.forEach((a, i) =>
      clients.push({
        userId: a.userId!,
        token: a.token!,
        boardId: boardId!,
        url: `ws://127.0.0.1:${nodes[(b + i) % nodes.length]!.port}/ws`,
      }),
    );
  }
  return clients;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

function onMessage<T extends FromWorker["type"]>(
  w: ChildProcess,
  type: T,
): Promise<Extract<FromWorker, { type: T }>> {
  return new Promise((res) =>
    w.on("message", (m: FromWorker) => {
      if (m.type === type) res(m as Extract<FromWorker, { type: T }>);
    }),
  );
}

async function runPoint(boards: number, editors: number) {
  const nodes = await startNodes();
  try {
    const clients = await setup(nodes, boards, editors);
    const shares: WorkerClient[][] = Array.from(
      { length: Math.min(WORKERS, clients.length) },
      () => [],
    );
    clients.forEach((c, i) => shares[i % shares.length]!.push(c));
    const workers = shares.map((share) => {
      const w = fork(new URL("./load-worker.ts", import.meta.url));
      w.send({
        type: "init",
        clients: share,
        rate: RATE,
        durationMs: DURATION_MS,
      } satisfies ToWorker);
      return w;
    });
    const results = workers.map((w) => onMessage(w, "done"));
    await Promise.all(workers.map((w) => onMessage(w, "ready")));

    const before = await Promise.all(nodes.map((n) => processStats(n.port)));
    const startAt = Date.now() + 500;
    for (const w of workers) w.send({ type: "go", startAt } satisfies ToWorker);
    // CPU is sampled over the editing window only, not the drain afterwards
    await new Promise((r) => setTimeout(r, startAt + DURATION_MS - Date.now()));
    const after = await Promise.all(nodes.map((n) => processStats(n.port)));
    const done = await Promise.all(results);

    const issued = new Map(done.flatMap((d) => d.issued));
    const arrived = new Map<string, { last: number; count: number }>();
    for (const d of done)
      for (const [id, last, count] of d.arrivals) {
        const a = arrived.get(id);
        if (a) {
          a.last = Math.max(a.last, last);
          a.count += count;
        } else arrived.set(id, { last, count });
      }
    const latencies: number[] = [];
    let incomplete = 0;
    for (const [id, t0] of issued) {
      const a = arrived.get(id);
      if (a && a.count === editors - 1) latencies.push(a.last - t0);
      else incomplete++;
    }
    latencies.sort((a, b) => a - b);
    const windowS = DURATION_MS / 1000;
    return {
      edits: issued.size,
      incomplete,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies[latencies.length - 1]!,
      editsPerSec: Math.round(issued.size / windowS),
      workerCpuPercent: Math.max(...done.map((d) => d.cpuPercent)),
      nodes: nodes.map((_, i) => ({
        cpuPercent: Math.round(
          ((after[i]!.cpuSeconds - before[i]!.cpuSeconds) / windowS) * 100,
        ),
        rssMB: Math.round(after[i]!.rssBytes / 2 ** 20),
      })),
    };
  } finally {
    for (const n of nodes) n.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const points = [];
for (const spec of SWEEP) {
  const [boards, editors] = spec.split("x").map(Number) as [number, number];
  const runs = [];
  for (let r = 0; r < REPEATS; r++) runs.push(await runPoint(boards, editors));
  const p95s = runs.map((x) => x.p95);
  const point = {
    boards,
    editorsPerBoard: editors,
    p50: median(runs.map((x) => x.p50)),
    p95: median(p95s),
    p95Range: [Math.min(...p95s), Math.max(...p95s)],
    p99: median(runs.map((x) => x.p99)),
    incomplete: runs.reduce((n, x) => n + x.incomplete, 0),
    runs,
  };
  points.push(point);
  console.log(
    `${boards} board(s) x ${editors} editors: p50=${point.p50.toFixed(1)} p95=${point.p95.toFixed(1)} p99=${point.p99.toFixed(1)} ms, incomplete=${point.incomplete}`,
  );
}

fs.writeFileSync(
  new URL("../../../results/scale.json", import.meta.url),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      hardware: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)}GB RAM, ${os.platform()} ${os.release()}, node ${process.version}`,
      method:
        "sustained load; server nodes and editor workers are separate processes on one machine; Postgres and Redis in Docker on the same machine",
      config: {
        nodes: NODES,
        editsPerSecPerEditor: RATE,
        durationSeconds: DURATION_MS / 1000,
        workers: WORKERS,
        repeats: REPEATS,
      },
      slo: { p95Ms: SLO_P95_MS, editorsPerBoard: 50 },
      points,
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote results/scale.json");
