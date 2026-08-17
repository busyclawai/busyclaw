import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// ONE SCENARIO AT A TIME.
		//
		// Every test here builds a whole stack — a SQLite database, migrations, one or more assembled
		// claws with their engines — and there are a dozen files doing it. Run in parallel they compete
		// for memory and CPU rather than for anything under test, and the result is a handful of
		// failures in a different place each run.
		//
		// That is worse than slow: a red run stops meaning anything, which costs more than the minute
		// this saves. The scenarios are seconds each; the suite is still fast enough to run on every
		// change, and now a failure is a finding.
		fileParallelism: false,
	},
});
