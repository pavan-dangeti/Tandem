import { Doc, decodeOp, encodeOp, type Op, type OpSpec } from "@tandem/crdt";
import {
  FRAME,
  MAX_FRAME,
  type Ack,
  PROTOCOL_VERSION,
  buildFrame,
  packOps,
  parseFrame,
  unpackOps,
  unpackSyncResponse,
  type Presence,
} from "@tandem/protocol";
import { OpLog } from "./oplog";

export type ConnectionStatus = "connecting" | "open" | "offline";

export interface SyncClientOptions {
  doc: Doc;
  boardId: string;
  token: string;
  userId: string;
  name: string;
  color: string;
  /** defaults to the page's own origin */
  url?: string;
  oplog?: OpLog;
  /** injectable for tests; defaults to the browser WebSocket */
  socketFactory?: (url: string) => WebSocket;
}

const te = new TextEncoder();
const td = new TextDecoder();
const BATCH_SIZE = 500;
// The server rejects batches beyond its in-flight cap, so we only keep this many
// batches unacknowledged and let the Acks drive the rest.
const MAX_INFLIGHT = 4;

/**
 * Local-first sync client: every edit hits the local CRDT and the durable op log
 * immediately, then goes to the server. Reconnects replay whatever the server
 * is missing (derived from its state vector), so no separate retry queue is needed
 * because the server dedupes by (actor, seq).
 */
export class SyncClient {
  private ws: WebSocket | null = null;
  private queue: Op[] = [];
  private retry = 0;
  private closed = false;
  private inFlight = 0;
  /** highest op seq of our own ops the server has acknowledged as durable */
  private ackedSeq = 0;
  private oplog: OpLog;
  private socketFactory: (url: string) => WebSocket;
  private url: string;

  status: ConnectionStatus = "connecting";
  presences = new Map<string, Presence>();
  onChange: (() => void) | null = null;
  onPresence: (() => void) | null = null;
  onStatus: (() => void) | null = null;

  get doc(): Doc {
    return this.opts.doc;
  }

  get userId(): string {
    return this.opts.userId;
  }

  private opts: SyncClientOptions;

  constructor(opts: SyncClientOptions) {
    this.opts = opts;
    this.oplog = opts.oplog ?? new OpLog();
    this.url =
      opts.url ??
      `${typeof location === "undefined" ? "ws://localhost:8080" : location.origin.replace(/^http/, "ws")}/ws`;
    this.socketFactory =
      opts.socketFactory ?? ((u: string) => new WebSocket(u));
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.oplog.init();
    for (const op of await this.oplog.load(this.opts.boardId))
      this.opts.doc.applyRemote(op);
    this.connect();
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.();
  }

