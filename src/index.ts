/**
 * W3C Trace Context PoC for Cloudflare Workers.
 *
 * Demonstrates:
 *   - Parsing inbound `traceparent` per https://www.w3.org/TR/trace-context/
 *   - Optionally trusting + continuing the incoming trace, or starting a fresh one
 *   - Propagating `traceparent` to downstream services
 *   - Emitting one structured "canonical event" log line per request
 *   - Returning `traceparent` on every response (success and error)
 */

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const UPSTREAM_TIMEOUT_MS = 2_000;

interface Env {
  SERVICE_NAME: string;
  ENVIRONMENT: string;
  TRUST_INCOMING_TRACEPARENT: string;
  UPSTREAM_URL: string;
}

interface ParsedTraceparent {
  traceId: string;
  parentId: string;
  flags: string;
}

interface Dependency {
  service: string;
  status_code: number;
  duration_ms: number;
}

interface CanonicalEvent {
  timestamp: string;
  level: "INFO" | "ERROR";
  service: string;
  environment: string;
  request_id: string;
  trace_id: string;
  traceparent: string;
  method: string;
  path: string;
  cf_ray: string | null;
  dependencies: Dependency[];
  status_code?: number;
  outcome?: "success" | "error";
  duration_ms?: number;
  error?: { type: string; message: string; stack?: string };
}

interface RequestContext {
  request: Request;
  env: Env;
  traceparent: string;
  traceId: string;
  event: CanonicalEvent;
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// traceparent helpers
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseTraceparent(value: string | null): ParsedTraceparent | null {
  if (!value) return null;
  const match = TRACEPARENT_RE.exec(value);
  if (!match) return null;
  const [, traceId, parentId, flags] = match as unknown as [string, string, string, string];
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, parentId, flags };
}

/**
 * Decide the trace context for this request:
 *   - if we trust the inbound traceparent and it parses, continue that trace
 *     with a fresh span id
 *   - otherwise, start a brand new trace
 */
function startTrace(
  request: Request,
  trustIncoming: boolean,
): { traceparent: string; traceId: string } {
  const incoming = parseTraceparent(request.headers.get("traceparent"));
  const continued = trustIncoming && incoming;

  const traceId = continued ? incoming.traceId : randomHex(16);
  const flags = continued ? incoming.flags : "01";
  const parentId = randomHex(8);

  return { traceparent: `00-${traceId}-${parentId}-${flags}`, traceId };
}

// ---------------------------------------------------------------------------
// canonical event
// ---------------------------------------------------------------------------

function buildCanonicalEvent(
  request: Request,
  env: Env,
  traceparent: string,
  traceId: string,
): CanonicalEvent {
  const url = new URL(request.url);
  const cfRay = request.headers.get("cf-ray");

  return {
    timestamp: new Date().toISOString(),
    level: "INFO",
    service: env.SERVICE_NAME,
    environment: env.ENVIRONMENT,
    request_id: cfRay ?? crypto.randomUUID(),
    trace_id: traceId,
    traceparent,
    method: request.method,
    path: url.pathname,
    cf_ray: cfRay,
    dependencies: [],
  };
}

// ---------------------------------------------------------------------------
// middleware: wraps a handler with trace context + canonical event logging
// ---------------------------------------------------------------------------

function withCanonicalEvent(
  handler: (ctx: RequestContext) => Promise<Response>,
): ExportedHandlerFetchHandler<Env> {
  return async (request, env) => {
    const startTime = Date.now();
    const trustIncoming = env.TRUST_INCOMING_TRACEPARENT === "true";
    const { traceparent, traceId } = startTrace(request, trustIncoming);
    const event = buildCanonicalEvent(request, env, traceparent, traceId);

    // One signal for the whole request: tied to the inbound signal so the
    // runtime can cancel downstream work if the client goes away.
    const signal = request.signal;

    let response: Response;
    try {
      response = await handler({ request, env, traceparent, traceId, event, signal });
      event.status_code = response.status;
      event.outcome = response.ok ? "success" : "error";
    } catch (error) {
      event.level = "ERROR";
      event.status_code = 500;
      event.outcome = "error";
      event.error = {
        type: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      response = Response.json({ error: "internal_error" }, { status: 500 });
    }

    event.duration_ms = Date.now() - startTime;
    console.log(JSON.stringify(event));

    // Always return traceparent on the response — including on errors, where
    // clients need it most to correlate with our logs.
    const headers = new Headers(response.headers);
    headers.set("traceparent", traceparent);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

// ---------------------------------------------------------------------------
// downstream call (propagates traceparent + bounds the wait)
// ---------------------------------------------------------------------------

async function callUpstream(
  ctx: RequestContext,
): Promise<{ status_code: number; duration_ms: number; ok: boolean }> {
  const startTime = Date.now();
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout, ctx.signal]);

  try {
    const response = await fetch(ctx.env.UPSTREAM_URL, {
      method: "GET",
      headers: { traceparent: ctx.traceparent },
      signal,
    });
    // Drain body so the runtime doesn't warn about leaked streams.
    await response.arrayBuffer();
    return {
      status_code: response.status,
      duration_ms: Date.now() - startTime,
      ok: response.ok,
    };
  } catch (error) {
    return {
      status_code: error instanceof Error && error.name === "TimeoutError" ? 504 : 0,
      duration_ms: Date.now() - startTime,
      ok: false,
    };
  }
}

// ---------------------------------------------------------------------------
// demo handler
// ---------------------------------------------------------------------------

async function demoHandler(ctx: RequestContext): Promise<Response> {
  const upstream = await callUpstream(ctx);

  ctx.event.dependencies.push({
    service: new URL(ctx.env.UPSTREAM_URL).hostname,
    status_code: upstream.status_code,
    duration_ms: upstream.duration_ms,
  });

  return Response.json({
    message: "hello from the trace context demo",
    trace_id: ctx.traceId,
    upstream_ok: upstream.ok,
  });
}

export default {
  fetch: withCanonicalEvent(demoHandler),
} satisfies ExportedHandler<Env>;
