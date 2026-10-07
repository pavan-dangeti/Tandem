# Tandem — Design Document

## Context

Tandem is a real-time collaborative whiteboard: multiple users edit the same
board simultaneously, see each other's cursors and selections live, keep
working offline, and merge automatically on reconnect with every replica
guaranteed to converge to the same state. It is a small multiplayer engine in
the spirit of Figma or Google Docs.

## Goals

- Shapes: rectangle, ellipse, line, arrow, text, sticky note, freehand.
- Selection, move, resize, z-order, per-user undo/redo.
- Live presence: cursors, selections, participant list.
- Offline editing with automatic merge on reconnect.
- Permissions: owner / editor / viewer, signed share links.
- Horizontal scaling of the sync tier across server nodes.

## Non-goals

- Voice/video, enterprise SSO, rich-text formatting.
- Server-side rendering of boards, board templates, comments.

## Requirements and SLOs

- R1. Any edit applies locally in < 16 ms (one frame).
- R2. p95 edit-to-remote propagation < 300 ms for up to 50 concurrent editors
  on a single board (same region); p99 < 1 s.
- R3. After any partition, all replicas converge to identical state once
  delivery resumes (verified by property-based and chaos tests).
- R4. Board load time < 2 s for boards with up to 100k operations of history
  (snapshot + recent ops).
- R5. An acknowledged operation is never lost, including server crash mid-batch.
- R6. Viewers cannot emit operations; enforced server-side, not just in UI.
- R7. Presence updates are ephemeral and never persisted.
- R8. The sync payload is a compact binary encoding; bytes per operation are
  reported in the README from a committed benchmark.

## Design

### CRDT core (`packages/crdt`, zero runtime dependencies)

- Each shape is an object with a set of properties. Each property is a
  last-writer-wins (LWW) register keyed by (value, hybrid logical clock,
  actor id). Ties break on actor id for determinism.
- Ordered collections (z-order list, text runs) use a sequence CRDT built on
  RGA-style identifiers; see ADR 0001 for the Fugue-vs-RGA decision.
- Deletes use tombstones; a property is removed only by tombstoning it.
- State vectors (actor → max sequence) summarize local state; a replica
  requests only missing operations (delta sync).
- Garbage collection: once an operation is causally stable (acknowledged by
  every known actor at or past its position), its tombstone may be dropped.
- Local-first: every local edit is an operation applied to the local replica
  and persisted to IndexedDB immediately, then synced in the background.

### Sync protocol (versioned; `docs/protocol.md`)

1. Client connects over WebSocket, sends `Hello { protocolVersion, boardId,
authToken, stateVector }`.
2. Server validates auth + role, then sends `SyncResponse { missingOps }`
   computed from the state vector; nothing else is replayed.
3. Steady state: batched `OpBatch` messages, `Ack` messages (per batch,
   per-op offsets), client-side backpressure (server stops sending when
   > N unacked ops in flight), and separate ephemeral `Presence` messages
   > (cursor, selection, display name, color) that are never persisted.
4. Encoding: a small custom binary format (varint-framed messages, compact
   op structure), with bytes/op reported by the benchmark harness.

### Server (`apps/server`, Node.js + TypeScript)

- Stateless relay apart from an in-memory board cache (recently active
  boards). Any node can serve any client.
- Every operation is auth-checked (role ≥ editor), schema-validated, size
  and rate-limited, persisted to the op log, then fanned out.
- Cross-node fan-out via Redis pub/sub: a client on node A emits an op,
  node A publishes to the board's channel, all nodes forward to their local
  subscribers.
- Health (`/healthz`) and readiness (`/readyz`) endpoints; Prometheus
  metrics at `/metrics`; structured JSON logs with request IDs; OTel
  tracing across the pub/sub hop.

### Persistence

- PostgreSQL: `boards(id, owner_id, created_at)`,
  `board_members(board_id, user_id, role)`,
  `share_tokens(token_id, board_id, role, expires_at, signature)`,
  `ops(board_id, seq, actor_id, hlc, payload, created_at)` append-only,
  `snapshots(board_id, seq, state, created_at)`.
- Snapshot every N ops (default 5,000) or T minutes, whichever first;
  loading a board = latest snapshot + ops since snapshot seq.
- Compaction: after a snapshot is durable, ops below its seq can be archived
  and tombstones GC'd once causally stable.

### Client (`apps/web`, React + TypeScript, canvas)

- Canvas renderer for shapes, selection box, live cursors of remote users.
- Tools: select, rectangle, ellipse, line, arrow, text, sticky, freehand.
- Undo/redo is per-user: undo appends the inverse operations of that user's
  own last batch, localized to local replicas.
- Edits apply to the local CRDT instantly, persist to IndexedDB, and sync in
  the background; reconnect resumes with the state vector.

### Sync protocol (`packages/protocol`, shared by server and client)