  private connect(): void {
    if (this.closed) return;
    this.setStatus("connecting");
    const ws = this.socketFactory(this.url);
    // Browsers hand binary frames over as a Blob unless asked for an ArrayBuffer.
    (ws as { binaryType?: string }).binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send(
        buildFrame(
          FRAME.HELLO,
          te.encode(
            JSON.stringify({
              protocol: PROTOCOL_VERSION,
              token: this.opts.token,
              boardId: this.opts.boardId,
              stateVector: Object.fromEntries(this.opts.doc.stateVector()),
            }),
          ),
        ),
      );
    };
    ws.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (data instanceof Blob) {
        void data
          .arrayBuffer()
          .then((buf) => this.onMessage(new Uint8Array(buf)));
        return;
      }
      this.onMessage(new Uint8Array(data as ArrayBuffer));
    };
    ws.onclose = () => {
      this.setStatus("offline");
      if (!this.closed) this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry(): void {
    this.retry++;
    setTimeout(
      () => this.connect(),
      Math.min(5000, 250 * 2 ** (this.retry - 1)),
    );
  }

  private send(bytes: Uint8Array): void {
    if (this.ws && this.ws.readyState === 1) {
      // WebSocket.send's DOM typing rejects views that may sit on a SharedArrayBuffer;
      // our frames are always plain Uint8Arrays.
      this.ws.send(bytes as unknown as ArrayBuffer);
    }
  }

  private onMessage(data: Uint8Array): void {
    const frame = parseFrame(data);
    if (!frame) return;
    switch (frame.type) {
      case FRAME.SYNC_RESPONSE: {
        const { stateVector, ops } = unpackSyncResponse(frame.payload);
        for (const raw of ops) this.applyIncoming(raw);
        this.setStatus("open");
        this.inFlight = 0;
        // The server tells us how far it has got with our ops; anything beyond
        // that was never persisted (offline edits, crash before ack) and resends.
        const serverHas = stateVector[this.opts.userId] ?? 0;
        const mine = this.opts.doc.stateVector().get(this.opts.userId) ?? 0;
        if (mine > serverHas) {
          this.flush(
            this.opts.doc.opList.filter(
              (op) => op.actor === this.opts.userId && op.seq > serverHas,
            ),
          );
        }
        this.onChange?.();
        break;
      }
      case FRAME.OP_BATCH: {
        for (const raw of unpackOps(frame.payload)) this.applyIncoming(raw);
        this.onChange?.();
        break;
      }
      case FRAME.ACK: {
        const ack = JSON.parse(td.decode(frame.payload)) as Ack;
        this.inFlight = Math.max(0, this.inFlight - 1);
        // the ack carries the server's state vector, so we know exactly which of
        // our ops are durable (not merely sent)
        const mine = ack.stateVector[this.opts.userId] ?? 0;
        if (mine > this.ackedSeq) this.ackedSeq = mine;
        // an ack frees a slot; drain whatever queued while we were capped
        this.flush([]);
        break;
      }
      case FRAME.PRESENCE: {
        const p = JSON.parse(td.decode(frame.payload)) as Presence;
        this.presences.set(p.userId, p);
        this.onPresence?.();
        break;
      }
      case FRAME.ERROR:
        console.error("sync error", td.decode(frame.payload));
        break;
      default:
        break;
    }
  }

  private applyIncoming(raw: Uint8Array): void {
    try {
      this.opts.doc.applyRemote(decodeOp(raw));
    } catch (err) {
      console.error("undecodable op", err);
    }
  }

  /** Local edit: applies immediately and durably, then syncs in the background. */
  async edit(specs: OpSpec[]): Promise<void> {
    const ops = this.opts.doc.applyLocal(specs);
    if (ops.length === 0) return;
    await this.oplog.append(this.opts.boardId, ops);
    this.flush(ops);
    this.onChange?.();
  }

  async undo(): Promise<void> {
    await this.applyUndoRedo(this.opts.doc.undo(this.opts.userId));
  }

  async redo(): Promise<void> {
    await this.applyUndoRedo(this.opts.doc.redo(this.opts.userId));
  }

  private async applyUndoRedo(ops: Op[] | null): Promise<void> {
    if (!ops || ops.length === 0) return;
    await this.oplog.append(this.opts.boardId, ops);
    this.flush(ops);
    this.onChange?.();
  }

  private flush(ops: Op[]): void {
    if (ops.length > 0) this.queue.push(...ops);
    if (this.status !== "open" || this.inFlight >= MAX_INFLIGHT) return;
    while (this.queue.length > 0 && this.inFlight < MAX_INFLIGHT) {
      const batch = this.queue.splice(
        0,
        Math.min(BATCH_SIZE, this.queue.length),
      );
      const bytes = packOps(batch.map((op) => encodeOp(op)));
      if (bytes.length > MAX_FRAME) {
        // too large for one frame: put it back and let the server's rate limit
        // push back on us rather than silently dropping work
        this.queue.unshift(...batch);
        break;
      }
      this.send(buildFrame(FRAME.OP_BATCH, bytes));
      this.inFlight++;
    }
  }

  presence(cursor?: { x: number; y: number }, selection?: string[]): void {
    const msg: Presence = {
      userId: this.opts.userId,
      name: this.opts.name,
      color: this.opts.color,
      at: Date.now(),
      ...(cursor ? { cursor } : {}),
      ...(selection ? { selection } : {}),
    };
    this.send(buildFrame(FRAME.PRESENCE, te.encode(JSON.stringify(msg))));
  }

  /** True when there are edits that have not been handed to the server yet. */
  get hasUnsentOps(): boolean {
    return this.queue.length > 0;
  }

  /** True when the server has not yet acknowledged our latest op as durable. */
  get hasUnackedOps(): boolean {
    return (
      (this.opts.doc.stateVector().get(this.opts.userId) ?? 0) > this.ackedSeq
    );
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
