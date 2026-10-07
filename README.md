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
