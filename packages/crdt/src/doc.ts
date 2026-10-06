import { hlcCompare, hlcTick, hlcUpdate } from "./hlc.js";
import type { HLC } from "./hlc.js";
import { registerFor } from "./lww.js";
import type { Register } from "./lww.js";
import { opKey } from "./op.js";
import type { Op, OpSpec, Value } from "./op.js";
import { RGA } from "./rga.js";
import type { RGAId } from "./rga.js";

export interface Shape {
  id: string;
  type: string;
  props: Record<string, Value>;
  deleted: boolean;
}

interface ObjState {
  id: string;
  type: string;
  props: Map<string, Register<Value | { kind: "removed" }>>;
  deleted: { tag: "delete" | "restore"; hlc: HLC } | null;
  typeHlc: HLC | null;
  text: RGA<string>;
}

interface UndoEntry {
  actor: string;
  batch: { forward: OpSpec[]; inverse: OpSpec[] };
}

export class Doc {
  private objects = new Map<string, ObjState>();
  private order = new RGA<string>();
  private texts = new Map<string, RGA<string>>();
  private opIndex = new Map<string, Op>();
  private seqs = new Map<string, Set<number>>();
  private lastSeq = new Map<string, number>();
  private clock: HLC = { wall: 0, logical: 0, actor: "" };
  private undoStacks = new Map<string, UndoEntry[]>();
  private redoStacks = new Map<string, UndoEntry[]>();
  private pendingByObj = new Map<string, Op[]>();

  constructor(private readonly actor: string) {
    this.clock = { wall: Date.now(), logical: 0, actor };
  }

  applyLocal(specs: OpSpec[]): Op[] {
    const out: Op[] = [];
    const inverses: OpSpec[] = [];
    for (const spec of specs) {
      const prev = this.snapshotForInverse(spec);
      const seq = (this.lastSeq.get(this.actor) ?? 0) + 1;
      this.clock = hlcTick(Date.now(), this.clock, this.actor);
      const op: Op = { ...this.clock, seq, spec };
      this.apply(op);
      out.push(op);
      if (prev !== null) inverses.unshift(prev);
    }
    if (out.length > 0) {
      const entries = this.undoStacks.get(this.actor) ?? [];
      entries.push({
        actor: this.actor,
        batch: { forward: specs, inverse: inverses },
      });
      this.undoStacks.set(this.actor, entries);
      this.redoStacks.set(this.actor, []);
    }
    return out;
  }

  applyRemote(op: Op): boolean {
    if (this.opIndex.has(opKey(op))) return false;
    const objId = targetObjId(op.spec);
    if (
      objId !== null &&
      !this.objects.has(objId) &&
      op.spec.t !== "putObject"
    ) {
      const list = this.pendingByObj.get(objId) ?? [];
      list.push(op);
      this.pendingByObj.set(objId, list);
      this.opIndex.set(opKey(op), op);
      this.recordSeq(op);
      return true;
    }
    this.apply(op);
    return true;
  }

  merge(ops: Op[]): number {
    let applied = 0;
    for (const op of ops) if (this.applyRemote(op)) applied++;
    return applied;
  }

