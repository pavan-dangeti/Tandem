import { describe, expect, it } from "vitest";
import {
  buildFrame,
  parseFrame,
  packOps,
  unpackOps,
  packSyncResponse,
  unpackSyncResponse,
  FRAME,
} from "../src/frame.js";
import { opSchema, helloSchema } from "../src/schemas.js";

const te = new TextEncoder();
const td = new TextDecoder();

describe("frame", () => {
  it("round-trips", () => {
    const payload = te.encode(JSON.stringify({ hello: true }));
    const buf = buildFrame(FRAME.HELLO, payload);
    const parsed = parseFrame(buf);
    expect(parsed?.type).toBe(FRAME.HELLO);
    expect(td.decode(parsed!.payload)).toBe(JSON.stringify({ hello: true }));
  });

  it("returns null for incomplete frames", () => {
    const buf = buildFrame(FRAME.OP_BATCH, new Uint8Array([1, 2, 3]));
    expect(parseFrame(buf.subarray(0, 4))).toBeNull();
    expect(parseFrame(buf.subarray(0, 6))).toBeNull();
    expect(parseFrame(buf)).not.toBeNull();
  });

  it("packOps round trip", () => {
    const ops = [te.encode("aaaa"), te.encode("b"), new Uint8Array([1, 2, 3])];
    const packed = packOps(ops);
    const out = unpackOps(packed).map((o) => td.decode(o));
    expect(out).toEqual(["aaaa", "b", "\u0001\u0002\u0003"]);
  });

  it("syncResponse carries vector and ops", () => {
    const payload = packSyncResponse({ a: 3, b: 1 }, [new Uint8Array([9, 9])]);
    const { stateVector, ops } = unpackSyncResponse(payload);
    expect(stateVector).toEqual({ a: 3, b: 1 });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual(new Uint8Array([9, 9]));
  });

  it("syncResponse handles an empty op list", () => {
    const { ops } = unpackSyncResponse(packSyncResponse({}, []));
    expect(ops).toEqual([]);
  });
});

describe("schemas", () => {
  it("accepts well-formed ops", () => {
    expect(
      opSchema.safeParse({
        seq: 1,
        wall: 1000,
        logical: 0,
        actor: "u1",
        spec: { t: "putObject", objId: "u1:1", type: "rect" },
      }).success,
    ).toBe(true);
    expect(
      opSchema.safeParse({
        seq: 2,
        wall: 1000,
        logical: 1,
        actor: "u1",
        spec: {
          t: "textInsert",
          objId: "u1:1",
          id: { actor: "u1", counter: 3 },
          parent: null,
          ch: "a",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects malformed ops", () => {
    expect(
      opSchema.safeParse({
        seq: -1,
        wall: 1000,
        logical: 0,
        actor: "u1",
        spec: { t: "putObject", objId: "", type: "rect" },
      }).success,
    ).toBe(false);
    expect(
      opSchema.safeParse({
        seq: 1,
        wall: 1000,
        logical: 0,
        actor: "u1",
        spec: { t: "madeUp", objId: "u1:1" },
      }).success,
    ).toBe(false);
  });

  it("hello schema rejects protocol mismatch", () => {
    expect(
      helloSchema.safeParse({
        protocol: "tandem/2",
        token: "x",
        boardId: "b1",
        stateVector: {},
      }).success,
    ).toBe(false);
    expect(
      helloSchema.safeParse({
        protocol: "tandem/1",
        token: "x",
        boardId: "b1",
        stateVector: {},
      }).success,
    ).toBe(true);
  });
});
