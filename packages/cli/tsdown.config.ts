import { defineConfig } from "tsdown";

// The CLI is the ONE package here that Node executes directly, and that makes it the one package
// `tsc` alone cannot ship. Every euroclaw package compiles under `moduleResolution: "Bundler"`, so
// its emitted JS carries extensionless relative imports — fine for bundlers and vitest, unresolvable
// by Node's ESM loader. Bundling sidesteps it by inlining those modules entirely.
//
// So the workspace packages are bundled IN (`noExternal`) while real npm dependencies stay external
// and get installed normally. Same approach as @better-auth/cli, which bundles with tsdown for the
// same reason.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	platform: "node",
	dts: true,
	clean: true,
	deps: { alwaysBundle: [/^@euroclaw\//, "euroclaw"] },
	external: ["commander", "jiti", "kysely", "better-sqlite3", "pg"],
});
