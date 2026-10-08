# Tandem

Tandem is a real-time collaborative whiteboard: several people edit one board
at once, see each other's cursors, keep working offline, and every copy is
guaranteed to end up identical when they reconnect. The conflict-free
replicated data type (CRDT) underneath, its sync protocol and the server are
written here from scratch, then tested and benchmarked against Yjs and Automerge.

![Two browsers editing one board; the left one goes offline, both keep drawing, and the board merges when it reconnects](docs/demo.gif)

## Results

All figures come from committed scripts writing to `results/`; a test fails CI
if this README drifts from those files. Hardware: Apple M5 (10 cores), 16 GB,
macOS, Node 22, with Postgres and Redis in Docker on the same machine. Dates,
versions and seeds are inside each result file.

| Measure                                          | Tandem   | Baseline                                         | Method                                                           | Reproduce                               |
| ------------------------------------------------ | -------- | ------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------- |
| Text trace, author 259,778 edits                 | 4,846 ms | Yjs 859 ms (5.6× faster), Automerge 9,406 ms     | automerge-perf trace, 5 fresh processes, mean                    | `pnpm --filter @tandem/crdt bench`      |
| Whiteboard, merge 100k ops into an empty replica | 93.0 ms  | Yjs 96.7 ms, Automerge 281 ms                    | seeded create/move/delete stream                                 | `pnpm --filter @tandem/crdt bench`      |
| Whiteboard, encoded size                         | 3.39 MB  | Yjs 0.65 MB, Automerge 0.71 MB                   | Tandem: per-op wire encoding; others: document encoding          | `pnpm --filter @tandem/crdt bench`      |
| p95 edit-to-remote, 50 editors on one board      | 8.3 ms   | target < 300 ms                                  | 2 nodes + Redis + Postgres, 2 edits/s per editor, 3 runs, median | `pnpm --filter @tandem/server bench`    |
| Most editors on one board within the p95 target  | 150      | breaks at 200 (p95 2,228 ms)                     | same sweep                                                       | `pnpm --filter @tandem/server bench`    |
| Cold load, 100,000-op board                      | 110 ms   | log replay 487 ms; target < 2,000 ms             | fresh server process, new client until fully applied, 5 runs     | `pnpm --filter @tandem/server coldload` |
| Ops lost under network chaos                     | 0        | 4 phases: healthy, latency, bandwidth, partition | toxiproxy between clients and server, then heal                  | `pnpm --filter @tandem/server chaos`    |

### CRDT vs Yjs and Automerge

