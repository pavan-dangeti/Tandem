// Hosts a share of the simulated editors for bench/load.ts in its own process,
// so client-side CRDT work never competes with the server nodes' event loops.
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { Doc, type Op } from "@tandem/crdt";
import { SyncClient } from "../../web/src/lib/sync.js";

export interface WorkerClient {
  userId: string;
  token: string;
  boardId: string;
  url: string;
}

export type ToWorker =
  | { type: "init"; clients: WorkerClient[]; rate: number; durationMs: number }
  | { type: "go"; startAt: number };

export type FromWorker =
  | { type: "ready" }
  | {
      type: "done";
      issued: [string, number][];
      arrivals: [string, number, number][];
      cpuPercent: number;
    };

// Wall-clock milliseconds with sub-ms precision, comparable across processes.
const clock = (): number => performance.timeOrigin + performance.now();
const send = (m: FromWorker): void => void process.send!(m);

const clients: SyncClient[] = [];
const issued = new Map<string, number>();
// edit id -> latest time any replica in this process applied it, and how many did
const arrivals = new Map<string, { last: number; count: number }>();
let lastArrival = 0;
let rate = 0;
let durationMs = 0;

const editId = (op: Op): string | null =>
  op.spec.t === "putProp" ? `${op.spec.objId}|${op.spec.key}` : null;

async function init(list: WorkerClient[]): Promise<void> {
  for (const c of list) {
    const doc = new Doc(c.userId);
    const applyRemote = doc.applyRemote.bind(doc);
    doc.applyRemote = (op: Op) => {
      const result = applyRemote(op);
      const id = editId(op);
      // a duplicate delivery is not a second arrival
      if (result && id && op.actor !== c.userId) {
        const now = clock();
        const a = arrivals.get(id);
        if (a) {
          a.last = now;
          a.count++;
        } else arrivals.set(id, { last: now, count: 1 });
        lastArrival = now;
      }
      return result;
    };
    const client = new SyncClient({
      doc,
      boardId: c.boardId,
      token: c.token,
      userId: c.userId,
      name: c.userId,
      color: "#3355ff",
      url: c.url,
      socketFactory: (u) => new WebSocket(u) as unknown as globalThis.WebSocket,
    });
    await client.start();
    clients.push(client);
  }
  await Promise.all(
    clients.map(
      (c) =>
        new Promise<void>((res) => {
          const check = (): void =>
            c.status === "open" ? res() : void setTimeout(check, 20);
          check();
        }),
    ),
  );
  for (const c of clients)
    await c.edit([
      { t: "putObject", objId: `${c.userId}:o`, type: "rect" },
      { t: "zInsert", objId: `${c.userId}:o`, parent: null },
    ]);
}

let cpuPercent = 0;

function run(startAt: number): void {
  const endAt = startAt + durationMs;
  setTimeout(() => {
    const cpu0 = process.cpuUsage();
    setTimeout(() => {
      const { user, system } = process.cpuUsage(cpu0);
      cpuPercent = Math.round((user + system) / 10 / durationMs);
    }, durationMs);
  }, startAt - clock());
  const period = 1000 / rate;
  for (const c of clients) {
    let n = 0;
    const tick = (): void => {
      if (clock() >= endAt) return;
      const key = `k${n++}`;
      issued.set(`${c.userId}:o|${key}`, clock());
      void c.edit([
        {
          t: "putProp",
          objId: `${c.userId}:o`,
          key,
          value: { kind: "int", v: n },
        },
      ]);
      setTimeout(tick, period);
    };
    // a random phase keeps editors from firing in lockstep
    setTimeout(tick, startAt - clock() + Math.random() * period);
  }
  // done once the run is over and fan-out has been quiet for two seconds
  const finish = (): void => {
    const now = clock();
    if (now < endAt + 2000 || now - lastArrival < 2000) {
      setTimeout(finish, 250);
      return;
    }
    send({
      type: "done",
      issued: [...issued],
      arrivals: [...arrivals].map(([id, a]) => [id, a.last, a.count]),
      cpuPercent,
    });
    for (const c of clients) c.close();
    setTimeout(() => process.exit(0), 200);
  };
  setTimeout(finish, endAt - clock());
}

process.on("message", (m: ToWorker) => {
  if (m.type === "init") {
    rate = m.rate;
    durationMs = m.durationMs;
    void init(m.clients).then(() => send({ type: "ready" }));
  } else run(m.startAt);
});
