import pg from "pg";

export interface OpStore {
  init(): Promise<void>;
  appendOps(
    boardId: string,
    ops: {
      actor: string;
      seq: number;
      wall: number;
      logical: number;
      data: Uint8Array;
    }[],
  ): Promise<void>;
  loadOps(boardId: string): Promise<
    {
      actor: string;
      seq: number;
      wall: number;
      logical: number;
      data: Uint8Array;
    }[]
  >;
  saveSnapshot(
    boardId: string,
    state: Uint8Array,
    opsUpTo: number,
  ): Promise<void>;
  loadSnapshot(
    boardId: string,
  ): Promise<{ state: Uint8Array; opsUpTo: number } | null>;
  close(): Promise<void>;
}

export class MemoryOpStore implements OpStore {
  private ops = new Map<
    string,
    {
      actor: string;
      seq: number;
      wall: number;
      logical: number;
      data: Uint8Array;
    }[]
  >();
  private snapshots = new Map<string, { state: Uint8Array; opsUpTo: number }>();

  async init(): Promise<void> {
    /* noop */
  }
  async appendOps(
    boardId: string,
    ops: {
      actor: string;
      seq: number;
      wall: number;
      logical: number;
      data: Uint8Array;
    }[],
  ): Promise<void> {
    const list = this.ops.get(boardId) ?? [];
    list.push(...ops);
    this.ops.set(boardId, list);
  }
  async loadOps(boardId: string): Promise<
    {
      actor: string;
      seq: number;
      wall: number;
      logical: number;
      data: Uint8Array;
    }[]
  > {
    return [...(this.ops.get(boardId) ?? [])];
  }
  async saveSnapshot(
    boardId: string,
    state: Uint8Array,
    opsUpTo: number,
  ): Promise<void> {
    this.snapshots.set(boardId, { state, opsUpTo });
  }
  async loadSnapshot(
    boardId: string,
  ): Promise<{ state: Uint8Array; opsUpTo: number } | null> {
    return this.snapshots.get(boardId) ?? null;
  }
  async close(): Promise<void> {
    /* noop */
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
  ops_up_to BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

export class PostgresOpStore implements OpStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  async appendOps(
    boardId: string,
    ops: {
      actor: string;
      seq: number;
      wall: number;
      logical: number;
      data: Uint8Array;
    }[],
  ): Promise<void> {
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

  async loadOps(boardId: string): Promise<
    {
      actor: string;
      seq: number;
      wall: number;
      logical: number;
      data: Uint8Array;
    }[]
  > {
    const { rows } = await this.pool.query(
      "SELECT actor_id, seq, hlc_wall, hlc_logical, data FROM ops WHERE board_id = $1 ORDER BY id",
      [boardId],
    );
    return rows.map((r) => ({
      actor: r.actor_id as string,
      seq: r.seq as number,
      wall: Number(r.hlc_wall),
      logical: r.hlc_logical as number,
      data: new Uint8Array(r.data as Buffer),
    }));
  }

  async saveSnapshot(
    boardId: string,
    state: Uint8Array,
    opsUpTo: number,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO snapshots (board_id, state, ops_up_to) VALUES ($1,$2,$3) ON CONFLICT (board_id) DO UPDATE SET state = EXCLUDED.state, ops_up_to = EXCLUDED.ops_up_to, created_at = now()",
      [boardId, Buffer.from(state), opsUpTo],
    );
  }

  async loadSnapshot(
    boardId: string,
  ): Promise<{ state: Uint8Array; opsUpTo: number } | null> {
    const { rows } = await this.pool.query(
      "SELECT state, ops_up_to FROM snapshots WHERE board_id = $1",
      [boardId],
    );
    if (rows.length === 0) return null;
    return {
      state: new Uint8Array(rows[0].state as Buffer),
      opsUpTo: Number(rows[0].ops_up_to),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
