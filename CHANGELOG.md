# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-23

Security fixes for dependencies and the server container, a green CI on
`main`, and the demo and launch records. Benchmark results are unchanged
from 1.0.0: no code that affects them changed.

### Security

- Removed a stale vitest 3 from `packages/protocol`, whose `tinypool` had
  critical prototype-pollution advisories; the workspace uses vitest 5.
- Vite 8.3.5, fixing command injection in `launch-editor`.
- The server image ships production dependencies only and no longer
  contains npm or corepack, which the runtime never used and which carried
  high-severity advisories. `pnpm audit` and the Trivy image scan report no
  HIGH or CRITICAL findings.

### Fixed

- A lint error in the CRDT tests that, with the container scan, had failed
  CI on `main` since 1.0.0.

### Added

- A two-minute demo video (`docs/demo.mp4`) and how it was produced
  (`docs/demo.md`).
- A model-cost record (`docs/model-cost.md`): the project runs no model
  inference, so its runtime model cost is $0.
- Proposed repository details (`docs/repository-details.md`).

## [1.0.0]

The first complete release: a collaborative whiteboard whose CRDT engine,
sync protocol and server are implemented here rather than adopted from a
library, and measured against the established ones.

### Added

- **CRDT core** (`packages/crdt`, zero runtime dependencies): last-writer-wins
  property registers ordered by a hybrid logical clock, an RGA sequence CRDT for
  z-order and text (ADR 0001, superseded by ADR 0003), per-user undo/redo,
  tombstones and garbage collection, and a compact binary operation encoding.
- **Sync protocol** (`packages/protocol`, `docs/protocol.md`): versioned binary
  frames, state-vector delta sync that leaves out superseded writes,
  per-batch acknowledgements after the durable write, ephemeral presence,
  backpressure and rate limits.
- **Server** (`apps/server`): WebSocket relay with accounts, board memberships
  (owner/editor/viewer) and signed share links; viewers are refused before
  anything is persisted. Append-only Postgres op log with compacted snapshots
  (ADR 0004), Redis fan-out so any node serves any client, and anti-entropy
  that repairs lost fan-out messages from the log.
- **Client** (`apps/web`): local-first canvas whiteboard (rectangle, ellipse,
  line, arrow, text, sticky note, freehand) with selection, move, resize,
  live presence cursors, per-user undo/redo, share links, and offline editing
  that merges on reconnect. Each device is its own CRDT actor, and one tab
  per board per browser holds the board.
- **Correctness**: property-based tests (convergence under reordering and
  duplication, merge commutativity/associativity/idempotence, undo,
  compaction), model-based tests against an independent reference
  implementation, replayable seeds, multi-node fan-out and anti-entropy
  tests, a `SIGKILL` crash-recovery test, a toxiproxy chaos run, and
  Playwright end-to-end tests with several browsers on one board.
- **Observability**: Prometheus metrics, structured JSON logs with request and
  connection IDs, OpenTelemetry spans per applied batch, health and readiness
  endpoints, and a provisioned Grafana dashboard.
- **Benchmarks**: Tandem vs Yjs and Automerge on the automerge-perf text trace
  and a 100k-op whiteboard stream (5 fresh-process runs, 95% confidence
  intervals); a multi-process scaling sweep; a cold-load benchmark.
- **Deployment**: Docker images for the server and the client (Caddy with
  automatic HTTPS), a production compose file for one VM, and a runbook.

### Security

- Server-side authorisation for every operation (role check, actor must equal
  the connection's actor, zod schema validation, rate limits).
- Frames over 1 MiB are rejected by the WebSocket layer before buffering, and
  socket errors are handled per connection instead of crashing the node.
- The server refuses to start in production without 32-character secrets.
- Device actors are bound to server-signed device tokens; presence is
  re-stamped with the sender's identity.
- `/auth/*` is rate-limited per client address, registration no longer
  reveals existing accounts, HTTP bodies are capped at 64 KiB, and metric
  labels come from a fixed route list.
- A strict content security policy on the client and `default-src 'none'` on
  the API; board text renders on a canvas, never as markup.
- Dependency auditing and container scanning in CI.

### Known limitations

Listed in the README. The most important: RGA can interleave concurrent
same-position text, text authoring trails Yjs several times over, and one
board's fan-out cost grows with the square of its editors.

[1.1.0]: https://github.com/pavan-dangeti/Tandem/releases/tag/v1.1.0
[1.0.0]: https://github.com/pavan-dangeti/Tandem/releases/tag/v1.0.0