- Framing (`[u8 type][u32be length][payload]`), op packing, and the zod
  schemas for every message live in `packages/protocol` so the browser and the
  server cannot drift. `docs/protocol.md` is the normative description.

### Auth and permissions

- Email/password or OAuth (provider-agnostic interface; v1 ships email +
  password with bcrypt). Board memberships carry roles.
- Share links: `/b/<boardId>?token=<signed>`; the token carries role,
  expiry, and an HMAC signature (server secret in env). Viewers' messages
  are rejected before authz even reaches persistence.

### Hosting plan (free tiers only)

- **Proposal:** one Oracle Cloud Always Free VM (4 OCPU / 24 GB Ampere ARM —
  the M5 Mac dev box mirrors it). Docker Compose runs the sync server,
  Postgres, and Redis. The web client is a static build served from the same
  VM or Vercel free tier. `wss://` via a reverse proxy with Let's Encrypt.
- Alternatives considered: Render free web service + Neon Postgres + Upstash
  Redis (simpler, but Render free instances sleep and idle shutdowns break
  WebSocket fan-out latency; Neon free tier pauses compute). Rejected for v1;
  documented so the trade-off is explicit.
- Cost: $0. All model calls for development tooling use the free keys in
  `.env`.

## Alternatives considered

- **Operational Transformation (OT):** requires a central serialization
  point and transform functions per operation pair; complexity and edge-case
  bugs historically. CRDTs give convergence without a sequencer.
- **Use Yjs directly:** Yjs is excellent and battle-tested; using it
  directly loses the "implement and defend an engine" requirement of the
  project and hides the interesting engineering. We instead implement our
  own core, benchmark it honestly against Yjs and Automerge, and report
  where we lose.
- **Automerge-style columnar encoding:** strong compression; our simpler
  framing is chosen first for auditability, with encoded-size benchmarks to
  justify future changes.

## Data model sketch

```
Actor:    { id: string }
HLC:      { wallMs: number, logical: number, actorId: string }
Op:       { id, boardId, actorId, hlc, type: Put|Delete|Insert|Remove,
            target: { objId, key? | positionId? }, value? , parent?: {boardVersion} }
Object:   { id, type: 'rect'|'ellipse'|'line'|'arrow'|'text'|'sticky'|'freehand',
            props: Map<string, LWWRegister<T>> }
Board:    { id, objects: Map<id, Object>, order: SeqCRDT<ObjectId>, text: SeqCRDT<char> }
StateVector: Map<ActorId, number>
```

## Threat model

| Threat                      | Mitigation                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| Malformed/oversized ops     | Schema validation, per-message size cap (64 KiB), per-op target size cap   |
| Viewer emits ops            | Server-side role check before validation/persist; rejects with 403         |
| Share-token forgery         | HMAC-signed tokens, expiry, secret rotation documented in runbook          |
| XSS via text/sticky content | Rendered as plain text on canvas; no `innerHTML`/DOM injection; strict CSP |
| DoS via connection floods   | Per-IP and per-user rate limits; WebSocket message rate cap                |
| Op-log bloat / GC abuse     | Tombstone GC only after causal stability; snapshot cadence bounds load     |
| Server impersonation        | TLS only; HSTS; signed cookies/JWT for the WS handshake                    |
| Redis/Postgres exposure     | Private network; no public ports; least-privilege credentials in env       |

## Risks

- Implementing a sequence CRDT correctly is the hardest part; mitigated by
  property-based tests and a model-based reference implementation.
- Benchmark regression: honest reporting; any loss must be visible in the
  README.
- Single-VM hosting caps scale; mitigated by a scale tier behind Redis
  pub/sub that is already exercised in chaos tests.
- Free-tier limits (ARM VM bandwidth, Neon cold starts if swapped) — the
  Oracle VM avoids most of these.

## Distribution / what ships at each phase

| Phase | Deliverable                                                          |
| ----- | -------------------------------------------------------------------- |
| 0     | This document, ADRs, hosting decision                                |
| 1     | pnpm monorepo scaffold, strict TS, CI, Docker Compose                |
| 2     | `packages/crdt`, PBT, benchmark harness vs Yjs/Automerge             |
| 3     | Sync server, protocol, persistence, snapshots, auth, protocol tests  |
| 4     | Web client: canvas tools, presence, undo/redo, offline               |
| 5     | Multi-node fan-out, load tests, toxiproxy chaos, crash recovery      |
| 6     | Observability, security hardening, demo deploy, docs, release v1.0.0 |

## Open questions for review

1. Sequence CRDT: decided — Fugue in ADR 0001, superseded by RGA in ADR 0003
   after the integration walk proved too easy to get subtly wrong.
2. Email/password vs magic-link auth for v1 (recommend email/password with
   bcrypt for simplicity).
3. Oracle VM vs Render+Neon+Upstash hosting (recommend Oracle VM).
4. Binary op encoding: fixed hand-rolled vs CBOR/Protobuf (recommend a small
   custom framing for auditability, benchmarked for size).
