import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";
import { PostgresMetaStore } from "../src/meta.js";
import { PostgresOpStore } from "../src/store.js";
import { Doc, decodeOp, encodeOp } from "@tandem/crdt";
import { FRAME, buildFrame, packOps } from "@tandem/protocol";
import WebSocket from "ws";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const te = new TextEncoder();
const td = new TextDecoder();

describe.skipIf(!DATABASE_URL)("postgres store", () => {
  let meta: PostgresMetaStore;
  let store: PostgresOpStore;
  let srv: RunningServer;
  let port: number;

  beforeAll(async () => {
    meta = new PostgresMetaStore(DATABASE_URL!);
    store = new PostgresOpStore(DATABASE_URL!);
    await meta.init();
    await store.init();
    srv = await startServer({ port: 0, metaStore: meta, store });
    port = srv.port;
  });

  afterAll(async () => {
    await srv.close();
    await meta.close();
    await store.close();
  });

  it("users, boards and memberships persist", async () => {
    const id = `u-${Date.now()}`;
    const boardId = `b-${Date.now()}`;
    const email = `pg-meta-${Date.now()}@test.local`;
    await meta.createUser(id, email, "hash");
    await meta.createBoard(boardId, id);
    await meta.addMember(boardId, id, "owner");
    expect((await meta.getUserByEmail(email))?.id).toBe(id);
    expect((await meta.getBoard(boardId))?.ownerId).toBe(id);
    expect(await meta.getMemberRole(boardId, id)).toBe("owner");
    expect(await meta.getMemberRole(boardId, "nobody")).toBeNull();
  });

  it("persists acked ops and reloads them into a new doc after restart", async () => {
    const email = `pg-${Date.now()}@test.local`;
    const reg = await fetch(`http://127.0.0.1:${port}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { userId, token } = (await reg.json()) as {
      userId: string;
      token: string;
    };
    const breg = await fetch(`http://127.0.0.1:${port}/boards`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    const { boardId } = (await breg.json()) as { boardId: string };

    const authorDoc = new Doc(userId);
    const ops = authorDoc.applyLocal([
      { t: "putObject", objId: `${userId}:1`, type: "rect" },
      { t: "zInsert", objId: `${userId}:1`, parent: null },
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res) => ws.on("open", () => res()));
    const acked = new Promise<void>((res) => {
      ws.on("message", (data: Buffer) => {
        if (data[0] === FRAME.ACK) res();
      });
    });
    ws.send(
      buildFrame(
        FRAME.HELLO,
        te.encode(
          JSON.stringify({
            protocol: "tandem/1",
            token,
            boardId,
            stateVector: {},
          }),
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    ws.send(buildFrame(FRAME.OP_BATCH, packOps(ops.map((o) => encodeOp(o)))));
    await acked;
    ws.close();

    // verify both ops survived in the durable log and reload into a fresh doc
    const rows = await store.loadOps(boardId);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.actor === userId)).toBe(true);
    const reloaded = new Doc("loader");
    for (const r of rows) reloaded.applyRemote(decodeOp(r.data));
    expect(reloaded.opList.length).toBe(2);
    expect(reloaded.shapes().map((s) => s.id)).toEqual([`${userId}:1`]);

    // duplicate append is idempotent (unique constraint)
    await store.appendOps(boardId, [
      {
        actor: userId,
        seq: 1,
        wall: ops[0]!.wall,
        logical: ops[0]!.logical,
        data: encodeOp(ops[0]!),
      },
    ]);
    expect((await store.loadOps(boardId)).length).toBe(2);
  });

  it("snapshot round-trips through postgres", async () => {
    const boardId = `snap-test-${Date.now()}`;
    const snap = te.encode("snapshot bytes");
    await store.saveSnapshot(boardId, snap);
    expect(td.decode((await store.loadSnapshot(boardId))!)).toBe(
      "snapshot bytes",
    );
  });

  it("loads only the log rows beyond a snapshot's state vector", async () => {
    const boardId = `tail-test-${Date.now()}`;
    const row = (actor: string, seq: number) => ({
      actor,
      seq,
      wall: seq,
      logical: 0,
      data: new Uint8Array([seq]),
    });
    await store.appendOps(boardId, [
      row("a", 1),
      row("a", 2),
      row("a", 3),
      row("b", 1),
    ]);
    const tail = await store.loadOps(boardId, { a: 2 });
    expect(tail.map((r) => `${r.actor}${r.seq}`)).toEqual(["a3", "b1"]);
  });
});
