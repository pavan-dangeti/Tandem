import { describe, expect, it } from "vitest";
import {
  Doc,
  type Op,
  encodeOp,
  decodeOp,
  hlcCompare,
  hlcTick,
  hlcUpdate,
} from "../src/index.js";

let now = 1_700_000_000_000;
const tick = () => now++;

function newObj(doc: Doc, objId: string, type = "rect"): void {
  doc.applyLocal([
    { t: "putObject", objId, type },
    { t: "zInsert", objId, parent: null },
  ]);
}

describe("HLC", () => {
  it("ticks monotonically", () => {
    let c = hlcTick(tick(), null, "a");
    const a = c;
    c = hlcTick(tick(), c, "a");
    expect(hlcCompare(c, a)).toBeGreaterThan(0);
  });

  it("update merges remote", () => {
    const local = hlcTick(tick(), null, "a");
    const remote = { wall: local.wall + 5, logical: 3, actor: "b" };
    const merged = hlcUpdate(tick(), local, remote);
    expect(hlcCompare(merged, remote)).toBeGreaterThan(0);
  });
});

describe("Doc convergence", () => {
  it("keeps distinct z-entries for object ids outside the actor:counter convention", () => {
    // z-node identity used to be parsed out of the objId string, so ids like
    // these collapsed onto one node and objects vanished from the order
    const d = new Doc("solo");
    for (const id of ["plain", "board:base", "a:b:c", "7"]) {
      d.applyLocal([
        { t: "putObject", objId: id, type: "rect" },
        { t: "zInsert", objId: id, parent: null },
      ]);
    }
    expect(
      d
        .shapes()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["7", "a:b:c", "board:base", "plain"]);
    expect(d.materialize().order).toHaveLength(4);
  });

  it("two replicas converge after random interleaving and duplicates", () => {
    const a = new Doc("a1");
    const b = new Doc("a2");
    const ops: Op[] = [];
    ops.push(
      ...a.applyLocal([
        { t: "putObject", objId: "a1:1", type: "rect" },
        { t: "zInsert", objId: "a1:1", parent: null },
        {
          t: "putProp",
          objId: "a1:1",
          key: "w",
          value: { kind: "int", v: 10 },
        },
      ]),
    );
    ops.push(
      ...b.applyLocal([
        { t: "putObject", objId: "a2:1", type: "ellipse" },
        { t: "zInsert", objId: "a2:1", parent: null },
        { t: "putProp", objId: "a2:1", key: "h", value: { kind: "int", v: 5 } },
      ]),
    );
    ops.push(
      ...a.applyLocal([
        {
          t: "putProp",
          objId: "a1:1",
          key: "w",
          value: { kind: "int", v: 42 },
        },
      ]),
    );
    ops.push(...b.applyLocal([{ t: "deleteObject", objId: "a2:1" }]));
    const shuffled = [...ops].sort(() => (tick() % 3) - 1);
    for (const o of shuffled) a.applyRemote(o);
    for (const o of ops) b.applyRemote(o);
    const m1 = JSON.stringify(a.materialize());
    const m2 = JSON.stringify(b.materialize());
    expect(m1).toEqual(m2);
  });

  it("buffered out-of-order ops eventually apply", () => {
    const a = new Doc("a1");
    const b = new Doc("a2");
    const ops: Op[] = [];
    ops.push(
      ...a.applyLocal([
        { t: "putObject", objId: "a1:1", type: "text" },
        { t: "zInsert", objId: "a1:1", parent: null },
      ]),
    );
    ops.push(
      ...a.applyLocal([
        {
          t: "textInsert",
          objId: "a1:1",
          id: { actor: "a1", counter: 7 },
          parent: null,
          ch: "h",
        },
        {
          t: "textInsert",
          objId: "a1:1",
          id: { actor: "a1", counter: 8 },
          parent: { actor: "a1", counter: 7 },
          ch: "i",
        },
      ]),
    );
    b.applyRemote(ops[3]!); // text op before object
    b.applyRemote(ops[2]!);
    expect(b.text("a1:1")).toBe("");
    b.applyRemote(ops[0]!);
    b.applyRemote(ops[1]!);
    expect(b.text("a1:1")).toBe("hi");
    expect(JSON.stringify(a.materialize())).toEqual(
      JSON.stringify(b.materialize()),
    );
  });
});

