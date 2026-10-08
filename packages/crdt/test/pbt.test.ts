import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Doc } from "../src/index.js";
import type { Op } from "../src/index.js";
import { ACTORS, interpret, newCtx, type Action, type Ctx } from "./helpers.js";
import { refMaterialize } from "./reference.js";

const RUNS = Number(process.env.PBT_RUNS ?? 100);
// fast-check prints the seed of any failing run; PBT_SEED=<seed> replays it
const PARAMS = {
  numRuns: RUNS,
  ...(process.env.PBT_SEED === undefined
    ? {}
    : { seed: Number(process.env.PBT_SEED) }),
};

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    k: fc.constant("putObject" as const),
    actor: fc.constantFrom(...ACTORS),
    type: fc.constantFrom("rect", "ellipse", "text", "sticky"),
    n: fc.nat(),
  }),
  fc.record({
    k: fc.constant("putProp" as const),
    actor: fc.constantFrom(...ACTORS),
    key: fc.constantFrom("w", "h", "x", "y"),
    v: fc.integer({ min: -100, max: 100 }),
  }),
  fc.record({
    k: fc.constant("removeProp" as const),
    actor: fc.constantFrom(...ACTORS),
    key: fc.constantFrom("w", "h", "x", "y"),
  }),
  fc.record({
    k: fc.constant("deleteObject" as const),
    actor: fc.constantFrom(...ACTORS),
  }),
  fc.record({
    k: fc.constant("restoreObject" as const),
    actor: fc.constantFrom(...ACTORS),
  }),
  fc.record({
    k: fc.constant("textInsert" as const),
    actor: fc.constantFrom(...ACTORS),
    ch: fc.string({ minLength: 1, maxLength: 1 }),
  }),
  fc.record({
    k: fc.constant("textRemove" as const),
    actor: fc.constantFrom(...ACTORS),
  }),
  fc.record({
    k: fc.constant("zInsert" as const),
    actor: fc.constantFrom(...ACTORS),
  }),
  fc.record({
    k: fc.constant("zRemove" as const),
    actor: fc.constantFrom(...ACTORS),
  }),
);

function runScript(actions: Action[]): {
  docs: Map<string, Doc>;
  allOps: Op[];
  ctx: Ctx;
} {
  const docs = new Map<string, Doc>();
  for (const a of ACTORS) docs.set(a, new Doc(a));
  const allOps: Op[] = [];
  const ctx = newCtx();
  for (const action of actions) {
    try {
      allOps.push(...interpret(action, docs, ctx));
    } catch {
      // generator invariants may reference not-yet-existing objects; skip
    }
  }
  return { docs, allOps, ctx };
}

function stripped(d: Doc) {
  const m = d.materialize();
  return JSON.stringify({
    shapes: (m.shapes as { id: string; props: Record<string, unknown> }[]).map(
      (s) => ({
        ...s,
        props: Object.fromEntries(Object.entries(s.props).sort()),
      }),
    ),
    order: m.order.filter((o) => !o.startsWith("!")),
    texts: m.texts,
  });
}

