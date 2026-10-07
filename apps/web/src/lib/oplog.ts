import type { Op } from "@tandem/crdt";

const DB_NAME = "tandem";
const STORE = "oplog";

export interface StoredOp {
  boardId: string;
  actor: string;
  seq: number;
  op: unknown;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("board", "boardId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Durable op log: every op is written before it is sent, so a reload replays
// exactly what this user did even while offline.
export class OpLog {
  private db: IDBDatabase | null = null;
  private memory: StoredOp[] = [];
  private useMemory = false;

  async init(): Promise<void> {
    if (typeof indexedDB === "undefined") {
      this.useMemory = true;
      return;
    }
    this.db = await openDb();
  }

  async append(boardId: string, ops: Op[]): Promise<void> {
    if (this.useMemory || !this.db) {
      this.memory.push(
        ...ops.map((op) => ({ boardId, actor: op.actor, seq: op.seq, op })),
      );
      return;
    }
    const tx = this.db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const op of ops) {
      store.put({
        key: `${boardId}:${op.actor}:${op.seq}`,
        boardId,
        actor: op.actor,
        seq: op.seq,
        op,
      });
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async load(boardId: string): Promise<Op[]> {
    const out: Op[] = [];
    if (this.useMemory || !this.db) {
      for (const rec of this.memory)
        if (rec.boardId === boardId) out.push(rec.op as Op);
      return out;
    }
    const tx = this.db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("board");
    await new Promise<void>((resolve, reject) => {
      idx.openCursor(IDBKeyRange.only(boardId)).onsuccess = (ev) => {
        const cursor = (ev.target as IDBRequest<IDBCursorWithValue | null>)
          .result;
        if (cursor) {
          out.push(cursor.value.op as Op);
          cursor.continue();
        } else resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
    return out;
  }
}
