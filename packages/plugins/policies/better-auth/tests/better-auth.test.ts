import type { ToolCall } from "@euroclaw/contracts";
import { createGovernance } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import { type AuthWithPermission, betterAuthAccessControl } from "../src/index";

const runEcho = (call: ToolCall) => ({ ran: call.name });

// A stub better-auth: "this user" can execute the resources/actions in `allowed`. hasPermission
// ignores the headers (real better-auth resolves the user/org/role FROM them) and answers from the
// requested permission — which is exactly the seam euroclaw delegates to. Records the calls.
function stubAuth(
	allowed: Record<string, string[]>,
): AuthWithPermission & { calls: { headers: Headers }[] } {
	const calls: { headers: Headers }[] = [];
	return {
		calls,
		api: {
			hasPermission: async ({ headers, body }) => {
				calls.push({ headers });
				const success = Object.entries(body.permissions).every(
					([resource, actions]) =>
						actions.every((a) => allowed[resource]?.includes(a)),
				);
				return { success };
			},
		},
	};
}

const headers = new Headers({ cookie: "session=abc" });

describe("@euroclaw/policy-better-auth — delegates to auth.api.hasPermission", () => {
	it("permits a tool the user has permission for", async () => {
		const auth = stubAuth({ refund: ["execute"] });
		const core = createGovernance({
			plugins: [betterAuthAccessControl({ auth })],
			runTool: runEcho,
		});
		const r = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ headers },
		);
		expect(r.status).toBe("ok");
	});

	it("denies a tool the user lacks permission for (deny = no grant)", async () => {
		const auth = stubAuth({ refund: ["execute"] });
		const core = createGovernance({
			plugins: [betterAuthAccessControl({ auth })],
			runTool: runEcho,
		});
		const r = await core.handleToolCall(
			{ name: "delete_db", args: {} },
			{ headers },
		);
		expect(r.status).toBe("denied");
	});

	it("forwards the request headers to hasPermission (better-auth resolves the rest)", async () => {
		const auth = stubAuth({ refund: ["execute"] });
		const core = createGovernance({
			plugins: [betterAuthAccessControl({ auth })],
			runTool: runEcho,
		});
		await core.handleToolCall({ name: "refund", args: {} }, { headers });
		expect(auth.calls[0]?.headers).toBe(headers);
	});

	it("a custom mapCall targets the org's real resources/actions", async () => {
		// The org's `createAccessControl` declares `transaction: ["refund"]`; map the tool onto it.
		const auth = stubAuth({ transaction: ["refund"] });
		const core = createGovernance({
			plugins: [
				betterAuthAccessControl({
					auth,
					mapCall: (_call, ctx) => ({
						principal: { type: "User", id: "" },
						action: { type: "Action", id: "refund" },
						resource: { type: "Tool", id: "transaction" },
						context: { headers: ctx.headers },
					}),
				}),
			],
			runTool: runEcho,
		});
		const r = await core.handleToolCall(
			{ name: "do_refund", args: {} },
			{ headers },
		);
		expect(r.status).toBe("ok");
	});

	it("prefix namespaces the permission resource as <prefix>:<tool>", async () => {
		const auth = stubAuth({ "agent:refund": ["execute"] });
		const core = createGovernance({
			plugins: [betterAuthAccessControl({ auth, prefix: "agent" })],
			runTool: runEcho,
		});
		const r = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ headers },
		);
		expect(r.status).toBe("ok");
	});
});
