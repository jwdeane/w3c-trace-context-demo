# W3C Trace Context Demo

> [!WARNING]
> This repository is demo code, not production code. It intentionally omits production concerns such as full W3C Trace Context support, robust input validation, complete error handling, sampling policy, security review, and deployment hardening.

Cloudflare Workers demo showing two levels of W3C `traceparent` handling:

- `src/index.ts` — the default, documented implementation with structured logging, timeout handling, and a JSON response that proves downstream propagation.
- `src/index.minimal.ts` — a true MVP that only creates/continues `traceparent`, forwards it to `fetch`, and returns it on the response.

The default implementation demonstrates:

- Parse inbound W3C version `00` `traceparent` headers.
- Optionally **trust and continue** the upstream trace, or start a fresh one.
- **Propagate** `traceparent` to the downstream `fetch` call.
- Emit **one structured "canonical event"** log line per request, tagged with the trace ID.
- **Always return** `traceparent` on the response — including 5xx — so clients can correlate.

The default handler itself is intentionally trivial: it makes one outbound call and returns a JSON body. All the interesting code is in `src/index.ts` around `startTrace`, `withCanonicalEvent`, and `callUpstream`.

## Run

```sh
npm install
npm test          # vitest: three trace-context cases for src/index.ts, in-process, no dev server needed
```

The tests run the Worker inside `@cloudflare/vitest-pool-workers` and mock the upstream `fetch`, so they're hermetic and finish in well under a second.

To poke at the default implementation interactively:

```sh
npm run dev       # http://localhost:8787
```

To run the true MVP implementation instead, use the alternate entrypoint on a different port:

```sh
npx wrangler dev src/index.minimal.ts --port 8788
```

Then test it from another terminal:

```sh
curl -i http://localhost:8788/

curl -i \
  -H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' \
  http://localhost:8788/
```

The minimal response should include a `traceparent` header and proxy the upstream body from `httpbin.org/headers`. For the second request, that response header should keep trace ID `0af7651916cd43dd8448eb211c80319c` and use a new parent/span ID.

Each request to the default implementation produces:

- A `traceparent` **response header** (the wire contract for the next hop).
- A JSON body including `trace_id` and `upstream_saw.traceparent` — the `traceparent` the upstream (`httpbin.org/headers`) reports having received. These should match the response header, proving end-to-end propagation in a single curl.
- A structured canonical event in the dev console (and in [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) when deployed).

With the default config, a valid inbound trace produces a response `traceparent` with the same `trace_id` (chars 4–35) as the one you sent.

### Smoke-testing a deployed Worker

`./smoke.sh` (also exposed as `npm run smoke`) is a curl-based script that hits a running default Worker — useful for verifying a real deployment end-to-end (including the live upstream call):

```sh
# Against `npm run dev` in another terminal:
npm run smoke

# Against a deployed Worker:
BASE_URL=https://w3c-trace-context-demo.example.workers.dev npm run smoke
```

The default implementation gives the live `httpbin.org` upstream up to 5 seconds to respond. The smoke script fails if the upstream does not echo the propagated `traceparent`.

The smoke script requires `jq` to parse the Worker JSON response.

## Configuration

`wrangler.jsonc` vars:

| Var                          | Purpose                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVICE_NAME`               | Used by `src/index.ts`; tagged on every canonical event.                                                                                                         |
| `SERVICE_VERSION`            | Used by `src/index.ts`; tagged on every canonical event. Bump on each deploy.                                                                                    |
| `ENVIRONMENT`                | Used by `src/index.ts`; tagged on every canonical event.                                                                                                         |
| `TRUST_INCOMING_TRACEPARENT` | Used by `src/index.ts`; `"true"` to continue inbound traces, otherwise always start a new one. `src/index.minimal.ts` continues any valid inbound `traceparent`. |
| `UPSTREAM_URL`               | Used by both implementations; the downstream service we propagate `traceparent` to. Default is `httpbin.org/headers` so the response echoes what we sent.        |

## What this is _not_

- Not a custom tracing backend — `src/index.ts` writes structured JSON logs with `console.log`, and `wrangler.jsonc` enables Cloudflare Workers Logs/Traces when deployed. Export or route telemetry to your preferred sink as needed.
- Not an application sampler — the full implementation emits one canonical event per request, while `src/index.minimal.ts` emits no logs. New traces use W3C flags `01` by default; continued traces preserve inbound flags.
- Not a complete W3C Trace Context implementation — this demo focuses on `traceparent` only. It does not propagate `tracestate`, parse future `traceparent` versions, normalize reserved trace-flags bits, enforce `tracestate` limits, or define a production trust-boundary policy.
- Not validated input parsing — there's no request body to parse. A real service should use zod/valibot at the boundary.

## Key files

- `src/index.ts` — full/default implementation.
- `src/index.minimal.ts` — true MVP: add and propagate `traceparent` only.
- `wrangler.jsonc` — Worker config + demo vars.
