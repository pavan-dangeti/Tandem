import type { HLC } from "./hlc.js";
import type { RGAId } from "./rga.js";

export type OpType =
  | "putObject"
  | "deleteObject"
  | "restoreObject"
  | "putProp"
  | "removeProp"
  | "zInsert"
  | "zRemove"
  | "textInsert"
  | "textRemove";

export type Value =
  | { kind: "null" }
  | { kind: "bool"; v: boolean }
  | { kind: "int"; v: number }
  | { kind: "double"; v: number }
  | { kind: "string"; v: string }
  | { kind: "points"; v: { x: number; y: number }[] };

export type OpSpec =
  | { t: "putObject"; objId: string; type: string }
  | { t: "deleteObject"; objId: string }
  | { t: "restoreObject"; objId: string }
  | { t: "putProp"; objId: string; key: string; value: Value }
  | { t: "removeProp"; objId: string; key: string }
  | { t: "zInsert"; objId: string; parent: RGAId | null }
  | { t: "zRemove"; objId: string }
  | {
      t: "textInsert";
      objId: string;
      id: RGAId;
      parent: RGAId | null;
      ch: string;
    }
  | { t: "textRemove"; objId: string; id: RGAId };

export interface Op extends HLC {
  seq: number;
  spec: OpSpec;
}

export function opKey(op: Op): string {
  return `${op.actor}:${op.seq}`;
}

export const TYPE_TAG: Record<OpType, number> = {
  putObject: 0,
  deleteObject: 1,
  restoreObject: 2,
  putProp: 3,
  removeProp: 4,
  zInsert: 5,
  zRemove: 6,
  textInsert: 7,
  textRemove: 8,
};

export const TAG_TYPE: Record<number, OpType> = Object.fromEntries(
  Object.entries(TYPE_TAG).map(([k, v]) => [v, k as OpType]),
);
