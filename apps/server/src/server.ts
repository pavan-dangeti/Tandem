import { createServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomBytes, randomUUID } from "node:crypto";
import { Doc, decodeOp, encodeOp } from "@tandem/crdt";
import type { Op } from "@tandem/crdt";
import {
  FRAME,
  MAX_FRAME,
  buildFrame,
  packOps,
  helloSchema,
  opSchema,
  packSyncResponse,
  parseFrame,
  presenceSchema,
  unpackOps,
  unpackSyncResponse,
} from "@tandem/protocol";
import {
  issueToken,
  verifyToken,
  verifyShareToken,
  hashPassword,
  checkPassword,
  newUserId,
  issueShareToken,
  issueDeviceToken,
  verifyDeviceToken,
} from "./auth.js";
import { MemoryMetaStore, PostgresMetaStore, type MetaStore } from "./meta.js";
import { MemoryOpStore, PostgresOpStore, type OpStore } from "./store.js";
import { LocalBus, type Bus } from "./bus.js";
import {
  batchOps,
  fanoutLatency,
  opsApplied,
  opsReceived,
  registry,
  wsConnections,
  wsConnectionsTotal,
  snapshotSize,
  httpDuration,
  httpRequests,
  opLogWrite,
  opsRejected,
} from "./metrics.js";
import { inSpan } from "./trace.js";
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
  connId: string;
  userId: string;
  role: Role;
  oppWindowStart: number;
  opsThisWindow: number;
  inflight: number;
}

