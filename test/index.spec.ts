import { SELF, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INBOUND_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-b7ad6b7169203331-01`;
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

// ---------------------------------------------------------------------------
// Outbound mocking
//
// The worker forwards every request to `UPSTREAM_URL` (httpbin.org). We stub
// that here so tests are hermetic — no network egress, no flakiness when
// httpbin is slow or down. Each test should install its own interceptor so
// assertions about outbound headers don't bleed between cases.
// ---------------------------------------------------------------------------

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

function mockUpstreamOnce(): { capturedTraceparent: () => string | undefined } {
	let captured: string | undefined;
	fetchMock
		.get("https://httpbin.org")
		.intercept({ method: "GET", path: "/anything" })
		.reply(200, (opts) => {
			const headers = opts.headers as Record<string, string> | undefined;
			captured = headers?.["traceparent"] ?? headers?.["Traceparent"];
			return { ok: true };
		});
	return { capturedTraceparent: () => captured };
}

// ---------------------------------------------------------------------------
// Tests — mirror the three cases in smoke.sh
// ---------------------------------------------------------------------------

describe("w3c trace context worker", () => {
	it("mints a fresh trace when no inbound traceparent is present", async () => {
		const upstream = mockUpstreamOnce();

		const response = await SELF.fetch("https://example.com/");
		const tp = response.headers.get("traceparent") ?? "";

		expect(response.status).toBe(200);
		expect(tp).toMatch(TRACEPARENT_RE);
		expect(tp).not.toContain(INBOUND_TRACE_ID);

		// The minted traceparent should be propagated downstream verbatim.
		expect(upstream.capturedTraceparent()).toBe(tp);

		const body = (await response.json()) as { trace_id: string };
		expect(body.trace_id).toBe(tp.split("-")[1]);
	});

	it("continues an inbound trace (same trace_id, new span id)", async () => {
		const upstream = mockUpstreamOnce();

		const response = await SELF.fetch("https://example.com/", {
			headers: { traceparent: INBOUND_TRACEPARENT },
		});
		const tp = response.headers.get("traceparent") ?? "";

		expect(response.status).toBe(200);
		expect(tp.startsWith(`00-${INBOUND_TRACE_ID}-`)).toBe(true);
		// Same trace, but a *new* span — never echo the inbound parent id back.
		expect(tp).not.toBe(INBOUND_TRACEPARENT);

		expect(upstream.capturedTraceparent()).toBe(tp);

		const body = (await response.json()) as { trace_id: string };
		expect(body.trace_id).toBe(INBOUND_TRACE_ID);
	});

	it("ignores a malformed inbound traceparent and mints a fresh trace", async () => {
		const upstream = mockUpstreamOnce();

		const response = await SELF.fetch("https://example.com/", {
			headers: { traceparent: "not-a-real-traceparent" },
		});
		const tp = response.headers.get("traceparent") ?? "";

		expect(response.status).toBe(200);
		expect(tp).toMatch(TRACEPARENT_RE);
		expect(tp).not.toContain(INBOUND_TRACE_ID);

		expect(upstream.capturedTraceparent()).toBe(tp);
	});
});
