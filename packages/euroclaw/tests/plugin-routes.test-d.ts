// Type tests (vitest typecheck mode). A passing run means the duplicate-route `@ts-expect-error`
// produced the intended compile-time error — route-path uniqueness is enforced at createClaw.
import type { EuroclawPlugin } from "@euroclaw/contracts";
import { describe, test } from "vitest";
import { createClaw, type RuntimeConfig } from "../src/index";

declare const model: NonNullable<RuntimeConfig["model"]>;

describe("createClaw plugin route paths", () => {
	test("distinct route paths are accepted; duplicate literal paths are rejected", () => {
		const recruitingWebhook: EuroclawPlugin<
			"no-cron",
			["/telegram/recruiting"]
		> = {
			id: "channel:telegram:recruiting",
			routes: [
				{
					method: "POST",
					path: "/telegram/recruiting",
					handler: () => ({ body: { ok: true } }),
				},
			],
		};
		const supportWebhook: EuroclawPlugin<"no-cron", ["/telegram/support"]> = {
			id: "channel:telegram:support",
			routes: [
				{
					method: "POST",
					path: "/telegram/support",
					handler: () => ({ body: { ok: true } }),
				},
			],
		};
		const duplicateWebhook: EuroclawPlugin<
			"no-cron",
			["/telegram/recruiting"]
		> = {
			id: "channel:telegram:duplicate",
			routes: [
				{
					method: "POST",
					path: "/telegram/recruiting",
					handler: () => ({ body: { ok: true } }),
				},
			],
		};
		createClaw({ model, plugins: [recruitingWebhook, supportWebhook] });
		// @ts-expect-error — duplicate literal plugin route paths are rejected
		createClaw({ model, plugins: [recruitingWebhook, duplicateWebhook] });
	});
});
