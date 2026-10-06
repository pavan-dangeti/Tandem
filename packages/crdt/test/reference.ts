import type { HLC, Op, RGAId, Value } from "../src/index.js";

function cmp(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}

function rgaIdOf(objId: string): RGAId {
  const i = objId.lastIndexOf(":");
  return { actor: objId.slice(0, i), counter: Number(objId.slice(i + 1)) };
}

function keyOf(id: RGAId): string {
  return `${id.actor}:${id.counter}`;
}

interface ZNode {
  objId: string;
  parent: RGAId | null;
  removed: boolean;
  flagHlc: HLC | null;
}

interface TNode {
  id: RGAId;
  parent: RGAId | null;
  ch: string;
  removed: boolean;
  flagHlc: HLC | null;
}

export interface RefState {
  objects: Map<
    string,
    {
      type: string;
      typeHlc: HLC | null;
      props: Map<string, { value: Value | { kind: "removed" }; hlc: HLC }>;
      deleted: { tag: "delete" | "restore"; hlc: HLC } | null;
    }
  >;
  znodes: Map<string, ZNode>;
  texts: Map<string, TNode[]>;
}

export function refApply(st: RefState, op: Op): void {
  const hlc: HLC = { wall: op.wall, logical: op.logical, actor: op.actor };
  const s = op.spec;
  switch (s.t) {
    case "putObject": {
      let o = st.objects.get(s.objId);
      if (!o) {
        o = { type: s.type, typeHlc: hlc, props: new Map(), deleted: null };
        st.objects.set(s.objId, o);
      } else if (o.typeHlc === null || cmp(hlc, o.typeHlc) > 0) {
        o.type = s.type;
        o.typeHlc = hlc;
      }
      if (o) o.deleted = { tag: "restore", hlc };
      if (!st.texts.has(s.objId)) st.texts.set(s.objId, []);
      break;
    }
    case "deleteObject":
    case "restoreObject": {
      const o = st.objects.get(s.objId);
      if (!o) break;
      const tag = s.t === "deleteObject" ? "delete" : "restore";
      if (o.deleted === null || cmp(hlc, o.deleted.hlc) > 0)
        o.deleted = { tag, hlc };
      break;
    }
    case "putProp":
    case "removeProp": {
      const o = st.objects.get(s.objId);
      if (!o) break;
      const value: Value | { kind: "removed" } =
        s.t === "putProp" ? s.value : { kind: "removed" };
      const cur = o.props.get(s.key);
      if (cur === undefined || cmp(hlc, cur.hlc) > 0)
        o.props.set(s.key, { value, hlc });
      break;
    }
    case "zInsert":
    case "zRemove": {
      const key = keyOf(rgaIdOf(s.objId));
      let n = st.znodes.get(key);
      if (!n) {
        n = {
          objId: s.objId,
          parent: s.t === "zInsert" ? s.parent : null,
          removed: false,
          flagHlc: null,
        };
        st.znodes.set(key, n);
      }
      if (s.t === "zInsert" && n.parent === null && s.parent !== null)
        n.parent = s.parent;
      if (n.flagHlc === null || cmp(hlc, n.flagHlc) > 0) {
        n.removed = s.t === "zRemove";
        n.flagHlc = hlc;
      }
      break;
    }
    case "textInsert":
    case "textRemove": {
      const list = st.texts.get(s.objId);
      if (!list) break;
      let n = list.find(
        (x) => x.id.actor === s.id.actor && x.id.counter === s.id.counter,
      );
      if (s.t === "textInsert" && !n) {
        n = {
          id: s.id,
          parent: s.parent,
          ch: s.ch,
          removed: false,
          flagHlc: null,
        };
        list.push(n);
      }
      if (n && (n.flagHlc === null || cmp(hlc, n.flagHlc) > 0)) {
        n.removed = s.t === "textRemove";
        n.flagHlc = hlc;
      }
      break;
    }
  }
}

function refRgaWalk<V extends { removed: boolean }>(
  nodes: V[],
  getParentKey: (n: V) => string | null,
  getIdDesc: (n: V) => number,
  getIdActor: (n: V) => string,
): V[] {
  const byParent = new Map<string | null, V[]>();
  for (const n of nodes) {
    const p = getParentKey(n);
    const list = byParent.get(p) ?? [];
    list.push(n);
    byParent.set(p, list);
  }
  for (const list of byParent.values()) {
    list.sort(
      (a, b) =>
        getIdDesc(b) - getIdDesc(a) || (getIdActor(a) < getIdActor(b) ? 1 : -1),
    );
  }
  const out: V[] = [];
  const walk = (pk: string | null): void => {
    for (const n of byParent.get(pk) ?? []) {
      out.push(n);
      const key = keyOfNode(n);
      walk(key);
    }
  };
  function keyOfNode(n: V): string {
    return `${getIdActor(n)}:${getIdDesc(n)}`;
  }
  walk(null);
  return out;
}

export function refMaterialize(ops: Op[]): {
  shapes: { id: string; type: string; props: Record<string, Value> }[];
  order: string[];
  texts: Record<string, string>;
} {
  const st: RefState = {
    objects: new Map(),
    znodes: new Map(),
    texts: new Map(),
  };
  for (const op of ops) refApply(st, op);
  const zWalk = refRgaWalk(
    [...st.znodes.values()],
    (n) => (n.parent ? keyOf(n.parent) : null),
    (n) => Number(n.objId.slice(n.objId.lastIndexOf(":") + 1)),
    (n) => n.objId.slice(0, n.objId.lastIndexOf(":")),
  );
  const order = zWalk.map(
    (n) =>
      `${n.removed ? "!" : ""}${n.objId.slice(0, n.objId.lastIndexOf(":"))}:${Number(n.objId.slice(n.objId.lastIndexOf(":") + 1))}`,
  );
  const texts: Record<string, string> = {};
  for (const objId of [...st.texts.keys()].sort()) {
    const tWalk = refRgaWalk(
      st.texts.get(objId) ?? [],
      (n) => (n.parent ? keyOf(n.parent) : null),
      (n) => n.id.counter,
      (n) => n.id.actor,
    );
    texts[objId] = tWalk
      .filter((n) => !n.removed)
      .map((n) => n.ch)
      .join("");
  }
  const shapes: { id: string; type: string; props: Record<string, Value> }[] =
    [];
  for (const z of zWalk) {
    if (z.removed) continue;
    const o = st.objects.get(z.objId);
    if (!o || o.deleted?.tag === "delete") continue;
    const props: Record<string, Value> = {};
    for (const [k, v] of o.props)
      if (v.value.kind !== "removed") props[k] = v.value as Value;
    shapes.push({ id: z.objId, type: o.type, props });
  }
  return { shapes, order, texts };
}
