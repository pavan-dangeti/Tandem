import { describe, expect, it } from "vitest";
import {
  buildFrame,
  parseFrame,
  packOps,
  unpackOps,
  FRAME,
} from "../src/frame.js";
import { opSchema, helloSchema } from "../src/opschema.js";
import { issueShareToken, verifyShareToken } from "../src/auth.js";

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

  it("packOps round trip", () => {
    const ops = [te.encode("aaaa"), te.encode("b"), new Uint8Array([1, 2, 3])];
    const packed = packOps(ops);
    const out = unpackOps(packed).map((o) => td.decode(o));
    expect(out).toEqual(["aaaa", "b", "\u0001\u0002\u0003"]);
  });
});

describe("opSchema", () => {
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

  it("hello schema rejects proto mismatch", () => {
    expect(
      helloSchema.safeParse({
        protocol: "tandem/2",
        token: "x",
        boardId: "b1",
        stateVector: {},
      }).success,
    ).toBe(false);
  });
});

describe("share tokens", () => {
  it("round-trip + tamper + expiry + wrong board", () => {
    const t = issueShareToken("editor", "b1", 3600);
    expect(verifyShareToken(t, "b1")?.role).toBe("editor");
    expect(verifyShareToken(t.slice(0, -2) + "zz", "b1")).toBeNull();
    expect(verifyShareToken(t, "b2")).toBeNull();
    const expired = issueShareToken("viewer", "b1", -1);
    expect(verifyShareToken(expired, "b1")).toBeNull();
  });
});