interface Session {
  doc: Doc;
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
  /** how often active boards pull missed ops from the log */
  reconcileMs?: number;
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
  // Without Redis, fan-out stays in this process, which is only right for one node.
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
      opsSinceSnapshot: 0,
      loads: null,
    };
    sessions.set(boardId, s);
    s.loads = (async () => {
      // snapshot (compacted ops + the state vector they cover), then only the
      // log rows beyond that vector
      let covered: Record<string, number> = {};
      const snap = await store.loadSnapshot(boardId);
      if (snap) {
        try {
          const { stateVector, ops } = unpackSyncResponse(snap);
          for (const raw of ops) s!.doc.applyRemote(decodeOp(raw));
          s!.doc.markSeen(new Map(Object.entries(stateVector)));
          covered = stateVector;
        } catch {
          // unreadable snapshot: the full log alone rebuilds the board
        }
      }
      const rows = await store.loadOps(boardId, covered);
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
    const state = packSyncResponse(
      Object.fromEntries(s.doc.stateVector()),
      s.doc.compactOps().map((op) => encodeOp(op)),
    );
    snapshotSize.observe(state.byteLength);
    await store.saveSnapshot(boardId, state);
    s.opsSinceSnapshot = 0;
  }

  const server = createServer((req, res) => {
    const header = req.headers["x-request-id"];
    const requestId =
      typeof header === "string" && /^[\w-]{1,64}$/.test(header)
        ? header
        : randomUUID();
    res.setHeader("x-request-id", requestId);
    const started = performance.now();
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
      // The API serves JSON and a WebSocket upgrade only; no HTML, no framing,
      // no referrer leakage, and no inline script anywhere in this process.
      res.setHeader(
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'",
      );
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("cross-origin-resource-policy", "same-site");
      const json = (code: number, body: unknown): void => {
        const route = routeOf(url.pathname);
        const ms = performance.now() - started;
        httpRequests.inc({ route, status: String(code) });
        httpDuration.observe({ route }, ms);
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        console.log(
          JSON.stringify({
            msg: "http",
            requestId,
            method: req.method,
            route,
            status: code,
            ms: Math.round(ms),
          }),
        );
      };
      if (url.pathname.startsWith("/auth/") && !authAllowed(clientIp(req)))
        return json(429, { error: "rate_limit" });
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
      if (req.method === "GET" && url.pathname === "/metrics") {
        res.setHeader("content-type", registry.contentType);
        res.end(await registry.metrics());
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
        // Hash before the lookup and answer a taken email like a malformed
        // request, so neither the response nor its timing reveals accounts.
        const hash = await hashPassword(body.data.password);
        if (await meta.getUserByEmail(body.data.email))
          return json(400, { error: "invalid" });
        const userId = newUserId();
        await meta.createUser(userId, body.data.email, hash);
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
      const tooLarge = err instanceof PayloadTooLarge;
      if (!tooLarge)
        console.error(
          JSON.stringify({ msg: "http_error", requestId, err: String(err) }),
        );
      const code = tooLarge ? 413 : 500;
      httpRequests.inc({ route: routeOf(req.url ?? ""), status: String(code) });
      res.writeHead(code, {
        "content-type": "application/json",
        connection: "close",
      });
      res.end(JSON.stringify({ error: tooLarge ? "too_large" : "internal" }));
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
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
    const connId = randomUUID();
    // ws reports protocol violations (an oversize frame, bad framing) as an
    // error event and closes the socket itself; unhandled, it would crash the node.
    ws.on("error", (err) => {
      console.error(
        JSON.stringify({ msg: "ws_error", connId, err: String(err) }),
      );
    });
    const close = (reason = "closed"): void => {
      try {
        ws.close(1000, reason);
      } catch {
        /* noop */
      }
    };
    let ctx: Ctx | null = null;
    let room: Set<Ctx> | null = null;
    let boardIdOf: string | null = null;
    const helloTimer = setTimeout(() => {
      if (!ctx) {
        sendError(ws, "timeout", "hello required within 2s");
        close();
      }
    }, 2000);

    ws.on("message", (data: RawData) => {
      void (async () => {
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
          let base: string;
          let role: Role;
          const share = verifyShareToken(token, boardId);
          if (share) {
            role = share.role;
            base = share.actorId;
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
            base = verifiedId;
          }
          let userId = base;
          let device: string | undefined;
          if (hello.data.device !== undefined) {
            const kept = verifyDeviceToken(base, hello.data.device);
            const minted = kept === null ? issueDeviceToken(base) : null;
            device = minted ? minted.token : hello.data.device;
            userId = `${base}-${kept ?? minted!.suffix}`;
          }
          const session = await getSession(boardId);
          const missing = session.doc.missingSince(
            new Map(Object.entries(stateVector)),
          );
          const sv = Object.fromEntries(session.doc.stateVector());
          const payload = packSyncResponse(
            sv,
            missing.map((op) => encodeOp(op)),
            userId,
            device,
          );
          ws.send(buildFrame(FRAME.SYNC_RESPONSE, payload));

          ctx = {
            ws,
            connId,
            userId,
            role,
            oppWindowStart: Date.now(),
            opsThisWindow: 0,
            inflight: 0,
          };
          room = getRoom(boardId);
          room.add(ctx);
          boardIdOf = boardId;
          if (helloTimer) clearTimeout(helloTimer);
          return;
        }
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
            connId,
            err: String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }),
        );
        sendError(ws, "internal", "internal error");
      });
    });

    wsConnections.inc();
    wsConnectionsTotal.inc();
    ws.on("close", () => {
      wsConnections.dec();
      if (ctx && room) room.delete(ctx);
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
      opsRejected.inc({ reason: "bad_batch" });
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
    const parsedOps: Op[] = [];
    for (const o of opsBytes) {
      if (ctx.role === "viewer") {
        opsRejected.inc({ reason: "viewer" });
        sendError(ctx.ws, "forbidden", "viewers cannot send operations");
        return;
      }
      try {
        const op = decodeOp(o);
        opSchema.parse(op);
        if (op.actor !== ctx.userId) {
          opsRejected.inc({ reason: "bad_actor" });
          sendError(ctx.ws, "bad_actor", "op actor must equal session user");
          return;
        }
        parsedOps.push(op);
      } catch {
        opsRejected.inc({ reason: "bad_op" });
        sendError(ctx.ws, "bad_op", "op failed schema validation");
        return;
      }
    }
    ctx.opsThisWindow += opsBytes.length;
    ctx.inflight++;
    opsReceived.inc(opsBytes.length);
    batchOps.observe(opsBytes.length);
    const batchStartedAt = performance.now();
    void inSpan(
      "batch.apply",
      { "board.id": boardId, "ops.count": parsedOps.length },
      async () => {
        try {
          const session = await getSession(boardId);
          const applied: Op[] = [];
          for (const op of parsedOps) {
            if (session.doc.applyRemote(op)) applied.push(op);
          }
          if (applied.length > 0) {
            const encoded = applied.map((op) => encodeOp(op));
            opsApplied.inc(applied.length);
            // Durable first, then fan out: an ack means the op survived a crash.
            const writeTimer = opLogWrite.startTimer();
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
            writeTimer();
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
            fanoutLatency.observe(performance.now() - batchStartedAt);
          }
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
      },
    ).catch((err) => {
      console.error(
        JSON.stringify({
          msg: "batch_handler_error",
          connId: ctx.connId,
          boardId,
          err: String(err),
        }),
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
      // the sender is whoever this connection authenticated as, never what
      // the client claims
      const msg = {
        ...presenceSchema.parse(JSON.parse(td.decode(payload))),
        userId: ctx.userId,
      };
      const frame = buildFrame(FRAME.PRESENCE, te.encode(JSON.stringify(msg)));
      for (const c of getRoom(boardId)) {
        if (c !== ctx) c.ws.send(frame);
      }
    } catch {
      sendError(ctx.ws, "bad_presence", "presence failed schema validation");
    }
  }

  // Redis pub/sub is at-most-once: a lost fan-out message would leave this
  // node's cached board, and the clients on it, behind until a restart. The op
  // log is the source of truth, so boards with clients here pull what they lack.
  async function reconcile(): Promise<void> {
    for (const [boardId, room] of rooms) {
      const session = sessions.get(boardId);
      if (room.size === 0 || !session) continue;
      const rows = await store.loadOps(
        boardId,
        Object.fromEntries(session.doc.stateVector()),
      );
      const fresh = rows
        .map((r) => r.data)
        .filter((raw) => session.doc.applyRemote(decodeOp(raw)));
      broadcastOps(boardId, fresh, null);
    }
  }
  const reconcileTimer = setInterval(() => {
    reconcile().catch((err: unknown) =>
      console.error(
        JSON.stringify({ msg: "reconcile_failed", err: String(err) }),
      ),
    );
  }, opts.reconcileMs ?? 5000);

  const port = typeof opts.port === "number" ? opts.port : initialisePort();
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        close: async () => {
          clearInterval(reconcileTimer);
          for (const room of rooms.values()) for (const c of room) c.ws.close();
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

class PayloadTooLarge extends Error {}

const MAX_BODY = 64 * 1024;

async function readJson(
  req: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new PayloadTooLarge();
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

// Metric labels must come from a fixed set: raw paths would let any client
// create unbounded time series.
const ROUTES = new Set([
  "/healthz",
  "/readyz",
  "/metrics",
  "/auth/register",
  "/auth/login",
  "/boards",
]);

function routeOf(path: string): string {
  const p = path.split("?")[0]!;
  if (ROUTES.has(p)) return p;
  const m = /^\/boards\/[^/]+\/(members|share)$/.exec(p);
  return m ? `/boards/:id/${m[1]}` : "other";
}

// Behind the deploy's reverse proxy every request arrives from the proxy, so
// with TRUST_PROXY the client is the last X-Forwarded-For hop (the one the
// proxy added; earlier hops are client-controlled).
function clientIp(req: import("node:http").IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (process.env.TRUST_PROXY && typeof fwd === "string")
    return fwd.split(",").at(-1)!.trim();
  return req.socket.remoteAddress ?? "";
}

// Password hashing is deliberately slow, so /auth/* is limited per address.
// Loopback is this machine (tests, benchmarks, local development).
const AUTH_PER_MINUTE = 20;
const authWindows = new Map<string, { start: number; count: number }>();

function authAllowed(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")
    return true;
  const now = Date.now();
  if (authWindows.size > 10_000)
    for (const [k, w] of authWindows)
      if (now - w.start > 60_000) authWindows.delete(k);
  const w = authWindows.get(ip);
  if (!w || now - w.start > 60_000) {
    authWindows.set(ip, { start: now, count: 1 });
    return true;
  }
  return ++w.count <= AUTH_PER_MINUTE;
}

function createHashHex(data: Uint8Array): string {
  let h = 5381;
  for (const b of data) h = ((h << 5) + h + b) | 0;
  return (h >>> 0).toString(16);
}
