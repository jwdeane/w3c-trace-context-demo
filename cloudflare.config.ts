import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "w3c-trace-context-demo",
		compatibilityDate: "2026-03-10",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		observability: {
			logs: {
				enabled: true,
				invocationLogs: true,
			},
			traces: {
				enabled: true,
			},
		},
		env: {
			SERVICE_NAME: bindings.text("w3c-trace-context-demo"),
			SERVICE_VERSION: bindings.text("0.0.0"),
			ENVIRONMENT: bindings.text("dev"),
			TRUST_INCOMING_TRACEPARENT: bindings.text("true"),
			UPSTREAM_URL: bindings.text("https://httpbin.org/headers"),
		},
	},
});
