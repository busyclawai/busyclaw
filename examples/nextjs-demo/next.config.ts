import type { NextConfig } from "next";

const config: NextConfig = {
	// The claw is assembled once per server process and must never be bundled into a route's
	// client graph. `euroclaw` and its foundation packages are server-only by nature (storage,
	// policy engine, the model provider), so they stay external to the server bundle rather than
	// being traced and rewritten by Turbopack.
	serverExternalPackages: [
		"euroclaw",
		"@euroclaw/adapter-core",
		"@euroclaw/core",
		"@euroclaw/storage-core",
		"@euroclaw/storage-durable",
		"@euroclaw/authz",
		"@euroclaw/policy-cedar",
		"@cedar-policy/cedar-wasm",
	],
};

export default config;
