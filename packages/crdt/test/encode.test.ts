import { describe, expect, it } from "vitest";
import { RGA, decodeOp, encodeOp, type Op, type Value } from "../src/index.js";

function opOf(spec: Op["spec"], seq: number): Op {
  return { actor: "a1", wall: 1_700_000_000_000, logical: 1, seq, spec };
}

function opWithValue(value: Value): Op {
  return opOf({ t: "putProp", objId: "a1:1", key: "v", value }, 1);
}

function id(actor: string, counter: number) {
  return { actor, counter };
}

describe("encode/decode", () => {
  it("round-trips every value kind", () => {
    const values: Value[] = [
      { kind: "null" },
      { kind: "bool", v: true },
      { kind: "bool", v: false },
      { kind: "int", v: -5 },
      { kind: "int", v: 1_000_000 },
      { kind: "double", v: -2.5 },
      { kind: "double", v: 1e300 },
      { kind: "string", v: "héllo €" },
      {
        kind: "points",
        v: [
          { x: 0, y: 0 },
          { x: -1.5, y: 2 },
        ],
      },
    ];
    for (const value of values) {
      const op = opWithValue(value);
      expect(decodeOp(encodeOp(op))).toEqual(op);
    }
  });

  it("encodes every op type", () => {
    const specs: Array<Op["spec"]> = [
      { t: "putObject", objId: "a1:1", type: "rect" },
      { t: "deleteObject", objId: "a1:1" },
      { t: "restoreObject", objId: "a1:1" },
      { t: "removeProp", objId: "a1:1", key: "w" },
      { t: "zInsert", objId: "a1:1", parent: null },
      { t: "zRemove", objId: "a1:1" },
      {
        t: "textInsert",
        objId: "a1:1",
        id: { actor: "a1", counter: 1 },
        parent: null,
        ch: "x",
      },
      { t: "textRemove", objId: "a1:1", id: { actor: "a1", counter: 1 } },
    ];
    for (const spec of specs) {
      const op = opOf(spec, 1);
      expect(decodeOp(encodeOp(op))).toEqual(op);
    }
  });

  it("uses multi-byte varints for large counters", () => {
    const op = opOf(
      { t: "putObject", objId: "a1:1", type: "rect" },
      300_000_000,
    );
    expect(decodeOp(encodeOp(op))).toEqual(op);
  });

  it("rejects an unsupported version", () => {
    const op = opOf({ t: "putObject", objId: "a1:1", type: "rect" }, 1);
    const bytes = new Uint8Array(encodeOp(op));
    bytes[0] = 99;
    expect(() => decodeOp(bytes)).toThrow(/unsupported op version/);
  });

  it("rejects an unknown type tag", () => {
    // version, actor length, actor, seq, wall, logical and a type byte that
    // no TAG_TYPE maps: decodeOp must fail instead of inventing a spec
    const bytes = new Uint8Array([1, 2, 0x61, 0x31, 1, 1, 1, 9]);
    expect(() => decodeOp(bytes)).toThrow(/bad type/);
  });
});

describe("RGA", () => {
  it("resolves parents, values and deletion order", () => {
    const rga = new RGA<number>();
    const root = id("a1", 1);
    rga.insert(root, null, 10);
    const child = id("a1", 2);
    rga.insert(child, root, 20);
    expect(rga.parentOf(child)).toEqual(root);
    expect(rga.getValue(child)).toBe(20);
    expect(rga.values()).toEqual([10, 20]);
  });

  it("returns null for a root parent and for an unknown node", () => {
    const rga = new RGA<number>();
    const root = id("a1", 1);
    rga.insert(root, null, 10);
    expect(rga.parentOf(root)).toBeNull();
    expect(rga.parentOf(id("a1", 99))).toBeNull();
  });

  it("keeps the first write when the same id is inserted twice", () => {
    const rga = new RGA<number>();
    expect(rga.insert(id("a1", 1), null, 10)).toBe(true);
    expect(rga.insert(id("a1", 1), null, 20)).toBe(false);
    expect(rga.getValue(id("a1", 1))).toBe(10);
  });

  it("waits for a parent that has not been inserted yet", () => {
    const rga = new RGA<number>();
    const parent = id("a1", 1);
    const child = id("a1", 2);
    expect(rga.insert(child, parent, 20)).toBe(true);
    expect(rga.insert(parent, null, 10)).toBe(true);
    expect(rga.getValue(parent)).toBe(10);
    expect(rga.getValue(child)).toBe(20);
  });

  it("applies a delete issued before the node exists", () => {
    const rga = new RGA<number>();
    const target = id("a1", 1);
    const hlc = { wall: 10, logical: 1, actor: "a1" };
    expect(rga.delete(target, hlc)).toBe(false);
    expect(rga.insert(target, null, 10)).toBe(true);
    expect(rga.values()).toEqual([]);
  });

  it("undeletes and keeps the newest causal write", () => {
    const rga = new RGA<number>();
    const target = id("a1", 1);
    rga.insert(target, null, 10);
    rga.delete(target);
    expect(rga.values()).toEqual([]);
    rga.undelete(target);
    expect(rga.values()).toEqual([10]);
  });

  it("rejects a repeated write that carries an older logical time", () => {
    const rga = new RGA<number>();
    const hlc = { wall: 10, logical: 1, actor: "a1" };
    expect(rga.insert(id("a1", 1), null, 10, hlc)).toBe(true);
    expect(
      rga.insert(id("a1", 1), null, 20, { wall: 10, logical: 5, actor: "a1" }),
    ).toBe(false);
    expect(rga.getValue(id("a1", 1))).toBe(10);
  });

  it("skips deleted nodes in values and marks them in materialize", () => {
    const rga = new RGA<number>();
    const root = id("a1", 1);
    rga.insert(root, null, 10);
    const child = id("a1", 2);
    rga.insert(child, root, 20);
    rga.delete(child);
    expect(rga.values()).toEqual([10]);
    const state = rga.materialize();
    expect(state.ids).toContain("!a1:2");
    expect(rga.equals(rga)).toBe(true);
    expect(rga.equals(new RGA<number>())).toBe(false);
  });

  it("collects only deleted leaves that are not kept", () => {
    const rga = new RGA<number>();
    const root = id("a1", 1);
    const middle = id("a1", 2);
    const leaf = id("a1", 3);
    const tail = id("a1", 4);
    rga.insert(root, null, 10);
    rga.insert(middle, root, 20);
    rga.insert(leaf, middle, 30);
    rga.insert(tail, leaf, 40);
    rga.delete(tail);
    rga.delete(middle);
    rga.delete(leaf);
    // a1:2 is kept even though it is deleted, a1:3 still has children,
    // and only a1:4 itself qualifies for collection
    rga.gcDeleted((node) => node.counter === 2);
    const state = rga.materialize();
    expect(state.ids).not.toContain("!a1:4");
    expect(state.ids).toContain("!a1:2");
    expect(state.ids).toContain("!a1:3");
  });
});
