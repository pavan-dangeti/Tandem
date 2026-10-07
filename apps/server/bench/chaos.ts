// Network chaos: clients talk to the server through toxiproxy while we degrade
// the link (latency, bandwidth, hard cut) and then heal it. After healing,
// every replica must converge and no acknowledged edit may be missing.
//
//   docker compose --profile chaos up -d
//   TEST_DATABASE_URL=postgres://tandem:tandem@localhost:5434/tandem \
//   TOXIPROXY_URL=http://127.0.0.1:8474 PROXY_PORT=8666 \
//   pnpm --filter @tandem/server chaos
import fs from "node:fs";
import WebSocket from "ws";
import { Doc } from "@tandem/crdt";
import { startServer, type RunningServer } from "../src/server.js";
import { MemoryMetaStore } from "../src/meta.js";
import { MemoryOpStore } from "../src/store.js";
import { SyncClient } from "../../web/src/lib/sync.js";

const TOXI = process.env.TOXIPROXY_URL ?? "http://127.0.0.1:8474";
const PROXY = "tandem-ws";
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8666);
const CLIENTS = Number(process.env.CHAOS_CLIENTS ?? 3);
const EDITS_PER_CLIENT = Number(process.env.CHAOS_EDITS ?? 25);

interface Phase {
  name: string;
  detail: string;
  converged: boolean;
  lostOps: number;
}

async function api(
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<void> {
  const res = await fetch(`${TOXI}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`toxiproxy ${method} ${path} -> ${res.status}`);
}

async function addToxic(
  name: string,
  type: string,
  attrs: Record<string, number>,
  toxicity = 1,
): Promise<void> {
  await api(`/proxies/${PROXY}/toxics`, "POST", {
    name,
    type,
    stream: "downstream",
    toxicity,
    attributes: attrs,
  });
}

async function clearToxics(): Promise<void> {
  const res = await fetch(`${TOXI}/proxies/${PROXY}/toxics`);
  const toxics = (await res.json()) as { name: string }[];
  await Promise.all(
    toxics.map((t) => api(`/proxies/${PROXY}/toxics/${t.name}`, "DELETE")),
  );
}

const canon = (doc: Doc): string =>
  JSON.stringify(
    doc.shapes().map((s) => ({
      ...s,
      props: Object.fromEntries(Object.entries(s.props).sort()),
    })),
  );

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main(): Promise<void> {
  const srv: RunningServer = await startServer({
    port: 8080,
    metaStore: new MemoryMetaStore(),
    store: new MemoryOpStore(),
  });
  const suffix = Date.now();
  const reg = async (
    email: string,
  ): Promise<{ userId: string; token: string }> => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    return (await res.json()) as { userId: string; token: string };
  };
  const owner = await reg(`chaos-owner-${suffix}@test.local`);
  const breg = await fetch(`http://127.0.0.1:${srv.port}/boards`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${owner.token}`,
    },
    body: "{}",
  });
  const { boardId } = (await breg.json()) as { boardId: string };

  const accounts = [owner];
  for (let i = 1; i < CLIENTS; i++) {
    const email = `chaos-e${i}-${suffix}@test.local`;
    accounts.push(await reg(email));
    await fetch(`http://127.0.0.1:${srv.port}/boards/${boardId}/members`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ email, role: "editor" }),
    });
  }

  const clients: SyncClient[] = [];
  const docs: Doc[] = [];
  for (let i = 0; i < CLIENTS; i++) {
    const acc = accounts[i]!;
    const doc = new Doc(acc.userId);
    const client = new SyncClient({
      doc,
      boardId,
      token: acc.token,
      userId: acc.userId,
      name: `c${i}`,
      color: "#3355ff",
      // every client goes through the proxy: this is the link we will break
      url: `ws://127.0.0.1:${PROXY_PORT}/ws`,
      socketFactory: (u) => new WebSocket(u) as unknown as WebSocket,
    });
    docs.push(doc);
    clients.push(client);
  }
  for (const c of clients) await c.start();
  await waitFor(
    () => clients.every((c) => c.status === "open"),
    10_000,
    "clients open through proxy",
  );

  await clients[0]!.edit([
    { t: "putObject", objId: "board:base", type: "rect" },
    { t: "zInsert", objId: "board:base", parent: null },
  ]);
  await waitFor(
    () => docs.every((d) => d.shapes().length === 1),
    5000,
    "base shape visible to all",
  );

  const phases: Phase[] = [];
  async function runPhase(
    name: string,
    detail: string,
    work: () => Promise<void>,
  ): Promise<void> {
    await work();
    await clearToxics();
    // heal, then let every client reconnect and resync from its state vector
    await waitFor(
      () => clients.every((c) => c.status === "open"),
      30_000,
      `${name}: reconnect`,
    );
    await waitFor(
      () => docs.every((d) => canon(d) === canon(docs[0]!)),
      30_000,
      `${name}: convergence`,
    );
    phases.push({
      name,
      detail,
      converged: docs.every((d) => canon(d) === canon(docs[0]!)),
      lostOps: docs[0]!.opList.filter(
        (op) =>
          !docs
            .slice(1)
            .every((d) =>
              d.opList.some((o) => o.actor === op.actor && o.seq === op.seq),
            ),
      ).length,
    });
    console.log(
      `${name}: converged=${phases[phases.length - 1]!.converged} lostOps=${phases[phases.length - 1]!.lostOps}`,
    );
  }

  // 1. healthy baseline
  // edits are issued concurrently: under injected latency a serial loop would
  // spend most of its time waiting on itself, not measuring the network
  async function burst(prefix: string, rounds: number): Promise<void> {
    await Promise.all(
      clients.flatMap((c, i) =>
        Array.from({ length: rounds }, (_, r) =>
          c.edit([
            {
              t: "putProp",
              objId: "board:base",
              key: `${prefix}${r}`,
              value: { kind: "int", v: i },
            },
          ]),
        ),
      ),
    );
  }

  await runPhase("healthy", "no toxics", async () => {
    await burst("h", 5);
    await waitFor(
      () => docs.every((d) => d.opList.length === docs[0]!.opList.length),
      5000,
      "healthy fanout",
    );
  });

  // 2. latency
  await runPhase("latency", "200ms added latency both directions", async () => {
    await addToxic("lat", "latency", { latency: 200, jitter: 50 });
    await burst("l", EDITS_PER_CLIENT);
  });

  // 3. bandwidth squeeze
  await runPhase("bandwidth", "10 kbit/s downstream", async () => {
    await addToxic("bw", "bandwidth", { rate: 10 });
    await burst("b", 5);
  });

  // 4. hard partition mid-edit
  await runPhase(
    "partition",
    "connection cut while clients keep editing",
    async () => {
      // stop passing bytes in both directions without deleting the proxy
      await addToxic("cut-down", "timeout", { timeout: 0 });
      await addToxic("cut-up", "timeout", { timeout: 0 });
      // these edits must survive the partition and land after healing
      await burst("p", EDITS_PER_CLIENT);
    },
  );

  const ok = phases.every((p) => p.converged && p.lostOps === 0);
  const result = {
    date: new Date().toISOString(),
    scenario: `${CLIENTS} clients via toxiproxy, ${EDITS_PER_CLIENT} edits during degraded phases`,
    phases,
    allConverged: ok,
  };
  fs.mkdirSync(new URL("../../../results", import.meta.url), {
    recursive: true,
  });
  fs.writeFileSync(
    new URL("../../../results/chaos.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log("wrote results/chaos.json");

  for (const c of clients) c.close();
  await srv.close();
  if (!ok) {
    console.error("chaos run reported divergence or lost ops");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
