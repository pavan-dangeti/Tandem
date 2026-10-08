// Wire framing shared by the sync server and the web client.
// Source of truth for the layout is docs/protocol.md (tandem/1).

export const FRAME = {
  HELLO: 0,
  SYNC_RESPONSE: 1,
  OP_BATCH: 2,
  ACK: 3,
  PRESENCE: 4,
  ERROR: 5,
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

// 1 MiB per frame; op batches stay well below this thanks to the per-connection rate limit.
export const MAX_FRAME = 1024 * 1024;

export const PROTOCOL_VERSION = "tandem/1";

export function buildFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 4 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

export function parseFrame(
  buf: Uint8Array,
): { type: FrameType; payload: Uint8Array } | null {
  if (buf.length < 5) return null;
  const type = buf[0] as FrameType;
  const len = new DataView(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength,
  ).getUint32(1);
  if (buf.length < 5 + len) return null;
  return { type, payload: buf.subarray(5, 5 + len) };
}

// Op payload: [u32be count][u32be len][op bytes]...
export function packOps(ops: Uint8Array[]): Uint8Array {
  let total = 4;
  for (const o of ops) total += 4 + o.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, ops.length);
  let off = 4;
  for (const o of ops) {
    dv.setUint32(off, o.length);
    out.set(o, off + 4);
    off += 4 + o.length;
  }
  return out;
}

export function unpackOps(buf: Uint8Array): Uint8Array[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint32(0);
  const out: Uint8Array[] = [];
  let off = 4;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(off);
    out.push(buf.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return out;
}

// SyncResponse payload: [u32be jsonLen][JSON {stateVector}][packed ops]
// The JSON header also carries the actor id the server assigned: share-link
// guests get one per link and device, and the client must sign ops as it.
export function packSyncResponse(
  stateVector: Record<string, number>,
  ops: Uint8Array[],
  userId?: string,
): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({
      stateVector,
      ...(userId !== undefined ? { userId } : {}),
    }),
  );
  const opsPayload = packOps(ops);
  const out = new Uint8Array(4 + json.length + opsPayload.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(opsPayload, 4 + json.length);
  return out;
}

export function unpackSyncResponse(payload: Uint8Array): {
  stateVector: Record<string, number>;
  ops: Uint8Array[];
  userId?: string;
} {
  const dv = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const jsonLen = dv.getUint32(0);
  const { stateVector, userId } = JSON.parse(
    new TextDecoder().decode(payload.subarray(4, 4 + jsonLen)),
  ) as { stateVector: Record<string, number>; userId?: string };
  const ops =
    payload.byteLength > 4 + jsonLen
      ? unpackOps(payload.subarray(4 + jsonLen))
      : [];
  return { stateVector, ops, ...(userId !== undefined ? { userId } : {}) };
}

export interface Presence {
  userId: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
  selection?: string[];
  at: number;
}

export interface Ack {
  batchId: string;
  applied: number;
  stateVector: Record<string, number>;
}

export interface ServerError {
  code: string;
  message: string;
}
