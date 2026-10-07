// Framing: [u8 type][u32be length][payload]
export const FRAME = {
  HELLO: 0,
  SYNC_RESPONSE: 1,
  OP_BATCH: 2,
  ACK: 3,
  PRESENCE: 4,
  ERROR: 5,
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

export const MAX_FRAME = 1024 * 1024; // 1MB per frame; op batches are below this by rate limiter

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

// Ops payload: [u32be opCount][u32be len][op bytes]...
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
