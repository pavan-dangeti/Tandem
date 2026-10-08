import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Doc } from "@tandem/crdt";
import { startServer, type RunningServer } from "../src/server.js";
import { MemoryMetaStore } from "../src/meta.js";
import { MemoryOpStore } from "../src/store.js";
import { RedisBus } from "../src/bus.js";
import { SyncClient } from "../../web/src/lib/sync.js";

const REDIS_URL = process.env.TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)("multi-node fan-out over redis", () => {
  // Two server nodes that share nothing but Redis: separate op stores, separate
  // board caches, separate rooms. A client on each node must see the other's edits.
  let nodeA: RunningServer;
  let nodeB: RunningServer;
  let meta: MemoryMetaStore;

  beforeAll(async () => {
    meta = new MemoryMetaStore();
    const busA = new RedisBus(REDIS_URL!);
    const busB = new RedisBus(REDIS_URL!);
    await busA.connect();
    await busB.connect();
    nodeA = await startServer({
      port: 0,
      metaStore: meta,
      store: new MemoryOpStore(),
      bus: busA,
    });
    nodeB = await startServer({
      port: 0,
      metaStore: meta,
      store: new MemoryOpStore(),
      bus: busB,
    });
  });

  afterAll(async () => {
    await nodeA.close();
    await nodeB.close();
  });

  async function register(
    email: string,
  ): Promise<{ userId: string; token: string }> {
    const res = await fetch(`http://127.0.0.1:${nodeA.port}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    return (await res.json()) as { userId: string; token: string };
  }

  function clientFor(
    port: number,
    acc: { userId: string; token: string },
    boardId: string,
    name: string,
  ): SyncClient {
    return new SyncClient({
      doc: new Doc(acc.userId),
      boardId,
      token: acc.token,
      userId: acc.userId,
      name,
      color: "#3355ff",
      url: `ws://127.0.0.1:${port}/ws`,
      socketFactory: (u) => new WebSocket(u) as unknown as globalThis.WebSocket,
    });
  }

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5000,
  ): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("propagates an edit made on node A to a client connected to node B", async () => {
    const owner = await register(`fan-a-${Date.now()}@test.local`);

    const res = await fetch(`http://127.0.0.1:${nodeA.port}/boards`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.token}`,
      },
      body: "{}",
    });
    const { boardId } = (await res.json()) as { boardId: string };

    const clientA = clientFor(nodeA.port, owner, boardId, "Ana");
    await clientA.start();
    await waitFor(() => clientA.status === "open");
    await clientA.edit([
      { t: "putObject", objId: `${owner.userId}:1`, type: "rect" },
      { t: "zInsert", objId: `${owner.userId}:1`, parent: null },
    ]);

    // A brand-new client on the *other* node must receive it through the bus.
    const clientB = clientFor(nodeB.port, owner, boardId, "Ana2");
    await clientB.start();
    await waitFor(() => clientB.doc.shapes().length === 1);
    expect(clientB.doc.shapes()[0]!.id).toBe(`${owner.userId}:1`);

    clientA.close();
    clientB.close();
  });

  it("keeps both nodes converging when two accounts edit the same board", async () => {
    // One account == one CRDT actor (the sequence numbers belong to it), so
    // real concurrency comes from two accounts, not two tabs of one account.
    const suffix = Date.now();
    const ownerEmail = `conc-a-${suffix}@test.local`;
    const editorEmail = `conc-b-${suffix}@test.local`;
    const owner = await register(ownerEmail);
    const editor = await register(editorEmail);
    const res = await fetch(`http://127.0.0.1:${nodeA.port}/boards`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.token}`,
      },
      body: "{}",
    });
    const { boardId } = (await res.json()) as { boardId: string };
    const addRes = await fetch(
      `http://127.0.0.1:${nodeA.port}/boards/${boardId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({ email: editorEmail, role: "editor" }),
      },
    );
    expect(addRes.ok).toBe(true);

    const clientA = clientFor(nodeA.port, owner, boardId, "Ana");
    await clientA.start();
    await waitFor(() => clientA.status === "open");
    await clientA.edit([
      { t: "putObject", objId: `${owner.userId}:1`, type: "rect" },
      { t: "zInsert", objId: `${owner.userId}:1`, parent: null },
    ]);

    const clientB = clientFor(nodeB.port, editor, boardId, "Ben");
    await clientB.start();
    await waitFor(() => clientB.status === "open");
    await waitFor(() => clientB.doc.shapes().length === 1);

    await clientA.edit([
      {
        t: "putProp",
        objId: `${owner.userId}:1`,
        key: "w",
        value: { kind: "double", v: 10 },
      },
    ]);
    await clientB.edit([
      {
        t: "putProp",
        objId: `${owner.userId}:1`,
        key: "h",
        value: { kind: "double", v: 20 },
      },
    ]);

    await waitFor(() => {
      const a = clientA.doc.shapes()[0]?.props;
      const b = clientB.doc.shapes()[0]?.props;
      return (
        a?.["w"] !== undefined &&
        a?.["h"] !== undefined &&
        b?.["w"] !== undefined &&
        b?.["h"] !== undefined
      );
    });

    // compare content, not JS key order (props are a Map; order is not part of the state)
    const canon = (c: SyncClient): string =>
      JSON.stringify(
        c.doc.shapes().map((s) => ({
          ...s,
          props: Object.fromEntries(Object.entries(s.props).sort()),
        })),
      );
    expect(canon(clientA)).toBe(canon(clientB));
    clientA.close();
    clientB.close();
  });
});

describe("anti-entropy", () => {
  it("delivers ops whose fan-out message was lost, from the shared op log", async () => {
    // Each node gets its own in-process bus, so no publish ever reaches the
    // other node: exactly what a dropped Redis message looks like.
    const meta = new MemoryMetaStore();
    const store = new MemoryOpStore();
    const nodeA = await startServer({ port: 0, metaStore: meta, store });
    const nodeB = await startServer({
      port: 0,
      metaStore: meta,
      store,
      reconcileMs: 100,
    });
    const post = async (path: string, body: unknown, token?: string) =>
      (await (
        await fetch(`http://127.0.0.1:${nodeA.port}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, string>;
    const owner = await post("/auth/register", {
      email: "anti-entropy@test.local",
      password: "password123",
    });
    const { boardId } = await post("/boards", {}, owner.token);
    const client = (port: number, device: string): SyncClient =>
      new SyncClient({
        doc: new Doc(owner.userId!),
        boardId: boardId!,
        token: owner.token!,
        userId: owner.userId!,
        deviceId: device,
        name: device,
        color: "#3355ff",
        url: `ws://127.0.0.1:${port}/ws`,
        socketFactory: (u) =>
          new WebSocket(u) as unknown as globalThis.WebSocket,
      });
    const onB = client(nodeB.port, "b");
    await onB.start();
    const onA = client(nodeA.port, "a");
    await onA.start();
    const deadline = Date.now() + 5000;
    while (onA.status !== "open" && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    await onA.edit([
      { t: "putObject", objId: "shape", type: "rect" },
      { t: "zInsert", objId: "shape", parent: null },
    ]);
    while (onB.doc.shapes().length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(onB.doc.shapes().map((s) => s.id)).toEqual(["shape"]);
    onA.close();
    onB.close();
    await nodeA.close();
    await nodeB.close();
  });
});
