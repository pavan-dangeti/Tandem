import pg from "pg";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export interface MetaStore {
  init(): Promise<void>;
  createUser(id: string, email: string, passwordHash: string): Promise<void>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  createBoard(id: string, ownerId: string): Promise<void>;
  getBoard(id: string): Promise<{ id: string; ownerId: string } | null>;
  addMember(boardId: string, userId: string, role: string): Promise<void>;
  getMemberRole(boardId: string, userId: string): Promise<string | null>;
  close(): Promise<void>;
}

export class MemoryMetaStore implements MetaStore {
  private users: User[] = [];
  private boards: { id: string; ownerId: string }[] = [];
  private members: { boardId: string; userId: string; role: string }[] = [];

  async init(): Promise<void> {
    /* noop */
  }
  async createUser(
    id: string,
    email: string,
    passwordHash: string,
  ): Promise<void> {
    this.users.push({ id, email, passwordHash });
  }
  async getUserByEmail(email: string): Promise<User | null> {
    return this.users.find((u) => u.email === email) ?? null;
  }
  async getUserById(id: string): Promise<User | null> {
    return this.users.find((u) => u.id === id) ?? null;
  }
  async createBoard(id: string, ownerId: string): Promise<void> {
    this.boards.push({ id, ownerId });
  }
  async getBoard(id: string): Promise<{ id: string; ownerId: string } | null> {
    return this.boards.find((b) => b.id === id) ?? null;
  }
  async addMember(
    boardId: string,
    userId: string,
    role: string,
  ): Promise<void> {
    const m = this.members.find(
      (m) => m.boardId === boardId && m.userId === userId,
    );
    if (m) m.role = role;
    else this.members.push({ boardId, userId, role });
  }
  async getMemberRole(boardId: string, userId: string): Promise<string | null> {
    const m = this.members.find(
      (m) => m.boardId === boardId && m.userId === userId,
    );
    return m?.role ?? null;
  }
  async close(): Promise<void> {
    /* noop */
  }
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT REFERENCES boards(id),
  user_id TEXT REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS share_tokens (
  token_id TEXT PRIMARY KEY,
  board_id TEXT REFERENCES boards(id),
  role TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

export class PostgresMetaStore implements MetaStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  async createUser(
    id: string,
    email: string,
    passwordHash: string,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)",
      [id, email, passwordHash],
    );
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      "SELECT id, email, password_hash FROM users WHERE email = $1",
      [email],
    );
    return rows[0]
      ? {
          id: rows[0].id,
          email: rows[0].email,
          passwordHash: rows[0].password_hash,
        }
      : null;
  }

  async getUserById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      "SELECT id, email, password_hash FROM users WHERE id = $1",
      [id],
    );
    return rows[0]
      ? {
          id: rows[0].id,
          email: rows[0].email,
          passwordHash: rows[0].password_hash,
        }
      : null;
  }

  async createBoard(id: string, ownerId: string): Promise<void> {
    await this.pool.query("INSERT INTO boards (id, owner_id) VALUES ($1,$2)", [
      id,
      ownerId,
    ]);
  }

  async getBoard(id: string): Promise<{ id: string; ownerId: string } | null> {
    const { rows } = await this.pool.query(
      "SELECT id, owner_id FROM boards WHERE id = $1",
      [id],
    );
    return rows[0] ? { id: rows[0].id, ownerId: rows[0].owner_id } : null;
  }

  async addMember(
    boardId: string,
    userId: string,
    role: string,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO board_members (board_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role",
      [boardId, userId, role],
    );
  }

  async getMemberRole(boardId: string, userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2",
      [boardId, userId],
    );
    return rows[0]?.role ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
