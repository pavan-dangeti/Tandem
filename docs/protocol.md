# Tandem Sync Protocol (v1)

Versioning: every connection starts with a `Hello` whose `protocol` field must be `"tandem/1"`. Frame behavior on version mismatch: error code `bad_hello`, close. Major version differences require a new endpoint (`/ws?protocol=tandem/2`) in a future migration.

## Transport

WebSocket, binary frames: `[u8 type][u32be length][payload]`.

| type | name         | direction             | payload                                                 |
| ---- | ------------ | --------------------- | ------------------------------------------------------- |
| 0    | Hello        | client → server       | JSON `{protocol, token, boardId, stateVector}`          |
| 1    | SyncResponse | server → client       | `[u32be jsonLen][{"stateVector":...} JSON][packed ops]` |
| 2    | OpBatch      | both                  | `[u32be count][(u32be len)(encodeOp bytes)]*`           |
| 3    | Ack          | server → client       | JSON `{batchId, applied, stateVector}`                  |
| 4    | Presence     | both (server fan-out) | JSON `{userId, name, color, cursor?, selection?, at}`   |
| 5    | Error        | server → client       | JSON `{code, message}`                                  |

Ops use the compact binary `encodeOp` from `@tandem/crdt`. `packOps`/`unpackOps` in `apps/server/src/frame.ts`.

## Auth

- `POST /auth/register {email,password}` → `{userId, token}` (HS256 JWT, 30d).
- `POST /auth/login` → `{userId, token}`.
- `POST /boards` (Bearer) → `{boardId}`. `POST /boards/:id/members {email, role}` (owner). `POST /boards/:id/share {role, ttlSeconds}` (owner) → HMAC-signed share token.
- `Hello.token` is either the user JWT (member role from `board_members`) or a share token (role clamped: `editor` or `viewer`). A token for a user who is not a member is rejected.

## Roles and invariants

- `viewer` < `editor` < `owner` privilege-wise. Viewers can never emit operations: every OP_BATCH message from a viewer-context client is rejected with `{code:"forbidden"}` and nothing is persisted or broadcast.
- Edits require `editor`+: server also enforces `op.actor === session userId`, so a client cannot forge ops attributed to another member.
- Presence frames are ephemeral and never persisted or relayed back to their sender's own session other than as broadcasts to _other_ clients.

## Sync flow

1. Client opens `/ws`, then sends `Hello` within 2 s (else `timeout` error + close).
2. Server loads the board session (latest snapshot + full op log, replay; objects/applyRemote dedupes) and replies `SyncResponse` with exactly the ops the client's `stateVector` is missing — never a full replay when the client is up to date.
3. Steady state: client's local ops are shipped as one or more OP_BATCH messages. Server validates, authorizes, applies to the board Doc, persists rows to the op log (`ops` table, `UNIQUE (board_id, actor_id, seq)` so duplicates are harmless), then acks (`Ack` with applied count + server stateVector) and broadcasts the applied ops to other room members.
4. Visibility to the acked author is the Ack itself; the operator must not broadcast to the sending client (no echo-echo).

## Backpressure / rate limits / schemas

- Max in-flight OpBatches (client → server): 8 — v8 stale client must wait for acks. Beyond → `backpressure` error.
- Frame size cap: 1 MiB (`MAX_FRAME`) — oversize → `too_large` + close.
- Ops per second per connection: 400 (`OPS_PER_SEC_LIMIT`) — excess → `rate_limit` error; batch dropped.
- Every op is decoded then re-validated against `opSchema` (zod): shapes, lengths and point counts bounded — malformed ops are isolated per batch with `bad_op`.

## Persistence and snapshots

- Op log: PostgreSQL `ops(board_id, actor_id, seq, hlc_wall, hlc_logical, data)` append-only.
- Board load: server-side caches a Doc per board; cold loads replay the op log (fast enough for v1; JSON snapshot of applied ops is saved every `SNAPSHOT_EVERY` applied ops as a JSON array and parsed on boot — no compaction of the row log is performed yet; see "Future work").
- Crash safety: an ack is sent only after the rows are committed to the DB (per-batch transaction), so an acknowledged op survives restart. Unacked batches may be lost and are retried by the client at its own discretion.

## Ordering and consistency guarantees

- Strong eventual consistency of the CRDT state: any two replicas that have applied the same set of ops compute identical state (see property tests in `packages/crdt/test`).
- Within one connection batches are applied in order, and broadcasts preserve order; across the network, ops carry HLC and instance-level ids so reorder/duplication is safe.
- Deletes and undo are represented as ops in the same log; `restoreObject` and HLC-max wins make undo deterministic.

### Scaling and failure semantics

- Nodes share nothing but Redis. The node that accepts a batch persists it,
  broadcasts to its own room, and publishes to `tandem:board:<id>`; every other
  node applies the ops to its local session and forwards them to its own room.
  Subscribers never write to the op log, so exactly one node persists each op.
- If a publish fails, the batch is still acked: the rows are already durable,
  and clients repair the gap on reconnect through the state vector. Losing
  fan-out costs latency, never data.
- Acks are sent only after the rows commit, so an acknowledged op survives
  `SIGKILL`; the crash test in `apps/server/test/crash.test.ts` proves this and
  fails if the ordering is reversed.
- Clients cap their own in-flight batches and drain the rest on ack, so a slow
  server pushes back instead of losing work.

## Future work

- Redis pub/sub fan-out across nodes, and a truly compact log once client vectors are negotiated (phase 5 introduces both).
- OT materialization rather than op replay for snapshot payloads (size is currently the uncompressed op list).
