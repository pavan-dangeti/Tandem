import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

// A tracer must be resolved after any SDK registration, or it binds to the
// no-op provider and every span is silently discarded.
let cached: ReturnType<typeof trace.getTracer> | null = null;

function tracer(): ReturnType<typeof trace.getTracer> {
  cached ??= trace.getTracer("tandem-server", "1.0.0");
  return cached;
}

/** Wraps an async step so a failure marks the span instead of vanishing. */
export async function inSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
