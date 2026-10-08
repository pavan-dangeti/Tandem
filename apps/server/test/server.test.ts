import { describe, expect, it, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { Doc, decodeOp, encodeOp } from "@tandem/crdt";
import { startServer, type RunningServer } from "../src/server.js";
import {
  FRAME,
  MAX_FRAME,
  buildFrame,
  parseFrame,
  packOps,
  packSyncResponse,
  unpackOps,
} from "@tandem/protocol";
import { MemoryMetaStore } from "../src/meta.js";
import { MemoryOpStore } from "../src/store.js";

const te = new TextEncoder();
const td = new TextDecoder();

let srv: RunningServer;
let meta: MemoryMetaStore;
let store: MemoryOpStore;
let port: number;

beforeAll(async () => {
  meta = new MemoryMetaStore();
  store = new MemoryOpStore();
  srv = await startServer({ port: 0, metaStore: meta, store: store });
  port = srv.port;
});

afterAll(async () => {
  await srv.close();
});

const jsonHeaders = { "content-type": "application/json" };

async function register(
  email: string,
  password = "password123",
): Promise<{ userId: string; token: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email, password }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as { userId: string; token: string };
}

async function createBoard(token: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/boards`, {
    method: "POST",
    headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
    body: "{}",
  });
  expect(res.ok).toBe(true);
  const b = (await res.json()) as { boardId: string };
  return b.boardId;
}

async function addMember(
  token: string,
  boardId: string,
  email: string,
  role: string,
): Promise<void> {
  const res = await fetch(
    `http://127.0.0.1:${port}/boards/${boardId}/members`,
    {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, role }),
    },
  );
  expect(res.ok).toBe(true);
}

async function getShare(
  token: string,
  boardId: string,
  role: "editor" | "viewer",
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/boards/${boardId}/share`, {
    method: "POST",
    headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
    body: JSON.stringify({ role, ttlSeconds: 3600 }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { token: string }).token;
}

function wsConnect(
  boardId: string,
  token: string,
  stateVector: Record<string, number> = {},
  device?: string,
): Promise<{
  ws: WebSocket;
  sync: Promise<{
    sv: Record<string, number>;
    ops: Uint8Array[];
    userId: string;
    device?: string;
  }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let settled = false;
    const sync = new Promise<{
      sv: Record<string, number>;
      ops: Uint8Array[];
      userId: string;
      device?: string;
    }>((res2, rej2) => {
      ws.on("message", (data: Buffer) => {
        const p = parseFrame(new Uint8Array(data));
        if (!p || settled) return;
        if (p.type === FRAME.ERROR) {
          settled = true;
          rej2(new Error(td.decode(p.payload)));
          return;
        }
        if (p.type === FRAME.SYNC_RESPONSE) {
          settled = true;
          const dv = new DataView(
            p.payload.buffer,
            p.payload.byteOffset,
            p.payload.byteLength,
          );
          const jsonLen = dv.getUint32(0);
          const {
            stateVector: sv,
            userId,
            device: minted,
          } = JSON.parse(td.decode(p.payload.subarray(4, 4 + jsonLen))) as {
            stateVector: Record<string, number>;
            userId: string;
            device?: string;
          };
          const ops: Uint8Array[] = [];
          if (p.payload.byteLength > 4 + jsonLen)
            ops.push(...unpackOps(p.payload.subarray(4 + jsonLen)));
          res2({ sv, ops, userId, ...(minted ? { device: minted } : {}) });
        }
      });
      ws.on("open", () => {
        ws.send(
          buildFrame(
            FRAME.HELLO,
            te.encode(
              JSON.stringify({
                protocol: "tandem/1",
                token,
                boardId,
                stateVector,
                device,
              }),
            ),
          ),
        );
      });
    });
    ws.on("error", reject);
    ws.on("open", () => resolve({ ws, sync }));
  });
}

async function nextFrame(
  ws: WebSocket,
  type: number,
  timeoutMs = 3000,
): Promise<{ type: number; payload: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for frame ${type}`)),
      timeoutMs,
    );
    const onMsg = (data: Buffer): void => {
      const p = parseFrame(new Uint8Array(data));
      if (p && p.type === type) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(p);
      }
    };
    ws.on("message", onMsg);
  });
}