describe("undo/redo", () => {
  it("undo restores prior prop value, redo reapplies", () => {
    const d = new Doc("a1");
    newObj(d, "a1:1");
    d.applyLocal([
      { t: "putProp", objId: "a1:1", key: "w", value: { kind: "int", v: 5 } },
    ]);
    d.applyLocal([
      { t: "putProp", objId: "a1:1", key: "w", value: { kind: "int", v: 9 } },
    ]);
    d.undo("a1");
    expect(d.shapes()[0]!.props["w"]).toEqual({ kind: "int", v: 5 });
    d.redo("a1");
    expect(d.shapes()[0]!.props["w"]).toEqual({ kind: "int", v: 9 });
    d.undo("a1");
    d.undo("a1");
    expect(d.shapes()[0]!.props["w"]).toBeUndefined();
  });

  it("per-user undo does not clobber other actors", () => {
    const a = new Doc("a1");
    const b = new Doc("a2");
    const ab: Op[] = [];
    ab.push(
      ...a.applyLocal([
        { t: "putObject", objId: "a1:1", type: "rect" },
        { t: "zInsert", objId: "a1:1", parent: null },
      ]),
    );
    ab.push(
      ...b.applyLocal([
        { t: "putObject", objId: "a2:1", type: "ellipse" },
        { t: "zInsert", objId: "a2:1", parent: null },
      ]),
    );
    a.merge(ab.slice(2));
    b.merge(ab.slice(0, 2));
    a.undo("a1");
    expect(a.shapes().map((s) => s.id)).toEqual(["a2:1"]);
    expect(b.shapes().map((s) => s.id)).toEqual(["a2:1", "a1:1"]);
  });

  it("undo of textInsert removes the char and redo restores", () => {
    const d = new Doc("a1");
    newObj(d, "a1:1", "text");
    d.applyLocal([
      {
        t: "textInsert",
        objId: "a1:1",
        id: { actor: "a1", counter: 3 },
        parent: null,
        ch: "x",
      },
    ]);
    d.undo("a1");
    expect(d.text("a1:1")).toBe("");
    d.redo("a1");
    expect(d.text("a1:1")).toBe("x");
  });
});

describe("encoding", () => {
  it("round-trips representative ops", () => {
    const d = new Doc("a1");
    const ops: Op[] = [];
    ops.push(
      ...d.applyLocal([{ t: "putObject", objId: "a1:1", type: "rect" }]),
    );
    ops.push(
      ...d.applyLocal([
        {
          t: "putProp",
          objId: "a1:1",
          key: "pts",
          value: { kind: "points", v: [{ x: 1.5, y: -2.25 }] },
        },
      ]),
    );
    ops.push(
      ...d.applyLocal([
        {
          t: "textInsert",
          objId: "a1:1",
          id: { actor: "a1", counter: 9 },
          parent: null,
          ch: "€",
        },
      ]),
    );
    for (const op of ops) {
      const back = decodeOp(encodeOp(op));
      expect(back).toEqual(op);
    }
  });
});

describe("gc", () => {
  it("gc of stable deletes preserves materialized state", () => {
    const d = new Doc("a1");
    newObj(d, "a1:1");
    d.applyLocal([
      { t: "putProp", objId: "a1:1", key: "w", value: { kind: "int", v: 5 } },
    ]);
    d.applyLocal([{ t: "deleteObject", objId: "a1:1" }]);
    const before = JSON.stringify({
      shapes: d.shapes(),
      order: d.materialize().order,
    });
    const opCount = d.opList.length;
    d.gc(new Map([["a1", 100]]));
    const after = JSON.stringify({
      shapes: d.shapes(),
      order: d.materialize().order,
    });
    expect(after).toEqual(before);
    expect(d.opList.length).toBeLessThan(opCount);
  });
});
