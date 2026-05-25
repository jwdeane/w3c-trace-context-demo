# W3C Trace Context PoC

Minimal Cloudflare Worker demonstrating end-to-end W3C trace context handling:

- Parse inbound `traceparent` per the [W3C spec](https://www.w3.org/TR/trace-context/).
- Optionally **trust and continue** the upstream trace, or start a fresh one.
- **Propagate** `traceparent` to the downstream `fetch` call.
- Emit **one structured "canonical event"** log line per request, tagged with the trace ID.
- **Always return** `traceparent` on the response — including 5xx — so clients can correlate.

The handler itself is intentionally trivial: it makes one outbound call and returns a JSON body. All the interesting code is in `src/index.ts` around `startTrace`, `withCanonicalEvent`, and `callUpstream`.

## Run

```sh
npm install
npm test          # vitest: three trace-context cases, in-process, no dev server needed
```

The tests run the Worker inside `@cloudflare/vitest-pool-workers` and mock the upstream `fetch`, so they're hermetic and finish in well under a second.

To poke at it interactively:

```sh
npm run dev       # http://localhost:8787
```

You'll see a JSON canonical event in the dev console for each request, and the response will include a `traceparent` header. For an inbound trace, the response traceparent shares the same `trace_id` (chars 4–35) as the one you sent.

### Smoke-testing a deployed Worker

`./smoke.sh` (also exposed as `npm run smoke`) is a curl-based script that hits a running Worker — useful for verifying a real deployment end-to-end (including the live upstream call):

```sh
# Against `npm run dev` in another terminal:
npm run smoke

# Against a deployed Worker:
BASE_URL=https://w3c-trace-context-demo.example.workers.dev npm run smoke
```

## Configuration

`wrangler.jsonc` vars:

| Var                          | Purpose                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `SERVICE_NAME`               | Tagged on every log line.                                |
| `ENVIRONMENT`                | Tagged on every log line.                                |
| `TRUST_INCOMING_TRACEPARENT` | `"true"` to continue inbound traces; else always start a new one. |
| `UPSTREAM_URL`               | The downstream service we propagate `traceparent` to.    |

## What this is *not*

- Not a tracing backend — log lines are JSON on stdout. Wire them to your sink of choice (Workers Logs, Logpush, etc).
- Not a sampler — every request emits one event with flags `01` (sampled) when a new trace is started.
- Not validated input parsing — there's no request body to parse. A real service should use zod/valibot at the boundary.

## Key files

- `src/index.ts` — everything.
- `wrangler.jsonc` — Worker config + demo vars.