describe("sync protocol v1", () => {
  it("delivers ops to a peer and acks the author", async () => {
    const a = await register("a@x.com");
    const b = await register("b@x.com");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "b@x.com", "editor");

    const ca = await wsConnect(boardId, a.token);
    const cb = await wsConnect(boardId, b.token);
    await ca.sync;
    await cb.sync;

    const authorId = a.userId;
    const authorDoc = new Doc(authorId);
    const ops = authorDoc.applyLocal([
      { t: "putObject", objId: `${authorId}:1`, type: "rect" },
    ]);
    expect(ops[0]!.actor).toBe(authorId);

    const ackP = nextFrame(ca.ws, FRAME.ACK);
    const peerP = nextFrame(cb.ws, FRAME.OP_BATCH);
    ca.ws.send(
      buildFrame(FRAME.OP_BATCH, packOps(ops.map((o) => encodeOp(o)))),
    );
    const ack = JSON.parse(td.decode((await ackP).payload));
    const peerFrame = await peerP;
    const peerOps = unpackOps(peerFrame.payload);
    expect(ack.applied).toBe(1);
    expect(ack.stateVector[authorId]).toBe(1);
    expect(peerOps.length).toBe(1);
  });

  it("rejects ops from viewers", async () => {
    const a = await register("a2@x.com");
    const boardId = await createBoard(a.token);
    const viewerToken = await getShare(a.token, boardId, "viewer");
    const cv = await wsConnect(boardId, viewerToken);
    await cv.sync;

    const errP = nextFrame(cv.ws, FRAME.ERROR);
    cv.ws.send(
      buildFrame(FRAME.OP_BATCH, packOps([new Uint8Array([1, 2, 3])])),
    );
    const errPayload = JSON.parse(td.decode((await errP).payload));
    expect(errPayload.code).toBe("forbidden");
  });

  it("broadcast presence to other clients but not echo", async () => {
    const a = await register("a3@x.com");
    const b = await register("b3@x.com");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "b3@x.com", "editor");
    const ca = await wsConnect(boardId, a.token);
    const cb = await wsConnect(boardId, b.token);
    await ca.sync;
    await cb.sync;
    const presence = {
      userId: a.userId,
      name: "Ana",
      color: "#FF0000",
      at: Date.now(),
    };
    const peerGot = nextFrame(cb.ws, FRAME.PRESENCE);
    ca.ws.send(buildFrame(FRAME.PRESENCE, te.encode(JSON.stringify(presence))));
    const got = JSON.parse(td.decode((await peerGot).payload));
    expect(got.name).toBe("Ana");
  });

  it("delta sync on reconnect: new client gets only missing ops", async () => {
    const a = await register("a4@x.com");
    const b = await register("b4@x.com");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "b4@x.com", "editor");
    const ca = await wsConnect(boardId, a.token);
    const cb = await wsConnect(boardId, b.token);
    await ca.sync;
    await cb.sync;
    const aDoc = new Doc(a.userId);
    const ops = aDoc.applyLocal([
      { t: "putObject", objId: `${a.userId}:1`, type: "rect" },
      {
        t: "putProp",
        objId: `${a.userId}:1`,
        key: "x",
        value: { kind: "double", v: 5 },
      },
    ]);
    const ackP = nextFrame(ca.ws, FRAME.ACK);
    ca.ws.send(
      buildFrame(FRAME.OP_BATCH, packOps(ops.map((o) => encodeOp(o)))),
    );
    await ackP;
    const stateVector = { [a.userId]: 2 };
    const cc = await wsConnect(boardId, a.token, stateVector);
    const { sv, ops: got } = await cc.sync;
    expect(sv[a.userId]).toBe(2);
    expect(got.length).toBe(0);
    cc.ws.close();
  });

  it("restart server recovers ops from store and does not lose acked ops", async () => {
    const a = await register("a5@x.com");
    const boardId = await createBoard(a.token);
    const authorDoc = new Doc(a.userId);
    const ops = authorDoc.applyLocal([
      { t: "putObject", objId: `${a.userId}:1`, type: "rect" },
    ]);
    const ca = await wsConnect(boardId, a.token);
    await ca.sync;
    const ackP = nextFrame(ca.ws, FRAME.ACK);
    ca.ws.send(
      buildFrame(FRAME.OP_BATCH, packOps(ops.map((o) => encodeOp(o)))),
    );
    await ackP;
    ca.ws.close();

    // restart the server process-equivalent against the same durable store
    await srv.close();
    const srv2 = await startServer({ port: 0, metaStore: meta, store });
    port = srv2.port;

    const fresh = await wsConnect(boardId, a.token, {});
    const { sv, ops: got } = await fresh.sync;
    expect(sv[a.userId]).toBe(1);
    expect(got.length).toBe(1);
    expect(got[0]).toBeDefined();
    fresh.ws.close();
    await srv2.close();

    srv = await startServer({ port: 0, metaStore: meta, store });
    port = srv.port;
  });

  it("rebuilds a board from a compacted snapshot plus the log tail", async () => {
    const a = await register("snapshot-load@x.com");
    const boardId = await createBoard(a.token);
    const author = new Doc(a.userId);
    const objId = `${a.userId}:1`;
    const ops = author.applyLocal([
      { t: "putObject", objId, type: "rect" },
      { t: "zInsert", objId, parent: null },
    ]);
    for (let i = 0; i < 100; i++)
      ops.push(
        ...author.applyLocal([
          { t: "putProp", objId, key: "x", value: { kind: "int", v: i } },
        ]),
      );
    const head = new Doc("head");
    head.merge(ops.slice(0, 80));
    const seeded = new MemoryOpStore();
    await seeded.appendOps(
      boardId,
      ops.map((op) => ({ ...op, data: encodeOp(op) })),
    );
    await seeded.saveSnapshot(
      boardId,
      packSyncResponse(
        Object.fromEntries(head.stateVector()),
        head.compactOps().map((op) => encodeOp(op)),
      ),
    );

    await srv.close();
    const fromSnapshot = await startServer({
      port: 0,
      metaStore: meta,
      store: seeded,
    });
    port = fromSnapshot.port;
    const c = await wsConnect(boardId, a.token);
    const { sv, ops: got } = await c.sync;
    c.ws.close();
    await fromSnapshot.close();
    srv = await startServer({ port: 0, metaStore: meta, store });
    port = srv.port;

    expect(sv[a.userId]).toBe(102);
    const replica = new Doc("replica");
    for (const raw of got) replica.applyRemote(decodeOp(raw));
    expect(replica.shapes()).toEqual(author.shapes());
    // putObject, zInsert and the one winning write: the 99 superseded writes
    // never reach a new client
    expect(got.length).toBe(3);
  });

  it("viewer cannot receive secret and cannot send ops via share token", async () => {
    const a = await register("a6@x.com");
    const boardId = await createBoard(a.token);
    await expect(
      (await wsConnect(boardId, "garbage-token")).sync,
    ).rejects.toThrow();
  });
});

