// Type tests (vitest typecheck mode). Prove that channels() derives its cron requirement at compile
// time — app-bot mode from the providers' poll flags, and registrations mode always (the delivery
// queues need a scheduled drain, even though registrations never poll). A passing run means every
// expect-error directive below actually errored.
import { memoryAdapter } from "@busyclaw/storage-core";
import { createClaw, type RuntimeConfig } from "busyclaw";
import { describe, test } from "vitest";
import { type Channel, channels } from "../src/index";
import { telegram } from "../src/telegram/index";

declare const model: NonNullable<RuntimeConfig["model"]>;

// A second provider for the mixed-registry case (channels() rejects duplicate providers at runtime).
// Webhook-only with an explicit `$poll: false`, so it never contributes the cron requirement.
const hooksOnly = {
	provider: "hooks",
	supports: { webhook: true, poll: false },
	mode: "webhook",
	parseInbound: () => [],
	send: async () => {},
	$poll: false,
} satisfies Channel & { readonly $poll: false };

describe("channels cron-handler requirement", () => {
	test("a webhook-only channel registry needs no cronHandler", () => {
		createClaw({ model, plugins: [channels([telegram()])] });
		createClaw({
			model,
			plugins: [channels([telegram({ mode: "webhook" })])],
		});
	});

	test("a poll channel requires cronHandler, statically", () => {
		// @ts-expect-error — a poll channel contributes cron, so cronHandler is required
		createClaw({
			model,
			plugins: [channels([telegram({ mode: "poll" })])],
		});
		// with a cronHandler it type-checks
		createClaw({
			cronHandler: { secret: "s" },
			model,
			plugins: [channels([telegram({ mode: "poll" })])],
		});
	});

	test("a mixed registry with any poller requires cronHandler", () => {
		// @ts-expect-error — one poll channel in the list is enough to require cronHandler
		createClaw({
			model,
			plugins: [channels([hooksOnly, telegram({ mode: "poll" })])],
		});
		// and the webhook-only fixture alone does not
		createClaw({ model, plugins: [channels([hooksOnly])] });
	});
});

// Registrations are still WEBHOOK-ONLY — they never poll. What they now contribute is the queues'
// drain: an admitted delivery whose inline attempt died, and a reply whose send never completed, are
// recoverable only by something that runs later. A registrations deployment with no scheduled drain
// has a durable queue that never drains, which is the same class of quietly-configuration-dependent
// guarantee the durability work existed to remove — so it is a compile error, not a runbook note.
describe("channels registrations require a cron drain", () => {
	test("registrations require cronHandler, statically", () => {
		// @ts-expect-error — the delivery queues contribute a drain, so cronHandler is required
		createClaw({
			database: memoryAdapter(),
			model,
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
		// with a cronHandler it type-checks
		createClaw({
			cronHandler: { secret: "s" },
			database: memoryAdapter(),
			model,
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
	});

	test("an app bot alongside a BYO registration set inherits the requirement", () => {
		// @ts-expect-error — the registration set's drain requires it even though the app bot is webhook-only
		createClaw({
			database: memoryAdapter(),
			model,
			plugins: [
				channels([telegram()]),
				channels([telegram()], { registrations: { enabled: true } }),
			],
		});
		createClaw({
			cronHandler: { secret: "s" },
			database: memoryAdapter(),
			model,
			plugins: [
				channels([telegram()]),
				channels([telegram()], { registrations: { enabled: true } }),
			],
		});
	});
});

describe("channel naming requirement", () => {
	test("two bots of one provider need distinct names, statically", () => {
		// @ts-expect-error — duplicate (provider, name) key: both are telegram:default
		channels([telegram({}), telegram({})]);
		// a named second bot compiles (a named bot names its own token via tokenRef)
		channels([telegram({}), telegram({ name: "sales", tokenRef: "SALES" })]);
		// @ts-expect-error — two bots under the same name collide too
		channels([
			telegram({ name: "sales", tokenRef: "A" }),
			telegram({ name: "sales", tokenRef: "B" }),
		]);
	});

	test("a named bot must carry its own tokenRef, statically", () => {
		// @ts-expect-error — a named app bot requires tokenRef, so two named bots can't collide on a secret
		channels([telegram({ name: "sales" })]);
		// with a tokenRef it compiles
		channels([telegram({ name: "sales", tokenRef: "SALES" })]);
	});

	test("a name must be a URL path segment, statically", () => {
		// @ts-expect-error — "/" is not a path-segment character
		channels([telegram({ name: "registrations/sneaky", tokenRef: "R" })]);
		// @ts-expect-error — neither is a space
		channels([telegram({ name: "sales bot", tokenRef: "R" })]);
		// the full segment alphabet compiles
		channels([telegram({ name: "Sales_bot-2", tokenRef: "R" })]);
	});
});