describe("PBT convergence", () => {
  it("all replicas converge to identical state despite reorder + duplicates", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 60 }),
        fc.nat({ max: 10 }),
        (actions, dupMask) => {
          const { allOps } = runScript(actions);
          const replicas = ACTORS.map((a) => new Doc(a));
          const permutations = [
            shuffled(allOps),
            shuffled(allOps),
            shuffled(allOps),
          ];
          ACTORS.forEach((_, i) => {
            const ops = permutations[i]!;
            for (const op of ops) {
              replicas[i]!.applyRemote(op);
              if ((dupMask >> (op.seq % 8)) & 1) replicas[i]!.applyRemote(op);
            }
          });
          return (
            stripped(replicas[0]!) === stripped(replicas[1]!) &&
            stripped(replicas[1]!) === stripped(replicas[2]!)
          );
        },
      ),
      PARAMS,
    );
  });

  it("a replica rebuilt from compacted ops matches and keeps converging", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 60 }),
        fc.nat(),
        (actions, split) => {
          const { allOps } = runScript(actions);
          const cut = split % (allOps.length + 1);
          const full = new Doc("full");
          full.merge(allOps.slice(0, cut));
          const rebuilt = new Doc("rebuilt");
          rebuilt.merge(full.compactOps());
          rebuilt.markSeen(full.stateVector());
          const sameVector =
            JSON.stringify([...rebuilt.stateVector()].sort()) ===
            JSON.stringify([...full.stateVector()].sort());
          full.merge(allOps.slice(cut));
          rebuilt.merge(allOps.slice(cut));
          return sameVector && stripped(full) === stripped(rebuilt);
        },
      ),
      PARAMS,
    );
  });

  it("a partial replica catches up from missingSince plus markSeen", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 60 }),
        fc.array(fc.boolean(), { maxLength: 200 }),
        (actions, keep) => {
          const { allOps } = runScript(actions);
          const server = new Doc("server");
          server.merge(allOps);
          const client = new Doc("client");
          client.merge(allOps.filter((_, i) => keep[i] ?? false));
          client.merge(server.missingSince(client.stateVector()));
          client.markSeen(server.stateVector());
          return (
            stripped(client) === stripped(server) &&
            server.missingSince(client.stateVector()).length === 0
          );
        },
      ),
      PARAMS,
    );
  });

  it("compaction drops superseded property writes", () => {
    const doc = new Doc("a");
    doc.applyLocal([{ t: "putObject", objId: "a:1", type: "rect" }]);
    for (let i = 0; i < 100; i++)
      doc.applyLocal([
        { t: "putProp", objId: "a:1", key: "x", value: { kind: "int", v: i } },
      ]);
    expect(doc.compactOps()).toHaveLength(2);
  });

  it("merge is commutative, associative, idempotent", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 40 }),
        (actions) => {
          const { allOps } = runScript(actions);
          const half = Math.floor(allOps.length / 2);
          const O1 = allOps.slice(0, half);
          const O2 = allOps.slice(half);
          const d1 = new Doc("x");
          d1.merge(O1);
          d1.merge(O2);
          const d2 = new Doc("x");
          d2.merge(O2);
          d2.merge(O1);
          if (stripped(d1) !== stripped(d2)) return false;
          const d3 = new Doc("x");
          d3.merge(O1);
          d3.merge(O2);
          d3.merge(O1);
          d3.merge(O2);
          return (
            stripped(d1) === stripped(d3) &&
            d3.opList.length === d1.opList.length
          );
        },
      ),
      PARAMS,
    );
  });

  it("matches the reference model", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 50 }),
        (actions) => {
          const { allOps } = runScript(actions);
          const d = new Doc("x");
          d.merge(allOps);
          const ours = stripped(d);
          const ref = refMaterialize(allOps);
          const refShapes = JSON.stringify(
            ref.shapes.map((s) => ({
              ...s,
              props: Object.fromEntries(Object.entries(s.props).sort()),
            })),
          );
          const oursShapes = JSON.stringify(
            (
              d.materialize().shapes as {
                id: string;
                type: string;
                props: Record<string, unknown>;
              }[]
            ).map((s) => ({
              id: s.id,
              type: s.type,
              props: Object.fromEntries(Object.entries(s.props).sort()),
            })),
          );
          if (oursShapes !== refShapes) return false;
          if (
            JSON.stringify(d.materialize().order) !== JSON.stringify(ref.order)
          )
            return false;
          if (
            JSON.stringify(d.materialize().texts) !== JSON.stringify(ref.texts)
          )
            return false;
          return ours.includes("shapes"); // keep stripped used
        },
      ),
      PARAMS,
    );
  });

  it("undo all reverts to empty and redo restores", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 30 }),
        (actions) => {
          const docs = new Map<string, Doc>();
          docs.set("alpha", new Doc("alpha"));
          const ctx = newCtx();
          for (const a of actions.filter((a) => a.actor === "alpha")) {
            try {
              interpret(a, docs, ctx);
            } catch {
              /* skip */
            }
          }
          const a0 = docs.get("alpha")!;
          const before = stripped(a0);
          while (a0.undo("alpha") !== null) {
            /* undo all */
          }
          const afterUndo = stripped(a0);
          if (JSON.parse(afterUndo).shapes.length !== 0) return false;
          while (a0.redo("alpha") !== null) {
            /* redo all */
          }
          return stripped(a0) === before;
        },
      ),
      PARAMS,
    );
  });

  it("gc preserves materialized state", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 50 }),
        (actions) => {
          const { allOps } = runScript(actions);
          const d = new Doc("x");
          d.merge(allOps);
          const before = stripped(d);
          const stable = new Map<string, number>();
          // every actor's full contiguous frontier
          for (const op of allOps)
            stable.set(op.actor, Math.max(stable.get(op.actor) ?? 0, op.seq));
          d.gc(stable);
          return stripped(d) === before;
        },
      ),
      PARAMS,
    );
  });
});

function shuffled<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
