import { TYPE_TAG } from "./op.js";
import type { Op, OpSpec, Value } from "./op.js";
import type { RGAId } from "./rga.js";

const te = new TextEncoder();
const td = new TextDecoder();

function varint(buf: number[], n: number): void {
  while (n >= 128) {
    buf.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  buf.push(n);
}

function readVarint(b: Uint8Array, off: number): { n: number; off: number } {
  let n = 0;
  let mult = 1;
  for (;;) {
    const byte = b[off++]!;
    n += (byte & 0x7f) * mult;
    if ((byte & 0x80) === 0) return { n, off };
    mult *= 128;
  }
}

function writeStr(buf: number[], s: string): void {
  const bytes = te.encode(s);
  varint(buf, bytes.length);
  for (const b of bytes) buf.push(b);
}

function readStr(b: Uint8Array, off: number): { s: string; off: number } {
  const { n, off: o2 } = readVarint(b, off);
  const s = td.decode(b.subarray(o2, o2 + n));
  return { s, off: o2 + n };
}

function writeValue(buf: number[], v: Value): void {
  switch (v.kind) {
    case "null":
      buf.push(0);
      break;
    case "bool":
      buf.push(1, v.v ? 1 : 0);
      break;
    case "int":
      buf.push(2);
      varint(buf, v.v >= 0 ? v.v * 2 : -v.v * 2 - 1);
      break;
    case "double": {
      buf.push(3);
      const d = new DataView(new ArrayBuffer(8));
      d.setFloat64(0, v.v);
      for (let i = 0; i < 8; i++) buf.push(d.getUint8(i));
      break;
    }
    case "string":
      buf.push(4);
      writeStr(buf, v.v);
      break;
    case "points": {
      buf.push(5);
      varint(buf, v.v.length);
      for (const p of v.v) {
        const d = new DataView(new ArrayBuffer(16));
        d.setFloat64(0, p.x);
        d.setFloat64(8, p.y);
        for (let i = 0; i < 16; i++) buf.push(d.getUint8(i));
      }
      break;
    }
  }
}

function readValue(b: Uint8Array, off: number): { v: Value; off: number } {
  const tag = b[off++]!;
  switch (tag) {
    case 0:
      return { v: { kind: "null" }, off };
    case 1:
      return { v: { kind: "bool", v: b[off++] === 1 }, off };
    case 2: {
      const { n, off: o2 } = readVarint(b, off);
      return { v: { kind: "int", v: n % 2 === 0 ? n / 2 : -(n + 1) / 2 }, off: o2 };
    }
    case 3: {
      const d = new DataView(b.buffer, b.byteOffset + off, 8);
      return { v: { kind: "double", v: d.getFloat64(0) }, off: off + 8 };
    }
    case 4: {
      const { s, off: o2 } = readStr(b, off);
      return { v: { kind: "string", v: s }, off: o2 };
    }
    case 5: {
      const { n, off: o2 } = readVarint(b, off);
      const pts: { x: number; y: number }[] = [];
      let p = o2;
      for (let i = 0; i < n; i++) {
        const d = new DataView(b.buffer, b.byteOffset + p, 16);
        pts.push({ x: d.getFloat64(0), y: d.getFloat64(8) });
        p += 16;
      }
      return { v: { kind: "points", v: pts }, off: p };
    }
    default:
      throw new Error(`bad value tag ${tag}`);
  }
}

function writeRGAId(buf: number[], id: RGAId | null): void {
  if (id === null) {
    buf.push(0);
    return;
  }
  buf.push(1);
  writeStr(buf, id.actor);
  varint(buf, id.counter);
}

function readRGAId(
  b: Uint8Array,
  off: number,
): { id: RGAId | null; off: number } {
  const present = b[off++]!;
  if (present === 0) return { id: null, off };
  const { s, off: o2 } = readStr(b, off);
  const { n, off: o3 } = readVarint(b, o2);
  return { id: { actor: s, counter: n }, off: o3 };
}

export function encodeOp(op: Op): Uint8Array {
  const buf: number[] = [];
  buf.push(1); // version
  writeStr(buf, op.actor);
  varint(buf, op.seq);
  varint(buf, op.wall);
  varint(buf, op.logical);
  buf.push(TYPE_TAG[op.spec.t]);
  const s = op.spec;
  switch (s.t) {
    case "putObject":
      writeStr(buf, s.objId);
      writeStr(buf, s.type);
      break;
    case "deleteObject":
    case "restoreObject":
    case "zRemove":
      writeStr(buf, s.objId);
      break;
    case "putProp":
      writeStr(buf, s.objId);
      writeStr(buf, s.key);
      writeValue(buf, s.value);
      break;
    case "removeProp":
      writeStr(buf, s.objId);
      writeStr(buf, s.key);
      break;
    case "zInsert":
      writeStr(buf, s.objId);
      writeRGAId(buf, s.parent);
      break;
    case "textInsert":
      writeStr(buf, s.objId);
      writeRGAId(buf, s.id);
      writeRGAId(buf, s.parent);
      writeStr(buf, s.ch);
      break;
    case "textRemove":
      writeStr(buf, s.objId);
      writeRGAId(buf, s.id);
      break;
  }
  return Uint8Array.from(buf);
}

export function decodeOp(b: Uint8Array): Op {
  const version = b[0]!;
  if (version !== 1) throw new Error(`unsupported op version ${version}`);
  const { s: actor, off: o1 } = readStr(b, 1);
  const { n: seq, off: o2 } = readVarint(b, o1);
  const { n: wall, off: o3 } = readVarint(b, o2);
  const { n: logical, off: o4 } = readVarint(b, o3);
  let off = o4;
  const typeByte = b[off++]!;
  const TAG_TYPE: Record<number, OpSpec["t"]> = {
    0: "putObject",
    1: "deleteObject",
    2: "restoreObject",
    3: "putProp",
    4: "removeProp",
    5: "zInsert",
    6: "zRemove",
    7: "textInsert",
    8: "textRemove",
  };
  const t = TAG_TYPE[typeByte];
  let spec: OpSpec;
  switch (t) {
    case "putObject": {
      const objId = readStr(b, off);
      const type = readStr(b, objId.off);
      spec = { t, objId: objId.s, type: type.s };
      break;
    }
    case "deleteObject":
    case "restoreObject":
    case "zRemove": {
      const objId = readStr(b, off);
      spec = { t, objId: objId.s };
      break;
    }
    case "putProp": {
      const objId = readStr(b, off);
      const key = readStr(b, objId.off);
      const value = readValue(b, key.off);
      spec = { t, objId: objId.s, key: key.s, value: value.v };
      break;
    }
    case "removeProp": {
      const objId = readStr(b, off);
      const key = readStr(b, objId.off);
      spec = { t, objId: objId.s, key: key.s };
      break;
    }
    case "zInsert": {
      const objId = readStr(b, off);
      const parent = readRGAId(b, objId.off);
      spec = { t, objId: objId.s, parent: parent.id };
      break;
    }
    case "textInsert": {
      const objId = readStr(b, off);
      const id = readRGAId(b, objId.off);
      const parent = readRGAId(b, id.off);
      const ch = readStr(b, parent.off);
      spec = { t, objId: objId.s, id: id.id!, parent: parent.id, ch: ch.s };
      break;
    }
    case "textRemove": {
      const objId = readStr(b, off);
      const id = readRGAId(b, objId.off);
      spec = { t, objId: objId.s, id: id.id! };
      break;
    }
    default:
      throw new Error(`bad type ${t}`);
  }
  return { actor, seq, wall, logical, spec };
}
