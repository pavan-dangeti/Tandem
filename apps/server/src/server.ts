import { createServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomBytes } from "node:crypto";
import { Doc, decodeOp, encodeOp } from "@tandem/crdt";
import type { Op } from "@tandem/crdt";
import {
  FRAME,
  MAX_FRAME,
  buildFrame,
  packOps,
  packSyncResponse,
  parseFrame,
  unpackOps,
} from "@tandem/protocol";
import { helloSchema, opSchema, presenceSchema } from "@tandem/protocol";
import {
  issueToken,
  verifyToken,
  verifyShareToken,
  hashPassword,
  checkPassword,
  newUserId,
  issueShareToken,
} from "./auth.js";
import { MemoryMetaStore, PostgresMetaStore, type MetaStore } from "./meta.js";
import { MemoryOpStore, PostgresOpStore, type OpStore } from "./store.js";
import { LocalBus, type Bus } from "./bus.js";
import { z } from "zod";

const te = new TextEncoder();
const td = new TextDecoder();
type Role = "viewer" | "editor" | "owner";

const MAX_INFLIGHT_BATCHES = 8;
const OPS_PER_SEC_LIMIT = 400;
const SNAPSHOT_EVERY = 2000;
const BOARD_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

interface Ctx {
  ws: WebSocket;
  userId: string;
  role: Role;
  oppWindowStart: number;
  opsThisWindow: number;
  inflight: number;
}

interface Session {
  doc: Doc;
  cacheDocJson: string;
  opsSinceSnapshot: number;
  loads: Promise<void> | null;
}

export interface ServerOptions {
  port?: number;
  databaseUrl?: string;
  metaStore?: MetaStore;
  store?: OpStore;
  /** cross-node fan-out; defaults to in-process fan-out for single-node runs */
  bus?: Bus;
  instanceId?: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(
  opts: ServerOptions = {},
): Promise<RunningServer> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const meta: MetaStore =
    opts.metaStore ??
    (databaseUrl ? new PostgresMetaStore(databaseUrl) : new MemoryMetaStore());
  const store: OpStore =
    opts.store ??
    (databaseUrl ? new PostgresOpStore(databaseUrl) : new MemoryOpStore());
  const bus: Bus = opts.bus ?? new LocalBus();
  await meta.init();
  await store.init();

  const sessions = new Map<string, Session>();
  const rooms = new Map<string, Set<Ctx>>();

  function broadcastOps(
    boardId: string,
    encoded: Uint8Array[],
    except: Ctx | null,
  ): void {
    if (encoded.length === 0) return;
    const frame = buildFrame(FRAME.OP_BATCH, packOps(encoded));
    for (const c of getRoom(boardId)) {
      if (c !== except) c.ws.send(frame);
    }
  }

  // Ops persisted by another node: apply to the local session and forward to the
  // local room. The publishing node already did both, and persistence there is
  // the source of truth, so subscribers never write to the log.
  await bus.subscribe((msg) => {
    if (msg.origin === bus.id) return;
    void (async () => {
      const session = await getSession(msg.boardId);
      for (const raw of msg.ops) {
        try {
          session.doc.applyRemote(decodeOp(raw));
        } catch {
          // a malformed fan-out message must not take the node down
        }
      }
      broadcastOps(msg.boardId, msg.ops, null);
    })();
  });

  async function getSession(boardId: string): Promise<Session> {
    let s = sessions.get(boardId);
    if (s) return s;
    s = {
      doc: new Doc(`srv:${boardId}`),
      cacheDocJson: "",
      opsSinceSnapshot: 0,
      loads: null,
    };
    sessions.set(boardId, s);
    s.loads = (async () => {
      const snap = await store.loadSnapshot(boardId);
      if (snap) {
        try {
          const ops = JSON.parse(td.decode(snap.state)) as Op[];
          for (const op of ops) s!.doc.applyRemote(op);
        } catch {
          // corrupt snapshot: fall back to full op log
        }
      }
      const rows = await store.loadOps(boardId);
      for (const r of rows) {
        try {
          s!.doc.applyRemote(decodeOp(r.data));
        } catch {
          // corrupt row: skip and continue
        }
      }
    })();
    await s.loads;
    return s;
  }

