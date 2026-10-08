import pg from "pg";

export interface OpRow {
  actor: string;
  seq: number;
  wall: number;
  logical: number;
  data: Uint8Array;
}

export interface OpStore {
  init(): Promise<void>;
  appendOps(boardId: string, ops: OpRow[]): Promise<void>;
  /** Ops whose seq is beyond `after[actor]`, i.e. not covered by a snapshot. */
  loadOps(boardId: string, after?: Record<string, number>): Promise<OpRow[]>;
  saveSnapshot(boardId: string, state: Uint8Array): Promise<void>;
  loadSnapshot(boardId: string): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export class MemoryOpStore implements OpStore {
  private ops = new Map<string, OpRow[]>();
  private seen = new Set<string>();
  private snapshots = new Map<string, Uint8Array>();

  async init(): Promise<void> {
    /* nothing to set up */
  }
  async appendOps(boardId: string, ops: OpRow[]): Promise<void> {
    const list = this.ops.get(boardId) ?? [];
    // the same (board, actor, seq) uniqueness the Postgres table enforces
    for (const op of ops) {
      const key = `${boardId}\u0000${op.actor}\u0000${op.seq}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      list.push(op);
    }
    this.ops.set(boardId, list);
  }
  async loadOps(
    boardId: string,
    after: Record<string, number> = {},
  ): Promise<OpRow[]> {
    return (this.ops.get(boardId) ?? []).filter(
      (r) => r.seq > (after[r.actor] ?? 0),
    );
  }
  async saveSnapshot(boardId: string, state: Uint8Array): Promise<void> {
    this.snapshots.set(boardId, state);
  }
  async loadSnapshot(boardId: string): Promise<Uint8Array | null> {
    return this.snapshots.get(boardId) ?? null;
  }
  async close(): Promise<void> {
    /* nothing to release */
  }
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS ops (
  id BIGSERIAL PRIMARY KEY,
  board_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  seq INT NOT NULL,
  hlc_wall BIGINT NOT NULL,
  hlc_logical INT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (board_id, actor_id, seq)
);
CREATE TABLE IF NOT EXISTS snapshots (
  board_id TEXT PRIMARY KEY,
  state BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE snapshots DROP COLUMN IF EXISTS ops_up_to;
`;

export class PostgresOpStore implements OpStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  async appendOps(boardId: string, ops: OpRow[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const op of ops) {
        await client.query(
          "INSERT INTO ops (board_id, actor_id, seq, hlc_wall, hlc_logical, data) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (board_id, actor_id, seq) DO NOTHING",
          [
            boardId,
            op.actor,
            op.seq,
            op.wall,
            op.logical,
            Buffer.from(op.data),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async loadOps(
    boardId: string,
    after: Record<string, number> = {},
  ): Promise<OpRow[]> {
    const { rows } = await this.pool.query(
      `SELECT actor_id, seq, hlc_wall, hlc_logical, data FROM ops
       WHERE board_id = $1 AND seq > COALESCE(($2::jsonb ->> actor_id)::int, 0)
       ORDER BY id`,
      [boardId, JSON.stringify(after)],
    );
    return rows.map((r) => ({
      actor: r.actor_id as string,
      seq: r.seq as number,
      wall: Number(r.hlc_wall),
      logical: r.hlc_logical as number,
      data: new Uint8Array(r.data as Buffer),
    }));
  }

  async saveSnapshot(boardId: string, state: Uint8Array): Promise<void> {
    await this.pool.query(
      "INSERT INTO snapshots (board_id, state) VALUES ($1,$2) ON CONFLICT (board_id) DO UPDATE SET state = EXCLUDED.state, created_at = now()",
      [boardId, Buffer.from(state)],
    );
  }

  async loadSnapshot(boardId: string): Promise<Uint8Array | null> {
    const { rows } = await this.pool.query(
      "SELECT state FROM snapshots WHERE board_id = $1",
      [boardId],
    );
    return rows.length === 0 ? null : new Uint8Array(rows[0].state as Buffer);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
