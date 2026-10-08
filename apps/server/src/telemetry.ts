/**
 * Tracing is opt-in: without an OTLP endpoint we stay on the no-op provider and
 * pay nothing. `OTEL_EXPORTER_OTLP_ENDPOINT` alone is not enough - the SDK has to
 * be registered before any tracer is resolved, so the entrypoint calls this
 * before it touches anything else.
 */
export async function startTracing(serviceName: string): Promise<boolean> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return false;
  const [{ NodeSDK }, { OTLPTraceExporter }, { resourceFromAttributes }] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
    ]);
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    resource: resourceFromAttributes({
      "service.name": serviceName,
      "service.version": process.env.npm_package_version ?? "1.0.0",
    }),
  });
  sdk.start();
  process.once("SIGTERM", () => void sdk.shutdown());
  return true;
}