  private apply(op: Op): void {
    this.opIndex.set(opKey(op), op);
    this.recordSeq(op);
    this.clock = hlcUpdate(Date.now(), this.clock, op);
    const s = op.spec;
    switch (s.t) {
      case "putObject": {
        let o = this.objects.get(s.objId);
        if (o === undefined) {
          o = {
            id: s.objId,
            type: s.type,
            props: new Map(),
            deleted: {
              tag: "restore",
              hlc: { wall: op.wall, logical: op.logical, actor: op.actor },
            },
            typeHlc: { wall: op.wall, logical: op.logical, actor: op.actor },
            text: new RGA(),
          };
          this.objects.set(s.objId, o);
          this.texts.set(s.objId, o.text);
        } else {
          const hlc: HLC = {
            wall: op.wall,
            logical: op.logical,
            actor: op.actor,
          };
          if (o.typeHlc === null || hlcCompare(hlc, o.typeHlc) > 0) {
            o.type = s.type;
            o.typeHlc = hlc;
          }
          o.deleted = { tag: "restore", hlc };
        }
        const waiting = this.pendingByObj.get(s.objId);
        if (waiting !== undefined) {
          this.pendingByObj.delete(s.objId);
          for (const w of waiting) this.apply(w);
        }
        break;
      }
      case "deleteObject": {
        const o = this.objects.get(s.objId);
        const hlc: HLC = {
          wall: op.wall,
          logical: op.logical,
          actor: op.actor,
        };
        if (o && (o.deleted === null || hlcCompare(hlc, o.deleted.hlc) > 0))
          o.deleted = { tag: "delete", hlc };
        break;
      }
      case "restoreObject": {
        const o = this.objects.get(s.objId);
        const hlc: HLC = {
          wall: op.wall,
          logical: op.logical,
          actor: op.actor,
        };
        if (o && (o.deleted === null || hlcCompare(hlc, o.deleted.hlc) > 0))
          o.deleted = { tag: "restore", hlc };
        break;
      }
      case "putProp": {
        const o = this.objects.get(s.objId);
        if (o) o.props.set(s.key, registerFor(o.props.get(s.key), s.value, op));
        break;
      }
      case "removeProp": {
        const o = this.objects.get(s.objId);
        if (o)
          o.props.set(
            s.key,
            registerFor(o.props.get(s.key), { kind: "removed" }, op),
          );
        break;
      }
      case "zInsert": {
        this.order.insert(
          { counter: zCounter(s.objId), actor: objActor(s.objId) },
          s.parent,
          s.objId,
          {
            wall: op.wall,
            logical: op.logical,
            actor: op.actor,
          },
        );
        break;
      }
      case "zRemove": {
        this.order.delete(
          { counter: zCounter(s.objId), actor: objActor(s.objId) },
          { wall: op.wall, logical: op.logical, actor: op.actor },
        );
        break;
      }
      case "textInsert": {
        const t = this.texts.get(s.objId);
        if (t)
          t.insert(s.id, s.parent, s.ch, {
            wall: op.wall,
            logical: op.logical,
            actor: op.actor,
          });
        break;
      }
      case "textRemove": {
        const t = this.texts.get(s.objId);
        if (t)
          t.delete(s.id, {
            wall: op.wall,
            logical: op.logical,
            actor: op.actor,
          });
        break;
      }
    }
  }

  private recordSeq(op: Op): void {
    let set = this.seqs.get(op.actor);
    if (set === undefined) this.seqs.set(op.actor, (set = new Set()));
    set.add(op.seq);
    this.lastSeq.set(
      op.actor,
      Math.max(this.lastSeq.get(op.actor) ?? 0, op.seq),
    );
  }

