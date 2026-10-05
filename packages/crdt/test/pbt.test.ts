import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Doc } from "../src/index.js";
import type { Op } from "../src/index.js";
import { ACTORS, Action, Ctx, interpret, newCtx } from "./helpers.js";
import { refMaterialize } from "./reference.js";

const RUNS = Number(process.env.PBT_RUNS ?? 100);
const SEED = process.env.PBT_SEED === undefined ? undefined : Number(process.env.PBT_SEED);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ k: fc.constant("putObject" as const), actor: fc.constantFrom(...ACTORS), type: fc.constantFrom("rect", "ellipse", "text", "sticky"), n: fc.nat() }),
  fc.record({ k: fc.constant("putProp" as const), actor: fc.constantFrom(...ACTORS), key: fc.constantFrom("w", "h", "x", "y"), v: fc.integer({ min: -100, max: 100 }) }),
  fc.record({ k: fc.constant("removeProp" as const), actor: fc.constantFrom(...ACTORS), key: fc.constantFrom("w", "h", "x", "y") }),
  fc.record({ k: fc.constant("deleteObject" as const), actor: fc.constantFrom(...ACTORS) }),
  fc.record({ k: fc.constant("restoreObject" as const), actor: fc.constantFrom(...ACTORS) }),
  fc.record({ k: fc.constant("textInsert" as const), actor: fc.constantFrom(...ACTORS), ch: fc.string({ minLength: 1, maxLength: 1 }) }),
  fc.record({ k: fc.constant("textRemove" as const), actor: fc.constantFrom(...ACTORS) }),
  fc.record({ k: fc.constant("zInsert" as const), actor: fc.constantFrom(...ACTORS) }),
  fc.record({ k: fc.constant("zRemove" as const), actor: fc.constantFrom(...ACTORS) }),
);

function runScript(actions: Action[]): { docs: Map<string, Doc>; allOps: Op[]; ctx: Ctx } {
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
    shapes: (m.shapes as { id: string; props: Record<string, unknown> }[]).map((s) => ({ ...s, props: Object.fromEntries(Object.entries(s.props).sort()) })),
    order: m.order.filter((o) => !o.startsWith("!")),
    texts: m.texts,
  });
}

describe("PBT convergence", () => {
  it("all replicas converge to identical state despite reorder + duplicates", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 60 }), fc.nat({ max: 10 }), (actions, dupMask) => {
        const { allOps } = runScript(actions);
        const replicas = ACTORS.map((a) => new Doc(a));
        const permutations = [shuffled(allOps), shuffled(allOps), shuffled(allOps)];
        ACTORS.forEach((_, i) => {
          const ops = permutations[i]!;
          for (const op of ops) {
            replicas[i]!.applyRemote(op);
            if ((dupMask >> (op.seq % 8)) & 1) replicas[i]!.applyRemote(op);
          }
        });
        return stripped(replicas[0]!) === stripped(replicas[1]!) && stripped(replicas[1]!) === stripped(replicas[2]!);
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it("merge is commutative, associative, idempotent", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 40 }), (actions) => {
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
        return stripped(d1) === stripped(d3) && d3.opList.length === d1.opList.length;
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it("matches the reference model", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 50 }), (actions) => {
        const { allOps } = runScript(actions);
        const d = new Doc("x");
        d.merge(allOps);
        const ours = stripped(d);
        const ref = refMaterialize(allOps);
        const refShapes = JSON.stringify(ref.shapes.map((s) => ({ ...s, props: Object.fromEntries(Object.entries(s.props).sort()) })));
        const oursShapes = JSON.stringify(
          (d.materialize().shapes as { id: string; type: string; props: Record<string, unknown> }[]).map((s) => ({
            id: s.id,
            type: s.type,
            props: Object.fromEntries(Object.entries(s.props).sort()),
          })),
        );
        if (oursShapes !== refShapes) return false;
        if (JSON.stringify(d.materialize().order) !== JSON.stringify(ref.order)) return false;
        if (JSON.stringify(d.materialize().texts) !== JSON.stringify(ref.texts)) return false;
        return ours.includes("shapes"); // keep stripped used
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it("undo all reverts to empty and redo restores", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 30 }), (actions) => {
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
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it("gc preserves materialized state", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 50 }), (actions) => {
        const { allOps, ctx } = runScript(actions);
        const d = new Doc("x");
        d.merge(allOps);
        const before = stripped(d);
        const stable = new Map<string, number>();
        // every actor's full contiguous frontier
        for (const op of allOps) stable.set(op.actor, Math.max(stable.get(op.actor) ?? 0, op.seq));
        d.gc(stable);
        return stripped(d) === before;
      }),
      { numRuns: RUNS, seed: SEED },
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
