import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Doc } from "@tandem/crdt";
import { startServer, type RunningServer } from "../../server/src/server.js";
import { MemoryMetaStore } from "../../server/src/meta.js";
import { MemoryOpStore } from "../../server/src/store.js";
import { SyncClient } from "../src/lib/sync.js";
import type { OpSpec } from "@tandem/crdt";

let srv: RunningServer;
let meta: MemoryMetaStore;
let port: number;

beforeAll(async () => {
  meta = new MemoryMetaStore();
  srv = await startServer({
    port: 0,
    metaStore: meta,
    store: new MemoryOpStore(),
  });
  port = srv.port;
});

afterAll(async () => {
  await srv.close();
});

interface Account {
  userId: string;
  token: string;
}

async function register(email: string): Promise<Account> {
  const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await res.json()) as Account;
}

async function createBoard(token: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/boards`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  return ((await res.json()) as { boardId: string }).boardId;
}

async function addMember(
  token: string,
  boardId: string,
  email: string,
): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/boards/${boardId}/members`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ email, role: "editor" }),
  });
}

function nodeSocketFactory(url: string): globalThis.WebSocket {
  return new WebSocket(url) as unknown as globalThis.WebSocket;
}

function makeClient(
  acc: Account,
  boardId: string,
  name: string,
): { client: SyncClient; doc: Doc } {
  const doc = new Doc(acc.userId);
  const client = new SyncClient({
    doc,
    boardId,
    token: acc.token,
    userId: acc.userId,
    name,
    color: "#3355ff",
    url: `ws://127.0.0.1:${port}/ws`,
    socketFactory: nodeSocketFactory,
  });
  return { client, doc };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function shareToken(token: string, boardId: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/boards/${boardId}/share`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ role: "editor", ttlSeconds: 600 }),
  });
  return ((await res.json()) as { token: string }).token;
}

/** A guest joining by share link: the server, not the client, names it. */
function makeGuest(
  boardId: string,
  token: string,
): {
  client: SyncClient;
  doc: Doc;
} {
  const doc = new Doc(`pending-${Math.random().toString(36).slice(2)}`);
  const client = new SyncClient({
    doc,
    boardId,
    token,
    // deliberately not the id the server will assign
    userId: "pending",
    name: "Guest",
    color: "#3355ff",
    url: `ws://127.0.0.1:${port}/ws`,
    socketFactory: nodeSocketFactory,
  });
  return { client, doc };
}