  stateVector(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [actor, set] of this.seqs) {
      let frontier = 0;
      while (set.has(frontier + 1)) frontier++;
      out.set(actor, frontier);
    }
    return out;
  }

  missingSince(vec: Map<string, number>): Op[] {
    const out: Op[] = [];
    for (const op of this.opIndex.values()) {
      if (op.seq > (vec.get(op.actor) ?? 0)) out.push(op);
    }
    return out;
  }

  shapes(): Shape[] {
    const out: Shape[] = [];
    for (const objId of this.order.values()) {
      const o = this.objects.get(objId);
      if (o === undefined || o.deleted?.tag === "delete") continue;
      const props: Record<string, Value> = {};
      for (const [k, v] of o.props)
        if (v.value.kind !== "removed") props[k] = v.value;
      out.push({ id: o.id, type: o.type, props, deleted: false });
    }
    return out;
  }

  text(objId: string): string {
    return this.texts.get(objId)?.values().join("") ?? "";
  }

  undo(actor: string): Op[] | null {
    const stack = this.undoStacks.get(actor);
    if (!stack || stack.length === 0) return null;
    const entry = stack.pop()!;
    const applied = this.applyUndoOps(actor, entry.batch.inverse);
    const redo = this.redoStacks.get(actor) ?? [];
    redo.push(entry);
    this.redoStacks.set(actor, redo);
    return applied;
  }

  redo(actor: string): Op[] | null {
    const stack = this.redoStacks.get(actor);
    if (!stack || stack.length === 0) return null;
    const entry = stack.pop()!;
    const applied = this.applyUndoOps(actor, entry.batch.forward);
    const undo = this.undoStacks.get(actor);
    if (undo === undefined) this.undoStacks.set(actor, []);
    this.undoStacks.get(actor)!.push(entry);
    return applied;
  }

  gc(stable: Map<string, number>): void {
    const stableOp = (op: Op): boolean => (stable.get(op.actor) ?? 0) >= op.seq;
    for (const [id, o] of [...this.objects]) {
      if (
        o.deleted?.tag === "delete" &&
        stable.has(o.deleted.hlc.actor) &&
        (stable.get(o.deleted.hlc.actor) ?? 0) >=
          seqOfDeleted(this.opIndex.values(), id)
      ) {
        this.objects.delete(id);
      }
    }
    for (const op of [...this.opIndex.values()]) {
      if (stableOp(op)) {
        const targetDeleted =
          op.spec.t === "deleteObject" ||
          op.spec.t === "textRemove" ||
          op.spec.t === "zRemove";
        if (targetDeleted) this.opIndex.delete(opKey(op));
      }
    }
    this.order.gcDeleted((id) => {
      const op = [...this.opIndex.values()].find(
        (o) =>
          o.spec.t === "zInsert" &&
          zCounter(o.spec.objId) === id.counter &&
          objActor(o.spec.objId) === id.actor,
      );
      return op !== undefined && !stableOp(op);
    });
  }

  materialize(): {
    shapes: unknown;
    order: string[];
    texts: Record<string, string>;
    opCount: number;
  } {
    const texts: Record<string, string> = {};
    for (const id of [...this.texts.keys()].sort())
      texts[id] = this.texts.get(id)!.values().join("");
    return {
      shapes: this.shapes().map((s) => ({
        ...s,
        props: Object.fromEntries(Object.entries(s.props).sort()),
      })),
      order: this.order.materialize().ids,
      texts,
      opCount: this.opIndex.size,
    };
  }

  private applyUndoOps(actor: string, specs: OpSpec[]): Op[] {
    const out: Op[] = [];
    for (const spec of specs) {
      const seq = (this.lastSeq.get(actor) ?? 0) + 1;
      this.clock = hlcTick(Date.now(), this.clock, actor);
      const op: Op = { ...this.clock, seq, spec };
      this.apply(op);
      out.push(op);
    }
    return out;
  }

  private snapshotForInverse(spec: OpSpec): OpSpec | null {
    switch (spec.t) {
      case "putObject":
        return { t: "deleteObject", objId: spec.objId };
      case "deleteObject":
        return { t: "restoreObject", objId: spec.objId };
      case "restoreObject":
        return { t: "deleteObject", objId: spec.objId };
      case "putProp": {
        const o = this.objects.get(spec.objId);
        const prev = o?.props.get(spec.key);
        return prev === undefined || prev.value.kind === "removed"
          ? { t: "removeProp", objId: spec.objId, key: spec.key }
          : {
              t: "putProp",
              objId: spec.objId,
              key: spec.key,
              value: prev.value,
            };
      }
      case "removeProp": {
        const o = this.objects.get(spec.objId);
        const prev = o?.props.get(spec.key);
        return prev === undefined || prev.value.kind === "removed"
          ? null
          : {
              t: "putProp",
              objId: spec.objId,
              key: spec.key,
              value: prev.value,
            };
      }
      case "zInsert":
        return { t: "zRemove", objId: spec.objId };
      case "zRemove":
        return { t: "zInsert", objId: spec.objId, parent: null };
      case "textInsert":
        return { t: "textRemove", objId: spec.objId, id: spec.id };
      case "textRemove": {
        const t = this.texts.get(spec.objId);
        const nodeValue = t?.getValue(spec.id);
        return nodeValue === undefined
          ? null
          : {
              t: "textInsert",
              objId: spec.objId,
              id: spec.id,
              parent: this.textParentOf(spec.objId, spec.id),
              ch: nodeValue,
            };
      }
      default:
        return null;
    }
  }

  private textParentOf(objId: string, id: RGAId): RGAId | null {
    const t = this.texts.get(objId);
    if (!t) return null;
    return t.parentOf(id);
  }

  equals(other: Doc): boolean {
    return (
      JSON.stringify(this.materialize()) === JSON.stringify(other.materialize())
    );
  }

  toJSON(): string {
    const ops = [...this.opIndex.values()];
    return JSON.stringify({ actor: this.actor, ops });
  }

  static fromJSON(json: string): Doc {
    const { actor, ops } = JSON.parse(json) as { actor: string; ops: Op[] };
    const doc = new Doc(actor);
    for (const op of ops) doc.applyRemote(op);
    return doc;
  }

  get opList(): Op[] {
    return [...this.opIndex.values()];
  }
}

function targetObjId(spec: OpSpec): string | null {
  return "objId" in spec ? spec.objId : null;
}

function zCounter(objId: string): number {
  const i = objId.indexOf(":");
  return Number(objId.slice(i + 1));
}

function objActor(objId: string): string {
  const i = objId.indexOf(":");
  return objId.slice(0, i);
}

function seqOfDeleted(ops: Iterable<Op>, objId: string): number {
  for (const op of ops)
    if (op.spec.t === "deleteObject" && op.spec.objId === objId) return op.seq;
  return Number.POSITIVE_INFINITY;
}
