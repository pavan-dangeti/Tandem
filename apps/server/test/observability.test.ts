import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";
import { MemoryMetaStore } from "../src/meta.js";
import { MemoryOpStore } from "../src/store.js";

let srv: RunningServer;
let port: number;

beforeAll(async () => {
  srv = await startServer({
    port: 0,
    metaStore: new MemoryMetaStore(),
    store: new MemoryOpStore(),
  });
  port = srv.port;
});

afterAll(async () => {
  await srv.close();
});

describe("observability and hardening", () => {
  it("serves prometheus metrics", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    for (const name of [
      "tandem_ws_connections",
      "tandem_ops_received_total",
      "tandem_ops_applied_total",
      "tandem_fanout_latency_ms",
      "tandem_oplog_write_ms",
      "tandem_snapshot_bytes",
      "tandem_batch_ops",
      "tandem_http_request_duration_ms",
    ]) {
      expect(body).toContain(name);
    }
  });

  it("echoes a caller's request id and mints one otherwise", async () => {
    const echoed = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { "x-request-id": "trace-123" },
    });
    expect(echoed.headers.get("x-request-id")).toBe("trace-123");
    const minted = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { "x-request-id": "<script>" },
    });
    expect(minted.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends strict security headers on API responses", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site");
  });

  it("answers CORS preflight for the separately hosted client", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/boards`, {
      method: "OPTIONS",
      headers: { origin: "https://example.test" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
  });

  it("never serves board content over the metrics or health routes", async () => {
    for (const path of ["/metrics", "/healthz", "/readyz"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const body = await res.text();
      expect(body).not.toContain("password_hash");
      expect(body).not.toContain("token");
    }
  });

  it("rejects unauthenticated board creation and membership changes", async () => {
    const create = await fetch(`http://127.0.0.1:${port}/boards`, {
      method: "POST",
      body: "{}",
    });
    expect(create.status).toBe(401);
    const share = await fetch(`http://127.0.0.1:${port}/boards/abc/share`, {
      method: "POST",
      body: "{}",
    });
    expect(share.status).toBe(401);
  });
});
