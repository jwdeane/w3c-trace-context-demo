interface Env {
	UPSTREAM_URL: string;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-[0-9a-f]{16}-([0-9a-f]{2})$/;

function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function nextTraceparent(request: Request): string {
	const incoming = request.headers.get('traceparent');
	const match = incoming ? TRACEPARENT_RE.exec(incoming) : null;
	const traceId = match?.[1] ?? randomHex(16);
	const flags = match?.[2] ?? '01';

	return `00-${traceId}-${randomHex(8)}-${flags}`;
}

export default {
	async fetch(request, env): Promise<Response> {
		const traceparent = nextTraceparent(request);
		const upstream = await fetch(env.UPSTREAM_URL, {
			headers: { traceparent },
		});
		const headers = new Headers(upstream.headers);

		headers.set('traceparent', traceparent);

		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	},
} satisfies ExportedHandler<Env>;
