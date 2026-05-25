/**
 * W3C Trace Context Demo for Cloudflare Workers.
 *
 * Cloudflare Workers run TypeScript/JavaScript on Cloudflare's edge network.
 * The runtime exposes standard Web APIs such as Request, Response, Headers,
 * fetch, crypto, and AbortSignal, plus Workers-specific request metadata like
 * `request.cf`. The default export at the bottom of this file is the Worker
 * entrypoint; Cloudflare calls its `fetch` handler for every HTTP request.
 *
 * This demo keeps everything in one module so third parties can read the full
 * request flow top-to-bottom without chasing framework abstractions.
 *
 * Demonstrates:
 *   - Parsing inbound `traceparent` per https://www.w3.org/TR/trace-context/
 *   - Optionally trusting + continuing the incoming trace, or starting a fresh one
 *   - Propagating `traceparent` to downstream services
 *   - Emitting one structured "canonical event" log line per request
 *   - Returning `traceparent` on every response (success and error)
 */

// W3C traceparent version 00 has exactly four dash-separated fields:
//   version-traceid-parentid-flags
// Example:
//   00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
// This regex accepts only version 00, lowercase hex, and the exact field
// lengths from the spec. The all-zero validity checks happen in the parser.
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// Bound the outbound demo request so a slow dependency does not keep the
// Worker invocation and client response open indefinitely.
const UPSTREAM_TIMEOUT_MS = 2_000;

// `Env` describes the environment variables configured in wrangler.jsonc.
// In production Cloudflare supplies these values; in tests the Workers Vitest
// pool loads them from the Wrangler config.
interface Env {
	SERVICE_NAME: string;
	SERVICE_VERSION: string;
	ENVIRONMENT: string;
	TRUST_INCOMING_TRACEPARENT: string;
	UPSTREAM_URL: string;
}

// Parsed form of the traceparent fields this demo needs. The W3C `parent-id`
// is the caller's span id. When this Worker forwards a request, it creates a
// new parent id to represent this Worker's operation in the trace graph.
interface ParsedTraceparent {
	traceId: string;
	parentId: string;
	flags: string;
}

// Minimal dependency-call metadata recorded in the final structured log event.
interface Dependency {
	service: string;
	status_code: number;
	duration_ms: number;
}

// Shape of the structured log emitted once per request. Workers Logs can index
// fields from JSON objects written with console.log({ ... }), which makes one
// wide event more useful than several free-form strings for a demo like this.
interface CanonicalEvent {
	// Workers Logs indexes nested fields, so this is a wide, structured event
	// emitted once per request. Filter in the dashboard by any key, including
	// nested ones like `cf.colo` or `dependencies.status_code`.
	timestamp: string;
	level: 'INFO' | 'ERROR';
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
	outcome?: 'success' | 'error';
	duration_ms?: number;
	error?: { type: string; message: string; stack?: string };
}

// Internal context passed through helpers. This makes the data flow explicit:
// helpers receive the request, env, current trace context, the mutable log
// event, and the cancellation signal instead of reaching into globals.
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

// Generate cryptographically random lowercase hex. Workers expose the Web
// Crypto API globally, so no Node.js `crypto` import is needed. Each byte
// becomes two hex characters.
function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Parse a traceparent header into its pieces. Returning null means "do not
// continue this trace; start a new one instead." The parser is intentionally
// strict for the demo: it accepts only W3C version 00 and lowercase hex.
function parseTraceparent(value: string | null): ParsedTraceparent | null {
	// No header means the caller did not provide trace context.
	if (!value) return null;

	// Malformed trace context should not be propagated as if it were valid.
	const match = TRACEPARENT_RE.exec(value);
	if (!match) return null;

	// TypeScript cannot infer the exact capture-group tuple from RegExp.exec(),
	// so this narrows the successful match to the groups the regex contains.
	const [, traceId, parentId, flags] = match as unknown as [string, string, string, string];

	// The W3C spec reserves all-zero trace ids and parent ids as invalid because
	// they would make unrelated requests look correlated.
	if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;

	return { traceId, parentId, flags };
}