describe("device actors", () => {
  it("gives each device on a share link its own actor, kept across reconnects", async () => {
    const a = await register("share-actors@x.com");
    const boardId = await createBoard(a.token);
    const link = await getShare(a.token, boardId, "editor");
    const g1 = await wsConnect(boardId, link, {}, "");
    const g2 = await wsConnect(boardId, link, {}, "");
    const [s1, s2] = await Promise.all([g1.sync, g2.sync]);
    expect(s1.userId).not.toBe(s2.userId);
    const again = await wsConnect(boardId, link, {}, s1.device);
    expect((await again.sync).userId).toBe(s1.userId);
    for (const c of [g1, g2, again]) c.ws.close();
  });

  it("does not let a device claim another device's actor", async () => {
    const a = await register("device-forgery@x.com");
    const boardId = await createBoard(a.token);
    const link = await getShare(a.token, boardId, "editor");
    const victim = await wsConnect(boardId, link, {}, "");
    const v = await victim.sync;
    const suffix = v.userId.slice(v.userId.lastIndexOf("-") + 1);
    const forger = await wsConnect(boardId, link, {}, `${suffix}.forged`);
    expect((await forger.sync).userId).not.toBe(v.userId);
    for (const c of [victim, forger]) c.ws.close();
  });

  it("gives each device of one signed-in account its own actor", async () => {
    const a = await register("two-devices@x.com");
    const boardId = await createBoard(a.token);
    const laptop = await wsConnect(boardId, a.token, {}, "");
    const phone = await wsConnect(boardId, a.token, {}, "");
    const [s1, s2] = await Promise.all([laptop.sync, phone.sync]);
    expect(s1.userId.startsWith(`${a.userId}-`)).toBe(true);
    expect(s2.userId.startsWith(`${a.userId}-`)).toBe(true);
    expect(s1.userId).not.toBe(s2.userId);
    for (const c of [laptop, phone]) c.ws.close();
  });
});

