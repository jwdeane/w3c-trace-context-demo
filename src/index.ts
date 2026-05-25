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
  SERVICE_VERSION: string;
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
  // Workers Logs indexes nested fields, so this is a wide, structured event
  // emitted once per request. Filter in the dashboard by any key, including
  // nested ones like `cf.colo` or `dependencies.status_code`.
  timestamp: string;
  level: "INFO" | "ERROR";
  // Service identity — the answer to "did this start after the last deploy?"
  // lives here. `service_version` should be bumped on every deploy.
  service: string;
  service_version: string;
  environment: string;
  request_id: string;
  trace_id: string;
  traceparent: string;
  method: string;
  path: string;
  user_agent: string | null;
  // Edge metadata from `request.cf`. Always populated on the production
  // edge; can be `undefined` under vitest-pool-workers when calling via
  // SELF.fetch, hence the optional chaining at the read site.
  cf: {
    ray: string | null;
    colo: string | null;
    country: string | null;
  };
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
  // `request.cf` is populated for inbound requests on the production edge,
  // but is `undefined` under vitest-pool-workers' SELF.fetch — so we read
  // through `?.`.
  const cf = request.cf as IncomingRequestCfProperties | undefined;

  return {
    timestamp: new Date().toISOString(),
    level: "INFO",
    service: env.SERVICE_NAME,
    service_version: env.SERVICE_VERSION,
    environment: env.ENVIRONMENT,
    request_id: cfRay ?? crypto.randomUUID(),
    trace_id: traceId,
    traceparent,
    method: request.method,
    path: url.pathname,
    user_agent: request.headers.get("user-agent"),
    cf: {
      ray: cfRay,
      colo: cf?.colo ?? null,
      country: cf?.country ?? null,
    },
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
    // Emit the wide event as a structured object — Workers Logs serializes
    // and indexes each nested field. Passing JSON.stringify would land it as
    // a single `message` string and lose searchability per-field.
    // https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects
    if (event.level === "ERROR") {
      console.error(event);
    } else {
      console.log(event);
    }

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

interface UpstreamResult {
  status_code: number;
  duration_ms: number;
  ok: boolean;
  // The `traceparent` value the upstream service reports having received.
  // Echoed back to the client so the PoC's propagation guarantee is visible
  // in a single curl.
  saw_traceparent: string | null;
}

/**
 * httpbin.org/headers returns `{ "headers": { "Header-Name": "value", ... } }`
 * with whatever casing it saw. Pluck out `traceparent` case-insensitively so
 * we don't depend on httpbin's casing remaining stable.
 */
function extractSawTraceparent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const headers = (payload as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === "traceparent" && typeof value === "string") {
      return value;
    }
  }
  return null;
}

async function callUpstream(ctx: RequestContext): Promise<UpstreamResult> {
  const startTime = Date.now();
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout, ctx.signal]);

  try {
    const response = await fetch(ctx.env.UPSTREAM_URL, {
      method: "GET",
      headers: { traceparent: ctx.traceparent },
      signal,
    });
    // Parse the body so we can surface what the upstream actually received.
    // Tolerate non-JSON responses (e.g., upstream errors): fall back to null.
    let saw: string | null = null;
    try {
      saw = extractSawTraceparent(await response.json());
    } catch {
      // Drain anyway so the runtime doesn't warn about leaked streams.
      // `response.json()` already consumed the body on success; on parse
      // failure, the body may be partially read — that's fine, we don't need
      // it.
    }
    return {
      status_code: response.status,
      duration_ms: Date.now() - startTime,
      ok: response.ok,
      saw_traceparent: saw,
    };
  } catch (error) {
    return {
      status_code: error instanceof Error && error.name === "TimeoutError" ? 504 : 0,
      duration_ms: Date.now() - startTime,
      ok: false,
      saw_traceparent: null,
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
    // Proof of propagation: the `traceparent` httpbin reports seeing. Should
    // equal the `traceparent` response header on this response.
    upstream_saw: { traceparent: upstream.saw_traceparent },
  });
}

export default {
  fetch: withCanonicalEvent(demoHandler),
} satisfies ExportedHandler<Env>;