/**
 * Decide the trace context for this request:
 *   - if we trust the inbound traceparent and it parses, continue that trace
 *     with a fresh span id
 *   - otherwise, start a brand new trace
 */
function startTrace(request: Request, trustIncoming: boolean): { traceparent: string; traceId: string } {
	// Header names are case-insensitive. `get("traceparent")` works even if the
	// client sent a different casing, though W3C recommends lowercase on send.
	const incoming = parseTraceparent(request.headers.get('traceparent'));

	// Public endpoints often should not blindly trust caller-provided trace ids:
	// clients can forge ids, request sampling, or create confusing correlations.
	// The environment flag makes this trust boundary explicit for the demo.
	const continued = trustIncoming && incoming;

	// Continuing a trace keeps the trace id but replaces the parent id. Starting
	// a trace generates both ids locally.
	const traceId = continued ? incoming.traceId : randomHex(16);
	const flags = continued ? incoming.flags : '01';
	const parentId = randomHex(8);

	// Emit a version 00 traceparent. Downstream services use this header to
	// correlate their own spans/logs with this Worker invocation.
	return { traceparent: `00-${traceId}-${parentId}-${flags}`, traceId };
}

// ---------------------------------------------------------------------------
// canonical event
// ---------------------------------------------------------------------------

function buildCanonicalEvent(request: Request, env: Env, traceparent: string, traceId: string): CanonicalEvent {
	// Worker requests use the standard URL API. Log only the path to avoid
	// accidentally storing query strings that may contain sensitive data.
	const url = new URL(request.url);

	// Cf-Ray is a Cloudflare-provided request id visible in HTTP headers. It is
	// useful when correlating app logs with Cloudflare support/debugging data.
	// Local tests may not have it, so the event falls back to a random UUID.
	const cfRay = request.headers.get('cf-ray');
	// `request.cf` is populated for inbound requests on the production edge,
	// but is `undefined` under vitest-pool-workers' SELF.fetch — so we read
	// through `?.`.
	const cf = request.cf as IncomingRequestCfProperties | undefined;

	// Create the event near the start of the request, then let the handler append
	// dependency data. The middleware fills in status/outcome/duration before
	// writing the single structured log line.
	return {
		timestamp: new Date().toISOString(),
		level: 'INFO',
		service: env.SERVICE_NAME,
		service_version: env.SERVICE_VERSION,
		environment: env.ENVIRONMENT,
		request_id: cfRay ?? crypto.randomUUID(),
		trace_id: traceId,
		traceparent,
		method: request.method,
		path: url.pathname,
		user_agent: request.headers.get('user-agent'),
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

function withCanonicalEvent(handler: (ctx: RequestContext) => Promise<Response>): ExportedHandlerFetchHandler<Env> {
	// A Worker fetch handler receives `(request, env, ctx)`. This demo does not
	// need `ctx.waitUntil()`, so the third argument is omitted. `env` contains
	// variables and bindings configured by Wrangler/Cloudflare.
	return async (request, env) => {
		// Date.now() is enough for request-level duration logging in this demo.
		const startTime = Date.now();
		const trustIncoming = env.TRUST_INCOMING_TRACEPARENT === 'true';
		const { traceparent, traceId } = startTrace(request, trustIncoming);
		const event = buildCanonicalEvent(request, env, traceparent, traceId);

		// One signal for the whole request: tied to the inbound signal so the
		// runtime can cancel downstream work if the client goes away.
		const signal = request.signal;

		let response: Response;
		try {
			// Run the business logic. This wrapper owns cross-cutting concerns:
			// trace setup, structured logging, error handling, and the response
			// traceparent header.
			response = await handler({ request, env, traceparent, traceId, event, signal });
			event.status_code = response.status;
			event.outcome = response.ok ? 'success' : 'error';
		} catch (error) {
			// Convert unexpected exceptions into a JSON 500 response while recording
			// enough structured context to debug the failure later.
			event.level = 'ERROR';
			event.status_code = 500;
			event.outcome = 'error';
			event.error = {
				type: error instanceof Error ? error.name : 'UnknownError',
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			};
			response = Response.json({ error: 'internal_error' }, { status: 500 });
		}

		event.duration_ms = Date.now() - startTime;
		// Emit the wide event as a structured object — Workers Logs serializes
		// and indexes each nested field. Passing JSON.stringify would land it as
		// a single `message` string and lose searchability per-field.
		// https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects
		if (event.level === 'ERROR') {
			console.error(event);
		} else {
			console.log(event);
		}

		// Always return traceparent on the response — including on errors, where
		// clients need it most to correlate with our logs.
		// Some Response objects have immutable headers, especially responses that
		// originate from fetch(). Create fresh Headers and a fresh Response wrapper
		// before setting the demo's traceparent response header.
		const headers = new Headers(response.headers);
		headers.set('traceparent', traceparent);
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
	// Echoed back to the client so the demo's propagation guarantee is visible
	// in a single curl.
	saw_traceparent: string | null;
}

/**
 * httpbin.org/headers returns `{ "headers": { "Header-Name": "value", ... } }`
 * with whatever casing it saw. Pluck out `traceparent` case-insensitively so
 * we don't depend on httpbin's casing remaining stable.
 */
function extractSawTraceparent(payload: unknown): string | null {
	// Network responses are external input. Treat the parsed JSON as `unknown`
	// until basic shape checks prove it has the httpbin fields we need.
	if (!payload || typeof payload !== 'object') return null;
	const headers = (payload as { headers?: unknown }).headers;
	if (!headers || typeof headers !== 'object') return null;

	// HTTP header names are case-insensitive, and servers display different
	// casing. Normalize the key before comparing.
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (key.toLowerCase() === 'traceparent' && typeof value === 'string') {
			return value;
		}
	}
	return null;
}

async function callUpstream(ctx: RequestContext): Promise<UpstreamResult> {
	const startTime = Date.now();

	// AbortSignal.timeout creates a signal that aborts after the configured
	// number of milliseconds. AbortSignal.any combines that timeout with the
	// inbound request's signal, so the subrequest stops if either the timeout
	// fires or the client disconnects.
	const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
	const signal = AbortSignal.any([timeout, ctx.signal]);

	try {
		// This is the outbound subrequest. In Workers, global fetch is available by
		// default and runs from Cloudflare's network. The key demo behavior is the
		// propagated traceparent header.
		const response = await fetch(ctx.env.UPSTREAM_URL, {
			method: 'GET',
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

		// Return dependency metadata instead of throwing for non-2xx responses. The
		// caller includes this status in both the canonical event and JSON response.
		return {
			status_code: response.status,
			duration_ms: Date.now() - startTime,
			ok: response.ok,
			saw_traceparent: saw,
		};
	} catch (error) {
		// Network failures and aborts land here. The demo records them as a failed
		// dependency call but still returns a client response with traceparent so
		// callers can correlate the failure.
		return {
			status_code: error instanceof Error && error.name === 'TimeoutError' ? 504 : 0,
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
	// The handler is intentionally small: one downstream call and a JSON response.
	// This keeps the focus on the trace-context plumbing around it.
	const upstream = await callUpstream(ctx);

	// Add the downstream call to the canonical event before the middleware logs
	// it. `new URL(...).hostname` keeps logs stable even if UPSTREAM_URL includes
	// a path or query string.
	ctx.event.dependencies.push({
		service: new URL(ctx.env.UPSTREAM_URL).hostname,
		status_code: upstream.status_code,
		duration_ms: upstream.duration_ms,
	});

	return Response.json({
		message: 'hello from the trace context demo',
		trace_id: ctx.traceId,
		upstream_ok: upstream.ok,
		// Proof of propagation: the `traceparent` httpbin reports seeing. Should
		// equal the `traceparent` response header on this response.
		upstream_saw: { traceparent: upstream.saw_traceparent },
	});
}

// Module Worker entrypoint. The `satisfies ExportedHandler<Env>` check gives
// TypeScript the Worker-specific shape without changing the runtime object.
export default {
	fetch: withCanonicalEvent(demoHandler),
} satisfies ExportedHandler<Env>;
