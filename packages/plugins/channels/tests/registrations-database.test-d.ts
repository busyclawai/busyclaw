// Type tests (vitest typecheck mode). channels() registrations mode owns the channel_registration
// table, so it marks itself `$RequiresDatabase` — and createClaw's RequireDatabaseForPlugins rejects at
// compile time an enabled config that passes no database (a runtime configurationError backstops JS /
// `as any` callers). The storage mirror of the $HasCron→RequireCronHandler fold; models directly on
// dynamic-secret-aliases.test-d.ts.
import { memoryAdapter } from "@euroclaw/storage-core";
import { createClaw, type RuntimeConfig } from "euroclaw";
import { describe, test } from "vitest";
import { channels } from "../src/index";
import { telegram } from "../src/telegram/index";

declare const model: RuntimeConfig["model"];

describe("createClaw channels registrations database requirement", () => {
	test("registrations enabled without a database is a compile error", () => {
		// @ts-expect-error — channels registrations owns a table, so a database is required
		createClaw({
			model,
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
	});

	test("registrations enabled WITH a database type-checks", () => {
		createClaw({
			model,
			database: memoryAdapter(),
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
	});

	test("app-bot mode — registrations off or absent — needs no database", () => {
		createClaw({ model, plugins: [channels([telegram()])] });
		createClaw({
			model,
			plugins: [channels([telegram()], { registrations: { enabled: false } })],
		});
	});
});
