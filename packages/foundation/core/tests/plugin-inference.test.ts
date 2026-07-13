import { defineReasonCodes, type EuroclawPlugin } from "@euroclaw/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createGovernance } from "../src/index";

// A throwaway plugin that exercises all three folds + a real gate. Deliberately GENERIC: the governance
// knows nothing about any regime — the types, reason codes, and context fields all come from the plugin.
const examplePlugin = {
	id: "example",
	$Infer: {} as {
		widget: { id: string; size: "small" | "medium" | "large" };
	},
	$InferContext: {} as { tier?: "free" | "pro" },
	$REASON_CODES: defineReasonCodes({
		EXAMPLE_DENIED: "Denied by the example plugin",
		QUOTA_EXCEEDED: "Past the configured quota",
	}),
	gates: [
		{
			id: "example-floor",
			matcher: () => true,
			handler: () => ({ decision: "permit" as const }),
		},
	],
} satisfies EuroclawPlugin;

const costPlugin = {
	id: "cost",
	$Infer: {} as { budget: { limitUsd: number } },
} satisfies EuroclawPlugin;

describe("plugin folds — the better-auth pattern (compile-time, checked by tsc)", () => {
	it("folds $Infer onto ec.$Infer (one and many plugins)", () => {
		const one = createGovernance({ plugins: [examplePlugin] });
		expectTypeOf<typeof one.$Infer.widget>().toEqualTypeOf<{
			id: string;
			size: "small" | "medium" | "large";
		}>();

		const many = createGovernance({ plugins: [examplePlugin, costPlugin] });
		expectTypeOf<typeof many.$Infer.budget>().toEqualTypeOf<{
			limitUsd: number;
		}>();
	});

	it("a config with no plugins exposes no plugin types", () => {
		const ec = createGovernance({});
		// @ts-expect-error — nothing contributed `widget`, so this property does not exist
		type _NoSuchKey = typeof ec.$Infer.widget;
	});

	it("merges plugin $REASON_CODES onto ec.$REASON_CODES (runtime AND type)", () => {
		const ec = createGovernance({ plugins: [examplePlugin] });
		// runtime: real value present (and the access only compiles because the key is typed)
		expect(ec.$REASON_CODES.EXAMPLE_DENIED.code).toBe("EXAMPLE_DENIED");
		expect(ec.$REASON_CODES.EXAMPLE_DENIED.message).toBe(
			"Denied by the example plugin",
		);
		expect(ec.$REASON_CODES.QUOTA_EXCEEDED.message).toBe(
			"Past the configured quota",
		);
		// @ts-expect-error — not a real reason code from any installed plugin
		ec.$REASON_CODES.NOT_A_CODE;
	});

	it("folds $InferContext so the gates you register see the field typed", async () => {
		const ec = createGovernance({ plugins: [examplePlugin] });
		let seen: string | undefined;
		ec.registerGate({
			id: "read-ctx",
			matcher: () => true,
			handler: (_call, ctx) => {
				// typed from the plugin's $InferContext — NOT `unknown`
				expectTypeOf(ctx.tier).toEqualTypeOf<"free" | "pro" | undefined>();
				seen = ctx.tier;
				return { decision: "permit" };
			},
		});

		await ec.handleToolCall({ name: "x", args: {} }, { tier: "pro" });
		expect(seen).toBe("pro");
	});

	it("reserved euroclaw__* context keys cannot be forged by the caller", async () => {
		const seen: unknown[] = [];
		const ec = createGovernance();
		ec.registerGate({
			id: "identity",
			matcher: () => true,
			handler: (_call, ctx) => {
				seen.push(ctx.euroclaw__principal); // the caller's forged value was stripped → undefined
				ctx.euroclaw__principal = "real-subject"; // a trusted gate establishes it
				return { decision: "permit" };
			},
			sealed: true,
		});
		ec.registerGate({
			id: "reader",
			matcher: () => true,
			handler: (_call, ctx) => {
				seen.push(ctx.euroclaw__principal); // now reads the trusted value
				return { decision: "permit" };
			},
		});

		await ec.handleToolCall(
			{ name: "x", args: {} },
			{ euroclaw__principal: "FORGED" },
		);
		expect(seen).toEqual([undefined, "real-subject"]);
	});

	it("a plugin's gates are actually wired at runtime (not just its types)", async () => {
		const ran: string[] = [];
		const ec = createGovernance({
			plugins: [
				{
					id: "tap",
					afterGates: [
						{
							id: "tap-after",
							matcher: () => true,
							handler: (call) => void ran.push(call.name),
						},
					],
				},
			],
		});

		await ec.handleToolCall({ name: "ping", args: {} });
		expect(ran).toEqual(["ping"]);
	});
});
