import { Doc } from "../src/index.js";
import type { Op } from "../src/index.js";

export const ACTORS = ["alpha", "beta", "gamma"];

function objId(actor: string, n: number): string {
  return `${actor}:${n}`;
}

export type Action =
  | { k: "putObject"; actor: string; type: string; n: number }
  | { k: "putProp"; actor: string; key: string; v: number }
  | { k: "removeProp"; actor: string; key: string }
  | { k: "deleteObject"; actor: string }
  | { k: "restoreObject"; actor: string }
  | { k: "textInsert"; actor: string; ch: string }
  | { k: "textRemove"; actor: string }
  | { k: "zInsert"; actor: string }
  | { k: "zRemove"; actor: string };

export interface Ctx {
  objects: string[];
  objCounters: Map<string, number>;
  textIds: Map<string, { actor: string; counter: number }[]>;
  textCounter: number;
}

export function newCtx(): Ctx {
  return {
    objects: [],
    objCounters: new Map(),
    textIds: new Map(),
    textCounter: 1,
  };
}

export function interpret(
  action: Action,
  docs: Map<string, Doc>,
  ctx: Ctx,
): Op[] {
  const doc = docs.get(action.actor);
  if (!doc) return [];
  const objects = ctx.objects;
  switch (action.k) {
    case "putObject": {
      const counter = (ctx.objCounters.get(action.actor) ?? 0) + 1;
      ctx.objCounters.set(action.actor, counter);
      const id = objId(action.actor, counter);
      objects.push(id);
      return doc.applyLocal([
        { t: "putObject", objId: id, type: action.type },
        { t: "zInsert", objId: id, parent: null },
      ]);
    }
    case "putProp": {
      if (objects.length === 0) return [];
      const obj = objects[action.actor.length % objects.length]!;
      return doc.applyLocal([
        {
          t: "putProp",
          objId: obj,
          key: action.key,
          value: { kind: "int", v: action.v },
        },
      ]);
    }
    case "removeProp": {
      if (objects.length === 0) return [];
      const obj = objects[(action.actor.length + 1) % objects.length]!;
      return doc.applyLocal([{ t: "removeProp", objId: obj, key: action.key }]);
    }
    case "deleteObject": {
      if (objects.length === 0) return [];
      return doc.applyLocal([{ t: "deleteObject", objId: objects[0]! }]);
    }
    case "restoreObject": {
      if (objects.length === 0) return [];
      return doc.applyLocal([{ t: "restoreObject", objId: objects[0]! }]);
    }
    case "textInsert": {
      if (objects.length === 0) return [];
      const obj = objects[objects.length - 1]!;
      const id = { actor: action.actor, counter: ctx.textCounter++ };
      ctx.textIds.set(obj, [...(ctx.textIds.get(obj) ?? []), id]);
      const parents = ctx.textIds.get(obj) ?? [];
      const parent = parents.length > 1 ? parents[parents.length - 2]! : null;
      return doc.applyLocal([
        { t: "textInsert", objId: obj, id, parent, ch: action.ch },
      ]);
    }
    case "textRemove": {
      if (objects.length === 0) return [];
      const obj = objects[objects.length - 1]!;
      const ids = ctx.textIds.get(obj);
      if (!ids || ids.length === 0) return [];
      const id = ids.shift()!;
      return doc.applyLocal([{ t: "textRemove", objId: obj, id }]);
    }
    case "zInsert": {
      if (objects.length === 0) return [];
      const obj = objects[(action.actor.length + 2) % objects.length]!;
      return doc.applyLocal([{ t: "zInsert", objId: obj, parent: null }]);
      // ponytail: re-insert of an already z-inserted object just undeletes; duplicate parents ignored
    }
    case "zRemove": {
      if (objects.length === 0) return [];
      const obj = objects[objects.length - 1]!;
      return doc.applyLocal([{ t: "zRemove", objId: obj }]);
    }
    default:
      return [];
  }
}
