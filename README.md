# Tandem

Real-time collaborative whiteboard with a custom CRDT engine (packages/crdt) benchmarked against Yjs and Automerge.

## Benchmarks

Trace replay + 100k-op whiteboard stream, measured 2026-10-06 on Apple M5 (10 cores), 16GB RAM, node v22.23.2.

| Engine    | Text author ms | Text merge ms | Text bytes | Text mem MB | Whiteboard author ms | Whiteboard merge ms | Whiteboard bytes | Memory |
| --------- | -------------- | ------------- | ---------- | ----------- | -------------------- | ------------------- | ---------------- | ------ |
| tandem    | 7577           | 332           | 8,673,080  | 241         | 307                  | 161                 | 3,546,305        | 15     |
| Yjs       | 1050           | 28            | 311,038    | 17          | 218                  | 94                  | 761,161          | 2      |
| Automerge | 13464          | 2631          | 129,198    | -29         | 125070               | 334                 | 773,708          | -622   |

Reproduce:

```sh
pnpm install
pnpm --filter @tandem/crdt bench
```

Raw results: `results/bench.json` (iteration over the trace is offline and deterministic; whiteboard stream uses a fixed xorshift seed).

Tandem loses to Yjs on text-authoring speed (7.6×) and encoded size (28×) — the tradeoff for owning the engine and LWW-register simplicity. Full README with architecture, limits, and security posture lands in Phase 6.

## Scale and failure testing

Edit-to-remote latency (p50/p95/p99) as editors per board grows, 2 server nodes
sharing Redis, Postgres for the op log, all on one Apple M5. Every edit is issued
concurrently; latency is measured from the edit being issued to it being applied
on **every other** replica, so queueing is included.

| Editors | p50      | p95      | p99        | ops/s  |
| ------- | -------- | -------- | ---------- | ------ |
| 20      | 9.5 ms   | 11.8 ms  | 12.0 ms    | 51,561 |
| 50      | 31.1 ms  | 47.0 ms  | 49.3 ms    | 32,033 |
| 100     | 54.4 ms  | 129.9 ms | 139.3 ms   | 27,384 |
| 150     | 81.7 ms  | 185.8 ms | 198.6 ms   | 27,345 |
| 200     | 198.7 ms | 571.0 ms | 617.8 ms   | 12,234 |
| 300     | 267.3 ms | 938.4 ms | 1,038.7 ms | 11,034 |

The design target is p95 < 300 ms for 50 editors; that is met with wide margin
(47 ms) and holds until roughly **150 editors per board**, breaking between 150
and 200. Reproduce with `results/scale.json`:

```sh
docker compose up -d --wait postgres redis
TEST_REDIS_URL=redis://localhost:6379 DATABASE_URL=postgres://tandem:tandem@localhost:5434/tandem \
  LOAD_SWEEP="20,50,100,150,200,300" pnpm --filter @tandem/server bench
```

Chaos (`results/chaos.json`): clients edit through toxiproxy while the link is
degraded, then heal. All four phases converged with **zero lost ops**:

| Phase     | Condition                      | Converged | Lost ops |
| --------- | ------------------------------ | --------- | -------- |
| healthy   | no toxics                      | yes       | 0        |
| latency   | +200 ms latency (50 ms jitter) | yes       | 0        |
| bandwidth | 10 kbit/s downstream           | yes       | 0        |
| partition | connection cut mid-edit        | yes       | 0        |

```sh
docker compose --profile chaos up -d --wait toxiproxy
pnpm --filter @tandem/server chaos
```

Crash recovery: a real server process is `SIGKILL`ed mid-run and restarted; a
client reconnects and must still see every acked op, because the server acks
only after the rows commit to Postgres. Runs in CI
(`apps/server/test/crash.test.ts`), and it fails if the durability ordering is
reversed.

## Run it locally

```sh
pnpm install
docker compose up -d postgres          # optional; the server falls back to in-memory stores
pnpm --filter @tandem/server dev       # ws://localhost:8080
pnpm --filter web dev                  # http://localhost:5173
```

Create an account, open a board, and share it: `POST /boards/:id/share` returns a
signed link (`?board=…&token=…`) that other people can open as editor or viewer.

Checks:

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
TEST_DATABASE_URL=postgres://tandem:tandem@localhost:5434/tandem pnpm --filter @tandem/server test
```

The web client is local-first: every edit lands in the CRDT and IndexedDB before
it hits the network, and reconnecting replays whatever the server is missing
(derived from its state vector), so nothing is lost while offline.