describe("SyncClient", () => {
  it("syncs local edits to a peer", async () => {
    const a = await register("sc-a@test.local");
    const b = await register("sc-b@test.local");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "sc-b@test.local");

    const ca = makeClient(a, boardId, "Ana");
    const cb = makeClient(b, boardId, "Ben");
    await ca.client.start();
    await cb.client.start();
    await waitFor(
      () => ca.client.status === "open" && cb.client.status === "open",
    );

    await ca.client.edit([
      { t: "putObject", objId: `${a.userId}:1`, type: "rect" },
    ]);
    await ca.client.edit([
      { t: "zInsert", objId: `${a.userId}:1`, parent: null },
    ]);
    await waitFor(() => cb.doc.shapes().length === 1);
    expect(cb.doc.shapes()[0]!.id).toBe(`${a.userId}:1`);

    ca.client.close();
    cb.client.close();
  });

  it("serves a late joiner the full board", async () => {
    const a = await register("sc-late-a@test.local");
    const b = await register("sc-late-b@test.local");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "sc-late-b@test.local");

    const ca = makeClient(a, boardId, "Ana");
    await ca.client.start();
    await waitFor(() => ca.client.status === "open");
    await ca.client.edit([
      { t: "putObject", objId: `${a.userId}:1`, type: "rect" },
      { t: "zInsert", objId: `${a.userId}:1`, parent: null },
    ]);
    await ca.client.edit([
      {
        t: "putProp",
        objId: `${a.userId}:1`,
        key: "w",
        value: { kind: "double", v: 120 },
      },
    ]);

    const cb = makeClient(b, boardId, "Ben");
    await cb.client.start();
    await waitFor(() => cb.doc.shapes().length === 1);
    expect(cb.doc.shapes()[0]!.props["w"]).toEqual({ kind: "double", v: 120 });

    ca.client.close();
    cb.client.close();
  });

  it("queues edits made while offline and flushes them on reconnect", async () => {
    const a = await register("sc-off@test.local");
    const boardId = await createBoard(a.token);

    const { client, doc } = makeClient(a, boardId, "Ana");
    await client.start();
    await waitFor(() => client.status === "open");

    // simulate going offline: drop the socket without closing the client
    (client as unknown as { ws: WebSocket | null }).ws?.close();
    await waitFor(() => client.status === "offline");

    await client.edit([
      { t: "putObject", objId: `${a.userId}:7`, type: "ellipse" },
      { t: "zInsert", objId: `${a.userId}:7`, parent: null },
    ]);
    expect(doc.shapes().length).toBe(1);
    expect(client.hasUnsentOps).toBe(true);

    await waitFor(() => client.status === "open", 5000);
    await waitFor(() => client.hasUnsentOps === false, 5000);

    // a fresh client proves the server persisted them
    const { client: checker, doc: checkerDoc } = makeClient(a, boardId, "Ana2");
    await checker.start();
    await waitFor(() => checker.status === "open");
    await waitFor(() => checkerDoc.shapes().length === 1);
    expect(checkerDoc.shapes()[0]!.id).toBe(`${a.userId}:7`);

    client.close();
    checker.close();
  });

  it("propagates presence between peers but never to the sender", async () => {
    const a = await register("sc-pa@test.local");
    const b = await register("sc-pb@test.local");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "sc-pb@test.local");

    const ca = makeClient(a, boardId, "Ana");
    const cb = makeClient(b, boardId, "Ben");
    await ca.client.start();
    await cb.client.start();
    await waitFor(
      () => ca.client.status === "open" && cb.client.status === "open",
    );

    ca.client.presence({ x: 10, y: 20 }, [`${a.userId}:1`]);
    await waitFor(() => cb.client.presences.has(a.userId));
    const seen = cb.client.presences.get(a.userId)!;
    expect(seen.cursor).toEqual({ x: 10, y: 20 });
    expect(ca.client.presences.has(a.userId)).toBe(false);

    ca.client.close();
    cb.client.close();
  });

  it("undo is per-user and only reverts that user's edits", async () => {
    const a = await register("sc-ua@test.local");
    const b = await register("sc-ub@test.local");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "sc-ub@test.local");

    const ca = makeClient(a, boardId, "Ana");
    const cb = makeClient(b, boardId, "Ben");
    await ca.client.start();
    await cb.client.start();
    await waitFor(
      () => ca.client.status === "open" && cb.client.status === "open",
    );

    await ca.client.edit([
      { t: "putObject", objId: `${a.userId}:1`, type: "rect" },
      { t: "zInsert", objId: `${a.userId}:1`, parent: null },
    ]);
    await cb.client.edit([
      { t: "putObject", objId: `${b.userId}:1`, type: "ellipse" },
      { t: "zInsert", objId: `${b.userId}:1`, parent: null },
    ]);
    await waitFor(
      () => ca.doc.shapes().length === 2 && cb.doc.shapes().length === 2,
    );

    await ca.client.undo();
    await waitFor(() => cb.doc.shapes().length === 1);
    expect(cb.doc.shapes()[0]!.id).toBe(`${b.userId}:1`);

    await ca.client.redo();
    await waitFor(() => cb.doc.shapes().length === 2);

    ca.client.close();
    cb.client.close();
  });

  it("gives share-link guests the actor id the server assigned and syncs their edits", async () => {
    const owner = await register("sc-guest-owner@test.local");
    const boardId = await createBoard(owner.token);
    const ana = makeGuest(boardId, await shareToken(owner.token, boardId));
    const ben = makeGuest(boardId, await shareToken(owner.token, boardId));

    await ana.client.start();
    await ben.client.start();
    await waitFor(
      () => ana.client.status === "open" && ben.client.status === "open",
    );

    // each guest must act as the id the server handed it, not its placeholder
    expect(ana.client.userId).toMatch(/^guest-editor-/);
    expect(ben.client.userId).toMatch(/^guest-editor-/);
    expect(ana.client.userId).not.toBe(ben.client.userId);

    const anaRect = (n: string): OpSpec[] => [
      { t: "putObject", objId: n, type: "rect" },
      { t: "zInsert", objId: n, parent: null },
    ];
    await ana.client.edit(anaRect("ana-1"));
    await ben.client.edit(anaRect("ben-1"));
    await waitFor(
      () => ana.doc.shapes().length === 2 && ben.doc.shapes().length === 2,
    );

    // Ana loses the network, keeps editing, then comes back
    (ana.client as unknown as { ws: WebSocket | null }).ws?.close();
    await waitFor(() => ana.client.status === "offline");
    await ana.client.edit(anaRect("ana-2"));
    await ben.client.edit(anaRect("ben-2"));
    await waitFor(() => ben.doc.shapes().length === 3);

    await waitFor(() => ana.client.status === "open", 5000);
    await waitFor(() => ana.client.hasUnsentOps === false, 5000);
    await waitFor(() => ana.doc.shapes().length === 4, 5000);

    const canon = (d: Doc): string =>
      JSON.stringify(
        d
          .shapes()
          .map((s) => s.id)
          .sort(),
      );
    expect(canon(ana.doc)).toBe(canon(ben.doc));

    ana.client.close();
    ben.client.close();
  });

  it("text edits merge across peers", async () => {
    const a = await register("sc-ta@test.local");
    const b = await register("sc-tb@test.local");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "sc-tb@test.local");

    const ca = makeClient(a, boardId, "Ana");
    const cb = makeClient(b, boardId, "Ben");
    await ca.client.start();
    await cb.client.start();
    await waitFor(
      () => ca.client.status === "open" && cb.client.status === "open",
    );

    const objId = `${a.userId}:1`;
    await ca.client.edit([
      { t: "putObject", objId, type: "text" },
      { t: "zInsert", objId, parent: null },
    ]);
    await waitFor(
      () => cb.doc.text(objId) !== undefined && cb.doc.shapes().length === 1,
    );

    await ca.client.edit([
      {
        t: "textInsert",
        objId,
        id: { actor: a.userId, counter: 500 },
        parent: null,
        ch: "h",
      },
    ]);
    await ca.client.edit([
      {
        t: "textInsert",
        objId,
        id: { actor: a.userId, counter: 501 },
        parent: { actor: a.userId, counter: 500 },
        ch: "i",
      },
    ]);
    await waitFor(() => cb.doc.text(objId) === "hi");
    expect(ca.doc.text(objId)).toBe("hi");

    ca.client.close();
    cb.client.close();
  });
});
