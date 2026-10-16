import { RedisBus } from "./bus.js";
import { startServer } from "./server.js";
import { startTracing } from "./telemetry.js";

const tracing = await startTracing("tandem-server");

const redisUrl = process.env.REDIS_URL;
// A missing or unreachable Redis must not start a single-node server that looks
// healthy: fail loudly instead.
const bus = redisUrl ? await RedisBus.create(redisUrl) : undefined;

const s = await startServer(bus ? { bus } : {});
console.log(
  JSON.stringify({
    msg: "listening",
    port: s.port,
    fanout: redisUrl ? "redis" : "in-process",
    traces: tracing ? "otlp" : "off",
  }),
);

const shutdown = (): void => {
  void s.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