Mean ± 95% confidence interval over 5 runs, each in a fresh process. "Author"
applies every edit locally; "merge" brings an empty replica up to date;
"memory" is live heap plus external memory (which includes WebAssembly) after
a forced GC. Text: the [automerge-perf](https://github.com/automerge/automerge-perf)
trace of an academic paper being written (259,778 edits). Whiteboard: 100,000
seeded create, move and delete operations on shapes.

Text trace:

| Engine    | Author (ms) | Merge (ms)   | Memory (MB) | Encoded (MB) |
| --------- | ----------- | ------------ | ----------- | ------------ |
| Tandem    | 4,846 ± 620 | 337 ± 139    | 243.6 ± 0.0 | 7.56         |
| Yjs       | 859 ± 50.5  | 17.3 ± 1.5   | 3.5 ± 0.2   | 0.30         |
| Automerge | 9,406 ± 264 | 2,142 ± 26.7 | 54.1 ± 0.0  | 0.12         |

Whiteboard:

| Engine    | Author (ms)      | Merge (ms) | Memory (MB) | Encoded (MB) |
| --------- | ---------------- | ---------- | ----------- | ------------ |
| Tandem    | 232 ± 7.1        | 93.0 ± 1.6 | 85.3 ± 0.0  | 3.39         |
| Yjs       | 242 ± 5.8        | 96.7 ± 1.4 | 13.3 ± 0.6  | 0.65         |
| Automerge | 106,864 ± 47,407 | 281 ± 88.9 | 17.5 ± 0.1  | 0.71         |

Where Tandem loses, and why: on text it authors several times slower than
Yjs, holds about 70 times the memory, and encodes many times larger. Yjs
merges runs of consecutive characters into one item and run-length encodes
them, while Tandem keeps one RGA node, one op and one wire message per
character, and its encoded size is the sum of per-op sync messages rather
than a compressed document format. On the whiteboard workload, which is what
its last-writer-wins property maps are shaped for, Tandem matches Yjs on
authoring and merge time, but still uses several times the memory and wire
bytes for the same reason: every op is kept and encoded individually.

### Scale

Two server nodes (separate processes running the production bundle) share
Redis for fan-out and Postgres for the op log. Simulated editors run in
separate worker processes, so their CRDT work never shares an event loop with
the servers. Each editor makes 2 edits per second for 10 seconds. Latency runs
from an edit being issued to it being applied on **every** other replica of
its board. Each row is the median of 3 runs; the p95 range is across those
runs. CPU and RSS per node come from each node's own `/metrics`.

| Boards × editors | Edits/s | p50 (ms) | p95 (ms) [range]    | p99 (ms) | CPU per node | RSS per node | CPU per editor worker | Undelivered |
| ---------------- | ------- | -------- | ------------------- | -------- | ------------ | ------------ | --------------------- | ----------- |
| 1 × 20           | 40      | 5.3      | 9.0 [8.5–9.3]       | 10.8     | ≤ 7%         | ≤ 137 MB     | ≤ 2%                  | 0           |
| 1 × 50           | 100     | 3.6      | 8.3 [7.2–9.1]       | 16.2     | ≤ 11%        | ≤ 143 MB     | ≤ 5%                  | 0           |
| 1 × 100          | 200     | 6.0      | 27.1 [4.7–153]      | 43.0     | ≤ 25%        | ≤ 148 MB     | ≤ 12%                 | 0           |
| 1 × 150          | 300     | 22.4     | 108 [18.9–123]      | 173      | ≤ 41%        | ≤ 118 MB     | ≤ 24%                 | 0           |
| 1 × 200          | 400     | 894      | 2,228 [115–4,974]   | 2,450    | ≤ 65%        | ≤ 149 MB     | ≤ 39%                 | 186         |
| 1 × 225          | 449     | 967      | 3,059 [3,042–3,524] | 3,269    | ≤ 61%        | ≤ 139 MB     | ≤ 36%                 | 2341        |
| 1 × 250          | 499     | 3,802    | 4,830 [3,785–6,711] | 5,093    | ≤ 62%        | ≤ 144 MB     | ≤ 34%                 | 4422        |
| 1 × 275          | 549     | 1,209    | 7,929 [6,072–9,212] | 8,441    | ≤ 108%       | ≤ 291 MB     | ≤ 61%                 | 0           |
| 1 × 300          | 599     | 1,835    | 3,088 [1,955–6,484] | 3,206    | ≤ 107%       | ≤ 279 MB     | ≤ 47%                 | 7231        |
| 25 × 8           | 400     | 2.8      | 7.4 [5.2–7.7]       | 9.8      | ≤ 17%        | ≤ 148 MB     | ≤ 6%                  | 0           |

The design target (p95 under 300 ms for 50 editors on one board) holds with a
wide margin, and 25 boards of 8 editors, the common shape, stay under 10 ms.
One very large board is the hard case: every edit fans out to every other
editor, so delivery work grows with the square of the editors on the board.
On this laptop, which also hosts the clients, Postgres and Redis, the knee
falls between 150 and 250 editors and moves between runs (see the p95
ranges). Neither the nodes nor the editor workers were CPU-bound at the knee.
Disabling Postgres synchronous commit lowered latency at 200 editors in a
side experiment, so per-batch durable commits (acks wait for them) are one
contributor; the full bottleneck is not yet isolated. "Undelivered" counts
edits not yet applied everywhere when a run's measurement window closed;
past the knee that is backlog, not loss (the chaos and crash tests check
loss).

Reproduce:

```sh
docker compose up -d --wait postgres redis
DATABASE_URL=postgres://tandem:tandem@localhost:5434/tandem pnpm --filter @tandem/server bench
DATABASE_URL=postgres://tandem:tandem@localhost:5434/tandem pnpm --filter @tandem/server coldload
```

### Failure testing

| Phase     | Condition                                 | Converged | Lost ops |
| --------- | ----------------------------------------- | --------- | -------- |
| healthy   | no toxics                                 | yes       | 0        |
| latency   | 200ms added latency both directions       | yes       | 0        |
| bandwidth | 10 kbit/s downstream                      | yes       | 0        |
| partition | connection cut while clients keep editing | yes       | 0        |

- **Network chaos**: clients edit through toxiproxy while the link gets
  latency, a 10 kbit/s cap, and a hard partition; after healing every replica
  must be identical with no acknowledged edit missing. Runs nightly in CI:
  `docker compose --profile chaos up -d --wait toxiproxy && pnpm --filter @tandem/server chaos`.
- **Crash recovery**: a real server process is `SIGKILL`ed mid-run and
  restarted; a reconnecting client must still see every acknowledged op,
  because acks are sent only after the rows commit
  (`apps/server/test/crash.test.ts`, every CI run).
- **Lost fan-out**: two nodes with no working pub/sub between them still
  converge through anti-entropy from the op log
  (`apps/server/test/fanout.test.ts`).
- **Randomised convergence**: fast-check runs three replicas through random
  interleavings with reordered and duplicated delivery, merge
  commutativity/associativity/idempotence, undo, compaction, and a model-based
  check against an independent reference implementation. Failing seeds are
  printed and replay with `PBT_SEED`; `PBT_RUNS=10000 pnpm test` runs more.

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser (apps/web)"]
    UI["Canvas UI<br/>tools, presence, undo"] --> Doc1["CRDT Doc<br/>(packages/crdt)"]
    Doc1 --> IDB[("IndexedDB<br/>op log")]
    Doc1 <--> Sync["SyncClient<br/>state vectors, acks,<br/>backpressure"]
  end
  Sync <-- "binary frames over WebSocket<br/>(packages/protocol)" --> Caddy["Caddy<br/>TLS, static client"]
  Caddy <--> N1["Node 1<br/>validate, authorise,<br/>persist, fan out"]
  Caddy <--> N2["Node 2"]
  N1 <--> PG[("PostgreSQL<br/>append-only op log,<br/>compacted snapshots")]
  N2 <--> PG
  N1 <-- "pub/sub" --> R[("Redis")]
  N2 <-- "pub/sub" --> R
  N1 -. "anti-entropy<br/>every 5 s" .-> PG
```

- **CRDT** (`packages/crdt`, no runtime dependencies): each shape is a map of
  last-writer-wins registers ordered by a hybrid logical clock; z-order and
  text use an RGA sequence ([ADR 0003](docs/adr/0003-rga-v1.md)). Per-user
  undo, tombstones, garbage collection once causally stable, and compaction
  that drops superseded writes ([ADR 0004](docs/adr/0004-compacted-snapshots-and-anti-entropy.md)).
- **Protocol** ([docs/protocol.md](docs/protocol.md)): versioned binary frames.
  On connect the client sends its state vector and gets back only what it
  lacks. Edits travel in batches acknowledged after the durable write, with
  in-flight limits for backpressure; presence is separate and never stored.
- **Server** (`apps/server`): every op is schema-validated and authorised
  (viewers can never write, and an op's actor must be the connection's),
  committed to Postgres, acknowledged, then fanned out. Nodes are stateless
  apart from board caches, so any node serves any client.
- **Client** (`apps/web`): local-first. Edits apply to the local CRDT and
  IndexedDB first and sync in the background; the browser's offline/online
  events drive reconnects.

Design, alternatives and threat model: [docs/design.md](docs/design.md).
Operations: [docs/runbook.md](docs/runbook.md).

## Run it locally

Requires Node 22, pnpm 10 and Docker.

```sh
pnpm install
docker compose up -d --wait postgres redis   # optional: without them the server keeps state in memory
pnpm --filter @tandem/server dev             # API and WebSocket on :8080
pnpm --filter web dev                        # http://localhost:5173
```

Create an account and a board, then **Share** to get editor and viewer links.
`#chaos` on a board opens a demo of two simulated users editing offline and
merging.

Full stack with metrics and the Grafana dashboard (http://localhost:3001):
`docker compose --profile full --profile ops up -d --build`. Deploying to a
VM: [runbook](docs/runbook.md#deploy).

Checks (what CI runs):

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
TEST_DATABASE_URL=postgres://tandem:tandem@localhost:5434/tandem \
  TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @tandem/server test
pnpm --filter web exec playwright install chromium && pnpm --filter web e2e
```

## Security

- Every operation is validated against a schema, size-limited (1 MiB frames
  rejected by the WebSocket layer before buffering) and rate-limited
  (400 ops/s per connection), and authorised on the server.
- Passwords are bcrypt-hashed and `/auth/*` is rate-limited per client
  address; registration does not reveal whether an email exists. Sessions
  are signed JWTs, share links are HMAC-signed tokens with an expiry, and each
  device's CRDT actor is bound to a server-signed device token, so no client
  can write as another device. The server refuses to start in production
  without 32-character secrets.
- HTTP bodies are capped at 64 KiB, presence is re-stamped with the sender's
  identity, and metric labels come from a fixed route list.
- The client renders all board text on a canvas, so content is never parsed
  as HTML. It ships a strict content security policy (no inline script or
  style); the API sends `default-src 'none'`.
- Dependency audit and container image scanning run in CI. The threat model
  is in the [design doc](docs/design.md).

## Limitations

- **Text interleaving**: RGA can interleave two people typing at the same
  position at the same moment. Fugue avoids this and is the planned upgrade
  ([ADR 0003](docs/adr/0003-rga-v1.md)).
- **Text cost**: one node and one wire op per character makes text authoring
  several times slower and encodings much larger than Yjs (see results).
  Text history is not compacted until tombstones are garbage-collected.
- **Per-board ceiling**: fan-out work grows with the square of the editors on
  one board; a board saturates a node's CPU in the low hundreds of active
  editors (see Scale). Scaling out helps many boards, not one huge board.
- **One machine**: every scale number was measured with servers, clients,
  Postgres and Redis on one laptop; real network latency is not included.
- **Single Redis and Postgres**: both are single instances with no failover;
  if Redis is down, edits still persist but cross-node delivery waits for
  anti-entropy (5 s).
- **One tab per board per browser**: tabs share a CRDT actor, so a second
  tab waits until the first closes rather than editing alongside it.
- **Rich text, voice/video and single sign-on** are out of scope.
