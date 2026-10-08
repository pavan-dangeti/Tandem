import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

// Metrics the operator actually needs to answer "is the board healthy?":
// who is connected, how fast ops move, how slow the log is, how big snapshots
// get. Everything is labelled by board only at debug level, never by user.
export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "tandem_" });

export const wsConnections = new Gauge({
  name: "tandem_ws_connections",
  help: "Currently connected WebSocket clients",
  registers: [registry],
});

export const wsConnectionsTotal = new Counter({
  name: "tandem_ws_connections_total",
  help: "WebSocket connections accepted since start",
  registers: [registry],
});

export const opsReceived = new Counter({
  name: "tandem_ops_received_total",
  help: "Operations received from clients",
  registers: [registry],
});

export const opsApplied = new Counter({
  name: "tandem_ops_applied_total",
  help: "Operations applied to a board session (post-dedupe)",
  registers: [registry],
});

export const opsRejected = new Counter({
  name: "tandem_ops_rejected_total",
  help: "Batches rejected (auth, schema, rate limit, backpressure)",
  registers: [registry],
  labelNames: ["reason"] as const,
});

export const fanoutLatency = new Histogram({
  name: "tandem_fanout_latency_ms",
  help: "Time from receiving a batch to publishing it to the fan-out bus",
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

export const opLogWrite = new Histogram({
  name: "tandem_oplog_write_ms",
  help: "Time to durably append a batch to the op log",
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

export const snapshotSize = new Histogram({
  name: "tandem_snapshot_bytes",
  help: "Serialized size of periodic board snapshots",
  buckets: [1e5, 5e5, 1e6, 5e6, 1e7, 5e7],
  registers: [registry],
});

export const batchOps = new Histogram({
  name: "tandem_batch_ops",
  help: "Operations per client batch",
  buckets: [1, 5, 10, 50, 100, 500],
  registers: [registry],
});

export const httpRequests = new Counter({
  name: "tandem_http_requests_total",
  help: "HTTP requests by route and status",
  registers: [registry],
  labelNames: ["route", "status"] as const,
});

export const httpDuration = new Histogram({
  name: "tandem_http_request_duration_ms",
  help: "HTTP request duration by route",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
  labelNames: ["route"] as const,
});
