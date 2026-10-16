# ADR 0004: Compacted snapshots, compacted delta sync, and anti-entropy

## Status

Accepted (Phase 6)

## Context

Two promises in the design were not being kept:

- **Load cost.** Snapshots stored the full op list as JSON, and a cold load
  applied the snapshot and then replayed the entire op log anyway. A board's
  load time grew with its edit history, which is what snapshots exist to
  prevent (SLO R4).
- **Multi-node delivery.** Redis pub/sub is at-most-once. A lost fan-out
  message left other nodes' cached boards, and the clients on them, missing
  ops until a restart. Nothing repaired the gap.

## Decision

1. `Doc.compactOps()` returns the ops that rebuild the current state: every
   op except property writes that lost their last-writer-wins race.
   `Doc.markSeen(stateVector)` records the dropped ops as seen, so the
   receiver's state vector stays a correct frontier.
2. A snapshot is the compacted ops plus the state vector they cover. A cold
   load applies it, then reads only log rows beyond that vector
   (`seq > vector[actor]`, filtered in SQL).
3. `missingSince` sends the compacted delta too, and the client calls
   `markSeen` with the server's vector. A new client receives the board's
   live state, not its history.
4. Every node runs anti-entropy: every 5 s, each board with clients on that
   node reads log rows beyond its cached vector and forwards anything new.

## Rationale

- Dropping a superseded write is safe for any receiver. Its state is decided
  by the winning write, which is either sent or already held. Any write
  arriving later is compared against that winner exactly as before. Two
  property-based tests check this. One rebuilds a replica from a compacted
  prefix and keeps applying the rest. The other gives a random partial
  replica the compacted delta. Both must end identical to the full replica.
- Text and z-order ops are kept whole. Their IDs are parents of later
  inserts, and removing them safely needs causal stability across every
  replica (garbage collection), not just a local winner check.
- The op log stays append-only and is never rewritten, so a snapshot bug can
  never lose data: an unreadable snapshot falls back to the full log.
- Anti-entropy reuses the same "rows beyond this vector" query, so the
  repair path is one indexed query per active board per interval, and the
  database stays the single source of truth.

## Consequences

- Cold-load time follows a board's live state (`results/coldload.json`).
- A dropped fan-out message costs at most one reconcile interval of latency.
- A replica no longer holds every historical op, so "same op count" is not a
  convergence check. Tests compare visible state instead.
- Text-heavy boards still carry their full RGA history until tombstone GC;
  recorded as future work in `docs/protocol.md`.