  async function snapshotSession(s: Session, boardId: string): Promise<void> {
    const ops = s.doc.opList;
    const json = JSON.stringify(ops);
    await store.saveSnapshot(boardId, te.encode(json), ops.length);
    s.opsSinceSnapshot = 0;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // The web client is served separately in development, so the API answers
      // preflights. Credentials are bearer tokens held in page memory, never
      // cookies, so a permissive origin is not a credential leak.
      const cors = process.env.ALLOWED_ORIGINS ?? "*";
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": cors,
          "access-control-allow-methods": "POST,GET,OPTIONS",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-max-age": "600",
        });
        res.end();
        return;
      }
      res.setHeader("access-control-allow-origin", cors);
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const authed = async (): Promise<{ userId: string } | null> => {
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
        if (!token) return null;
        const uid = await verifyToken(token);
        return uid ? { userId: uid } : null;
      };

      if (req.method === "GET" && url.pathname === "/healthz") {
        json(200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        try {
          await meta.getBoard("__probe__");
          json(200, { ok: true });
        } catch {
          json(503, { ok: false });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth/register") {
        const body = z
          .object({
            email: z.string().email(),
            password: z.string().min(8).max(256),
          })
          .safeParse(await readJson(req));
        if (!body.success) return json(400, { error: "invalid" });
        if (await meta.getUserByEmail(body.data.email))
          return json(409, { error: "exists" });
        const userId = newUserId();
        await meta.createUser(
          userId,
          body.data.email,
          await hashPassword(body.data.password),
        );
        json(200, { userId, token: await issueToken(userId) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth/login") {
        const body = z
          .object({ email: z.string().email(), password: z.string().min(1) })
          .safeParse(await readJson(req));
        if (!body.success) return json(400, { error: "invalid" });
        const user = await meta.getUserByEmail(body.data.email);
        if (
          !user ||
          !(await checkPassword(body.data.password, user.passwordHash))
        )
          return json(401, { error: "bad credentials" });
        json(200, { userId: user.id, token: await issueToken(user.id) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/boards") {
        const a = await authed();
        if (!a) return json(401, {});
        const boardId = randomBytes(6).toString("hex");
        await meta.createBoard(boardId, a.userId);
        await meta.addMember(boardId, a.userId, "owner");
        json(200, { boardId });
        return;
      }
      if (
        req.method === "POST" &&
        url.pathname.match(/^\/boards\/[^/]+\/members$/)
      ) {
        const a = await authed();
        if (!a) return json(401, {});
        const boardId = url.pathname.split("/")[2]!;
        const role = await meta.getMemberRole(boardId, a.userId);
        if (role !== "owner") return json(403, { error: "owner only" });
        const body = z
          .object({
            email: z.string().email(),
            role: z.enum(["owner", "editor", "viewer"]),
          })
          .safeParse(await readJson(req));
        if (!body.success) return json(400, { error: "invalid" });
        const user = await meta.getUserByEmail(body.data.email);
        if (!user) return json(404, { error: "user not found" });
        await meta.addMember(boardId, user.id, body.data.role);
        json(200, { ok: true });
        return;
      }
      if (
        req.method === "POST" &&
        url.pathname.match(/^\/boards\/[^/]+\/share$/)
      ) {
        const a = await authed();
        if (!a) return json(401, {});
        const boardId = url.pathname.split("/")[2]!;
        const role = await meta.getMemberRole(boardId, a.userId);
        if (role !== "owner") return json(403, { error: "owner only" });
        const body = z
          .object({
            role: z.enum(["editor", "viewer"]),
            ttlSeconds: z.number().int().min(60).max(2592000),
          })
          .safeParse(await readJson(req));
        if (!body.success) return json(400, { error: "invalid" });
        const token = issueShareToken(
          body.data.role,
          boardId,
          body.data.ttlSeconds,
        );
        json(200, { token });
        return;
      }
      json(404, { error: "not_found" });
    })().catch((err) => {
      console.error(JSON.stringify({ msg: "http_error", err: String(err) }));
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    const close = (reason = "closed"): void => {
      try {
        ws.close(1000, reason);
      } catch {
        /* noop */
      }
    };
    let ctx: Ctx | null = null;
    let roomRoom: Set<Ctx> | null = null;
    let boardIdOf: string | null = null;
    const helloTimer = setTimeout(() => {
      if (!ctx) {
        sendError(ws, "timeout", "hello required within 2s");
        close();
      }
    }, 2000);

    ws.on("message", (data: RawData) => {
      void (async () => {
        const dataBuf = data as Buffer;
        if (dataBuf.length > MAX_FRAME) {
          sendError(ws, "too_large", "frame exceeds 1MB");
          close();
          return;
        }
        const parsed = parseFrame(new Uint8Array(data as Buffer));
        if (!parsed) {
          sendError(ws, "bad_frame", "unparseable frame");
          return;
        }
        if (!ctx) {
          if (parsed.type !== FRAME.HELLO) {
            sendError(ws, "hello_first", "first frame must be Hello");
            return;
          }
          const helloText = td.decode(parsed.payload);
          const hello = helloSchema.safeParse(JSON.parse(helloText));
          if (!hello.success) {
            sendError(ws, "bad_hello", "invalid hello payload");
            return;
          }
          const { token, boardId, stateVector } = hello.data;
          if (!BOARD_ID_RE.test(boardId)) {
            sendError(ws, "bad_board_id", "invalid board id");
            return;
          }
          // derive identity
          let userId: string;
          let role: Role;
          const share = verifyShareToken(token, boardId);
          if (share) {
            role = share.role;
            userId = `guest-${share.role}-${randomBytes(4).toString("hex")}`;
          } else {
            const verifiedId = await verifyToken(token);
            if (!verifiedId) {
              sendError(ws, "auth", "invalid token");
              close();
              return;
            }
            const memberRole = await meta.getMemberRole(boardId, verifiedId);
            if (!memberRole) {
              sendError(ws, "forbidden", "not a board member");
              close();
              return;
            }
            role = memberRole as Role;
            userId = verifiedId;
          }
          const session = await getSession(boardId);
          const missing = session.doc.missingSince(
            new Map(Object.entries(stateVector)),
          );
          const sv = Object.fromEntries(session.doc.stateVector());
          const payload = packSyncResponse(
            sv,
            missing.map((op) => encodeOp(op)),
          );
          ws.send(buildFrame(FRAME.SYNC_RESPONSE, payload));

          ctx = {
            ws,
            userId,
            role,
            oppWindowStart: Date.now(),
            opsThisWindow: 0,
            inflight: 0,
          };
          roomRoom = getRoom(boardId);
          roomRoom.add(ctx);
          boardIdOf = boardId;
          if (helloTimer) clearTimeout(helloTimer);
          return;
        }
        // steady state
        switch (parsed.type) {
          case FRAME.OP_BATCH: {
            handleOpBatch(ctx, boardIdOf!, parsed.payload);
            break;
          }
          case FRAME.PRESENCE: {
            handlePresence(ctx, boardIdOf!, parsed.payload);
            break;
          }
          default:
            sendError(
              ws,
              "unexpected_type",
              `frame type ${parsed.type} unexpected`,
            );
        }
      })().catch((err) => {
        console.error(
          JSON.stringify({
            msg: "ws_handler_error",
            err: String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }),
        );
        sendError(ws, "internal", String(err));
      });
    });

    ws.on("close", () => {
      if (ctx && roomRoom) roomRoom.delete(ctx);
      if (helloTimer) clearTimeout(helloTimer);
    });
  });

  function sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(
      buildFrame(FRAME.ERROR, te.encode(JSON.stringify({ code, message }))),
    );
  }

  function getRoom(boardId: string): Set<Ctx> {
    let r = rooms.get(boardId);
    if (!r) rooms.set(boardId, (r = new Set()));
    return r;
  }

  function handleOpBatch(ctx: Ctx, boardId: string, payload: Uint8Array): void {
    if (ctx.inflight >= MAX_INFLIGHT_BATCHES) {
      sendError(ctx.ws, "backpressure", "too many in-flight batches");
      return;
    }
    let opsBytes: Uint8Array[];
    try {
      opsBytes = unpackOps(payload);
    } catch {
      sendError(ctx.ws, "bad_batch", "unpack failed");
      return;
    }
    const rateWindow = 1000;
    const now = Date.now();
    if (now - ctx.oppWindowStart > rateWindow) {
      ctx.oppWindowStart = now;
      ctx.opsThisWindow = 0;
    }
    if (ctx.opsThisWindow + opsBytes.length > OPS_PER_SEC_LIMIT) {
      sendError(
        ctx.ws,
        "rate_limit",
        `rate limit ${OPS_PER_SEC_LIMIT} ops/sec`,
      );
      return;
    }
    // validate + enforce viewer rejection
    const parsedOps: Op[] = [];
    for (const o of opsBytes) {
      if (ctx.role === "viewer") {
        sendError(ctx.ws, "forbidden", "viewers cannot send operations");
        return;
      }
      try {
        const op = decodeOp(o);
        opSchema.parse(op);
        if (op.actor !== ctx.userId) {
          sendError(ctx.ws, "bad_actor", "op actor must equal session user");
          return;
        }
        parsedOps.push(op);
      } catch {
        sendError(ctx.ws, "bad_op", "op failed schema validation");
        return;
      }
    }
    ctx.opsThisWindow += opsBytes.length;
    ctx.inflight++;
    void (async () => {
      try {
        const session = await getSession(boardId);
        const applied: Op[] = [];
        for (const op of parsedOps) {
          if (session.doc.applyRemote(op)) applied.push(op);
        }
        if (applied.length > 0) {
          const encoded = applied.map((op) => encodeOp(op));
          // Durable first, then fan out: an ack means the op survived a crash.
          await store.appendOps(
            boardId,
            applied.map((op, i) => ({
              actor: op.actor,
              seq: op.seq,
              wall: op.wall,
              logical: op.logical,
              data: encoded[i]!,
            })),
          );
          session.opsSinceSnapshot += applied.length;
          if (session.opsSinceSnapshot >= SNAPSHOT_EVERY) {
            await snapshotSession(session, boardId);
          }
          broadcastOps(boardId, encoded, ctx);
          // The rows are durable at this point, so a fan-out failure must not
          // withhold the ack: clients reconnect and repair via state vector.
          await bus
            .publish({ origin: bus.id, boardId, ops: encoded })
            .catch((err: unknown) => {
              console.error(
                JSON.stringify({
                  msg: "fanout_publish_failed",
                  boardId,
                  err: String(err),
                }),
              );
            });
        }
        // ack
        ctx.ws.send(
          buildFrame(
            FRAME.ACK,
            te.encode(
              JSON.stringify({
                batchId: batchIdOf(payload),
                applied: applied.length,
                stateVector: Object.fromEntries(session.doc.stateVector()),
              }),
            ),
          ),
        );
      } finally {
        ctx.inflight--;
      }
    })().catch((err) => {
      console.error(
        JSON.stringify({ msg: "batch_handler_error", err: String(err) }),
      );
    });
  }

  function batchIdOf(payload: Uint8Array): string {
    return createHashHex(payload);
  }

  function handlePresence(
    ctx: Ctx,
    boardId: string,
    payload: Uint8Array,
  ): void {
    try {
      const msg = presenceSchema.parse(JSON.parse(td.decode(payload)));
      const frame = buildFrame(FRAME.PRESENCE, te.encode(JSON.stringify(msg)));
      for (const c of getRoom(boardId)) {
        if (c !== ctx) c.ws.send(frame);
      }
    } catch {
      sendError(ctx.ws, "bad_presence", "presence failed schema validation");
    }
  }

  function getRoomSetForClose(): void {
    // used at shutdown
    for (const room of rooms.values()) for (const c of room) c.ws.close();
  }

  const port = typeof opts.port === "number" ? opts.port : initialisePort();
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        close: async () => {
          getRoomSetForClose();
          await bus.close();
          await new Promise<void>((res) =>
            wss.close(() => server.close(() => res())),
          );
        },
      });
    });
  });
}

function initialisePort(): number {
  const p = process.env.PORT;
  return p ? Number(p) : 8080;
}

async function readJson(
  req: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

function createHashHex(data: Uint8Array): string {
  let h = 5381;
  for (const b of data) h = ((h << 5) + h + b) | 0;
  return (h >>> 0).toString(16);
}