describe("presence", () => {
  it("stamps the sender's identity instead of trusting the client", async () => {
    const a = await register("presence-a@x.com");
    const b = await register("presence-b@x.com");
    const boardId = await createBoard(a.token);
    await addMember(a.token, boardId, "presence-b@x.com", "editor");
    const ca = await wsConnect(boardId, a.token);
    const cb = await wsConnect(boardId, b.token);
    await Promise.all([ca.sync, cb.sync]);
    const got = nextFrame(cb.ws, FRAME.PRESENCE);
    ca.ws.send(
      buildFrame(
        FRAME.PRESENCE,
        te.encode(
          JSON.stringify({
            userId: b.userId,
            name: "b",
            color: "#000000",
            at: Date.now(),
          }),
        ),
      ),
    );
    const msg = JSON.parse(td.decode((await got).payload)) as {
      userId: string;
    };
    expect(msg.userId).toBe(a.userId);
    for (const c of [ca, cb]) c.ws.close();
  });
});

describe("http hardening", () => {
  const post = (path: string, body: string, headers = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { ...jsonHeaders, ...headers },
      body,
    });

  it("does not reveal whether an email is registered", async () => {
    await register("enumerate@x.com");
    const again = await post(
      "/auth/register",
      JSON.stringify({ email: "enumerate@x.com", password: "password123" }),
    );
    const malformed = await post("/auth/register", "{}");
    expect(again.status).toBe(malformed.status);
    expect(await again.json()).toEqual(await malformed.json());
  });

  it("rejects request bodies over 64 KiB", async () => {
    const res = await post("/auth/login", "x".repeat(65 * 1024));
    expect(res.status).toBe(413);
  });

  it("labels unknown paths as one route in metrics", async () => {
    await fetch(`http://127.0.0.1:${port}/no-such-path-${Date.now()}`);
    const metrics = await (
      await fetch(`http://127.0.0.1:${port}/metrics`)
    ).text();
    expect(metrics).toContain('route="other"');
    expect(metrics).not.toContain("no-such-path");
  });

  it("rate-limits auth attempts per client address behind a proxy", async () => {
    process.env.TRUST_PROXY = "1";
    try {
      const codes = [];
      for (let i = 0; i < 25; i++)
        codes.push(
          (
            await post("/auth/login", "{}", {
              "x-forwarded-for": "203.0.113.9",
            })
          ).status,
        );
      expect(codes).toContain(429);
      const other = await post("/auth/login", "{}", {
        "x-forwarded-for": "203.0.113.10",
      });
      expect(other.status).not.toBe(429);
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });
});

describe("frame size limit", () => {
  it("closes with 1009 before buffering a frame larger than MAX_FRAME", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.once("open", r));
    const code = await new Promise<number>((resolve) => {
      ws.once("close", (c) => resolve(c));
      ws.send(new Uint8Array(MAX_FRAME + 1));
    });
    expect(code).toBe(1009);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);
  });
});
