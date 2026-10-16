# Tandem runbook

Operational notes for running Tandem: what the pieces are, how to deploy and
roll back, and how to diagnose the failures you are most likely to hit.

## What runs where

| Piece         | Role                                                         | State                                     |
| ------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `apps/server` | WebSocket + HTTP API                                         | stateless except an in-memory board cache |
| PostgreSQL    | accounts, boards, memberships, append-only op log, snapshots | durable                                   |
| Redis         | op fan-out between server nodes                              | ephemeral                                 |
| `apps/web`    | static client, served by Caddy with the API on one origin    | none                                      |

One board's history is the op log; a board snapshot is a fast-path copy, never the
source of truth. The server acks an operation only after its rows are committed,
so an acknowledged edit survives a crash.

## Deploy

Production is one VM running `ops/deploy/docker-compose.yml`: Postgres, Redis,
the server, and Caddy serving the client and proxying the API on the same
origin with automatic HTTPS. The design doc's hosting plan uses an Oracle
Cloud Always Free Ampere VM; any Linux host with Docker works.

1. Point a hostname at the VM (without one, `<public-ip>.sslip.io` resolves to
   the VM and Let's Encrypt will issue for it) and open ports 80 and 443.
2. On the VM:

   ```sh
   git clone https://github.com/pavan-dangeti/Tandem && cd Tandem
   cp ops/deploy/.env.example ops/deploy/.env
   # fill in DOMAIN; generate each secret with: openssl rand -hex 32
   docker compose -f ops/deploy/docker-compose.yml --env-file ops/deploy/.env up -d --build
   curl -s https://$DOMAIN/readyz
   ```

Compose refuses to start without `DOMAIN`, `POSTGRES_PASSWORD`, `AUTH_SECRET`
and `SHARE_SECRET`, and the server itself refuses to start in production with a
secret shorter than 32 characters. `/metrics` is not routed publicly. The
compose file sets `TRUST_PROXY=1` because Caddy is the only way in, so the
`/auth/*` rate limit keys on the client address Caddy appends to
`X-Forwarded-For`; never set it on a server that is reachable directly.

Local observability stack (server, Prometheus on :9090, Grafana on :3001 with
the provisioned "Tandem sync server" dashboard):

```sh
docker compose --profile full --profile ops up -d --build
```

Scaling out is more server processes sharing the same Postgres and Redis; any
node serves any client and ops fan out over Redis. Behind Caddy, list each
node as an upstream (`UPSTREAM="server-1:8080 server-2:8080"`).

## Rollback

The client and server ship independently.

```sh
git checkout <previous-good-sha>
docker compose -f ops/deploy/docker-compose.yml --env-file ops/deploy/.env up -d --build server web
```

Rolling back a server is safe at any time: clients reconnect and reconcile by
state vector, and the op log is append-only so no migration is reversed. The
hello frame carries the protocol version (`tandem/1`), so a server that does
not understand a client answers `bad_hello` rather than mis-parsing.

## Diagnosing

Start here:

```sh
curl -s localhost:8080/healthz     # process alive
curl -s localhost:8080/readyz      # database reachable
curl -s localhost:8080/metrics     # scrape for panels
docker compose logs --tail=100 server
```

| Symptom                                                       | Likely cause                                                         | What to do                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Clients show "offline — edits saved locally"                  | server down, proxy not upgrading `/ws`, or TLS mismatch              | check `readyz`; confirm the `Upgrade`/`Connection` headers on the proxy; check the browser console for the WS error code    |
| Clients reconnect but a board looks empty                     | server pointing at a different database than the one holding the ops | compare `DATABASE_URL` across restarts; check `ops` row count for the board                                                 |
| `tandem_ops_rejected_total{reason="rate_limit"}` climbing     | one client flooding (drag loops, a stuck retry)                      | find the connection by `tandem_ws_connections`, reduce the edit batch rate, check the client for an edit loop               |
| `tandem_ops_rejected_total{reason="viewer"}`                  | someone scripting ops with a viewer token                            | expected behaviour; it is refused before anything is persisted                                                              |
| `tandem_oplog_write_ms` p95 climbing                          | database contention or a slow disk                                   | check `SELECT count(*) FROM ops WHERE board_id = ...`; consider more nodes for fan-out, a faster volume for writes          |
| `tandem_fanout_latency_ms` p95 climbing while writes are fine | Redis slow or saturated                                              | check Redis latency; a single Redis instance is the first thing to split                                                    |
| `fanout_publish_failed` in logs                               | Redis restarted or the network blipped                               | harmless by design: the ops are durable, the clients repair via state vector. No action unless it is constant               |
| Board loads slowly after a long session                       | snapshot cadence vs. log size                                        | snapshot every `SNAPSHOT_EVERY` applied ops; if a board grew past the snapshot, load time is dominated by replaying its log |
| Crash after acking (client reports missing edit)              | bug: ack before commit                                               | `apps/server/test/crash.test.ts` covers exactly this and runs in CI                                                         |

Logs are one JSON object per line. Every HTTP response is logged with its
`requestId` (taken from an incoming `x-request-id` header or generated, and
echoed back in the response), and WebSocket errors carry a `connId`. The sync path is traced with OpenTelemetry spans
(`batch.apply` with `board.id` and `ops.count`) — wire an OTLP exporter by
setting `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Rotating secrets

`SHARE_SECRET` rotation invalidates every existing share link on purpose;
`AUTH_SECRET` rotation signs everyone out. Both are read at process start, so
rotate with a rolling restart.

## Chaos drills

`pnpm --filter @tandem/server chaos` degrades the client↔server link
(latency, bandwidth, hard partition) and fails if any replica diverges or an
acknowledged op is lost. It runs nightly in CI. Load numbers and the editor
count at which the p95 target breaks are in `README.md` and `results/`.
