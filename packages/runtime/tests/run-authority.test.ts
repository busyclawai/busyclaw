// R-H03 — the run's authority is ONE derivation, not several that happen to agree.
//
// It used to be derived in three places. `resolveRunContext` ran the host's identity/membership/
// configScope resolvers to pick TOOLS; `resolveGovernanceContext` ran them again to decide POLICY,
// stamping the authenticated caller over the top of only that second answer; and core re-ran them at
// each of its six boundary doors. Nothing compared the results.
//
// Each test below is one way the answers came apart. They are behavioural on purpose: the split was
// invisible in types — every derivation had the same shape, they just ran at different moments and
// were handed different starting material.

import {
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	MEMBERSHIPS_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	type ToolDefinitionSet,
	UNSCOPED,
	userPrincipal,
} from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { memoryAdapter } from "@busyclaw/storage-core";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { jsonSchema, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
	createRuntime,
	govern,
	runtimeRunOptionsWithCaller,
} from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

const USAGE = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/** Calls each named tool once, in order, one per step, then stops. */
function callsInOrder(...toolNames: string[]): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			const toolName = toolNames[step++];
			if (toolName !== undefined) {
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: `c${step}`,
							toolName,
							input: "{}",
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage: USAGE,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: { unified: "stop", raw: undefined },
				usage: USAGE,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

const noopTool = () =>
	govern(
		{
			description: "Does nothing; the test is about the context around it.",
			inputSchema: jsonSchema({ type: "object", properties: {} }),
			execute: async () => ({ ok: true }),
		},
		{ access: "read" },
	);

describe("the run's authority is derived once", () => {
	it("the tool resolver sees the principal the floor will authorize", async () => {
		// The sharpest consequence of the split. `registeredToolResolver` closure-captures
		// `ctx[principal]` at synthesis time to stamp on the outbound call; the floor decides using the
		// principal stamped later. When those were two derivations, a registered tool's request went out
		// under one identity while the decision that permitted it named another.
		let toolResolverSaw: unknown;
		let gateSaw: unknown;
		const runtime = createRuntime({
			model: callsInOrder("t"),
			tools: { t: noopTool() },
			// The caller-LESS fallback. An authenticated run must not take its answer.
			identity: () => "user:resolver-answer",
			resolveTools: (ctx) => {
				toolResolverSaw = ctx[PRINCIPAL_CONTEXT_KEY];
				return {} as ToolDefinitionSet;
			},
			plugins: [
				{
					id: "watch",
					gates: [
						{
							id: "watch",
							matcher: () => true,
							handler: (_call, ctx) => {
								gateSaw = ctx[PRINCIPAL_CONTEXT_KEY];
								return { decision: "permit" };
							},
						},
					],
				},
			],
		});
		await runtime.generate(
			"go",
			{},
			runtimeRunOptionsWithCaller(undefined, "user:caller"),
		);
		expect(gateSaw).toBe("user:caller");
		expect(toolResolverSaw).toBe("user:caller");
	});

	it("membership is looked up for the caller, not for the identity resolver's answer", async () => {
		// The membership resolver resolves FOR `ctx[principal]`. With the caller stamped only
		// afterwards, the lookup ran against the resolver's answer — so a run could be authorized as
		// one person while carrying another person's boundaries and roles.
		const askedAbout: string[] = [];
		let gateRole: unknown;
		const runtime = createRuntime({
			model: callsInOrder("t"),
			tools: { t: noopTool() },
			identity: () => "user:resolver-answer",
			membership: async (ctx) => {
				const principal = ctx[PRINCIPAL_CONTEXT_KEY];
				if (typeof principal !== "string") return undefined;
				askedAbout.push(principal);
				return [
					{
						scope: "team",
						scopeId: "acme",
						role: principal === "user:caller" ? "admin" : "guest",
					},
				];
			},
			plugins: [
				{
					id: "watch",
					gates: [
						{
							id: "watch",
							matcher: () => true,
							handler: (_call, ctx) => {
								gateRole = ctx[MEMBERSHIPS_CONTEXT_KEY];
								return { decision: "permit" };
							},
						},
					],
				},
			],
		});
		await runtime.generate(
			"go",
			{},
			runtimeRunOptionsWithCaller(undefined, "user:caller"),
		);
		expect(askedAbout).toEqual(["user:caller"]);
		expect(gateRole).toEqual([
			{ scope: "team", scopeId: "acme", role: "admin" },
		]);
	});

	it("the host's resolvers run ONCE per run, not once per door", async () => {
		// Six `resolveCtx` sites in core, one per boundary kind. A resolver that reads a mutable store
		// — a role lookup, a session — therefore answered per boundary crossing, and one run could hold
		// two different authorities with nothing recording that it changed.
		let identityCalls = 0;
		let scopeCalls = 0;
		const seenScopes = new Set<unknown>();
		const runtime = createRuntime({
			model: callsInOrder("t", "t"), // two tool calls ⇒ several boundary crossings
			tools: { t: noopTool() },
			identity: () => {
				identityCalls++;
				// Answers differently every time — exactly the drift the old shape let through.
				return `user:call-${identityCalls}`;
			},
			configScope: () => {
				scopeCalls++;
				return { scope: "organization", scopeId: `org-${scopeCalls}` };
			},
			plugins: [
				{
					id: "watch",
					gates: [
						{
							id: "watch",
							matcher: () => true,
							handler: (_call, ctx) => {
								seenScopes.add(ctx[CONFIG_SCOPE_ID_CONTEXT_KEY]);
								return { decision: "permit" };
							},
						},
					],
				},
			],
		});
		await runtime.generate("go", {});
		expect(identityCalls).toBe(1);
		expect(scopeCalls).toBe(1);
		// The point of the count: every door saw the SAME answer, so a drifting resolver cannot make
		// one run two runs.
		expect([...seenScopes]).toEqual(["org-1"]);
	});
});

// A resume is the one place two derivations can still meet: the parked run had an authority, and the
// caller continuing it supplies a fresh `ctx` that resolves another. Nothing compared them — so an
// approval granted in one tenant could be finished in another, against that tenant's registered tools
// and its credentials.

const parkingTool = () =>
	govern(
		{
			description: "Parks for approval, then runs.",
			inputSchema: jsonSchema({ type: "object", properties: {} }),
			execute: async () => ({ ok: true }),
		},
		{ gate: () => ({ decision: "needs-approval" }), access: "read" },
	);

/** A runtime whose config scope comes from `ctx.org` — the multi-tenant shape the finding is about. */
function tenantRuntime() {
	const db = memoryAdapter();
	return createRuntime({
		model: callsInOrder("t"),
		database: db,
		redactor: createStoredRedactor({
			detector: () => [],
			mappings: createPiiMappingStore(db),
		}),
		tools: { t: parkingTool() },
		configScope: (ctx) =>
			typeof ctx.org === "string"
				? { scope: "organization", scopeId: ctx.org }
				: undefined,
	});
}

async function parkIn(
	runtime: ReturnType<typeof tenantRuntime>,
	org: string,
): Promise<string> {
	const waiting = await runtime.generate("go", { org });
	const approvalId =
		waiting.status === "waiting_approval"
			? waiting.approvalIds?.[0]
			: undefined;
	if (approvalId === undefined) throw new Error("expected an approval");
	await runtime.approvals?.grant(approvalId, userPrincipal("alice"));
	return approvalId;
}

describe("a resume cannot change tenant", () => {
	it("refuses an approval resumed into a different boundary", async () => {
		const runtime = tenantRuntime();
		const approvalId = await parkIn(runtime, "org-a");
		// The record's scope columns are immutable and say org-a. This ctx says org-b — which is what
		// picks the tools and resolves the credentials the approved call would use.
		await expect(
			runtime.continueRun(approvalId, { org: "org-b" }),
		).rejects.toThrow(/belongs to a different boundary/);
	});

	it("names both boundaries, because the operator has to tell which is wrong", async () => {
		const runtime = tenantRuntime();
		const approvalId = await parkIn(runtime, "org-a");
		await expect(
			runtime.continueRun(approvalId, { org: "org-b" }),
		).rejects.toMatchObject({
			details: {
				approvedIn: { scope: "organization", scopeId: "org-a" },
				resumedIn: { scope: "organization", scopeId: "org-b" },
			},
		});
	});

	it("resumes normally in the boundary it was approved in", async () => {
		// The check must not be a blanket refusal of resumes — this is the case that carries that weight.
		const runtime = tenantRuntime();
		const approvalId = await parkIn(runtime, "org-a");
		expect(
			(await runtime.continueRun(approvalId, { org: "org-a" }))?.status,
		).toBe("completed");
	});

	it("a single-tenant deployment resolves no boundary and resumes fine", async () => {
		// Absent on both sides is agreement, not a mismatch — otherwise every deployment without a
		// configScope resolver would be unable to resume anything.
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: callsInOrder("t"),
			database: db,
			redactor: createStoredRedactor({
				detector: () => [],
				mappings: createPiiMappingStore(db),
			}),
			tools: { t: parkingTool() },
		});
		const waiting = await runtime.generate("go");
		const approvalId =
			waiting.status === "waiting_approval"
				? waiting.approvalIds?.[0]
				: undefined;
		if (approvalId === undefined) throw new Error("expected an approval");
		await runtime.approvals?.grant(approvalId, userPrincipal("alice"));
		expect((await runtime.continueRun(approvalId))?.status).toBe("completed");
	});
});

/** Yields once (the tool burns past the soft deadline), then finishes. */
function yieldingRuntime() {
	const db = memoryAdapter();
	let clock = 0;
	return createRuntime({
		model: callsInOrder("t", "t"),
		database: db,
		environment: { now: () => new Date(clock).toISOString() },
		// The fake clock jumps past the soft deadline inside the tool; without a long lease the effect
		// it holds expires mid-call and the failure under test never gets reached.
		effectLeaseTtlMs: 600_000,
		redactor: createStoredRedactor({
			detector: () => [],
			mappings: createPiiMappingStore(db),
		}),
		tools: {
			t: govern(
				{
					description: "Burns past the soft deadline.",
					inputSchema: jsonSchema({ type: "object", properties: {} }),
					execute: async () => {
						clock += 100_000;
						return { ok: true };
					},
				},
				{ access: "read" },
			),
		},
		configScope: (ctx) =>
			typeof ctx.org === "string"
				? { scope: "organization", scopeId: ctx.org }
				: undefined,
	});
}

describe("a yield cannot be resumed into another tenant", () => {
	it("refuses, and names both boundaries", async () => {
		// A parked APPROVAL has immutable scope columns to compare against. A yield checkpoint had
		// nothing — so a continuation could name any tenant and finish the run against its tools and
		// secrets. The checkpoint now carries the anchor.
		const runtime = yieldingRuntime();
		const first = await runtime.generate(
			"go",
			{ org: "org-a" },
			{
				deadlineAt: new Date(50_000).toISOString(),
			},
		);
		if (first.status !== "yielded") throw new Error("expected a yield");
		await expect(
			runtime.resumeRun(first.checkpointId, { org: "org-b" }),
		).rejects.toMatchObject({
			details: {
				yieldedIn: { scope: "organization", scopeId: "org-a" },
				resumedIn: { scope: "organization", scopeId: "org-b" },
			},
		});
	});

	it("resumes in the boundary it yielded from", async () => {
		// The case that keeps the check from being a blanket refusal of every yield resume.
		const runtime = yieldingRuntime();
		const first = await runtime.generate(
			"go",
			{ org: "org-a" },
			{
				deadlineAt: new Date(50_000).toISOString(),
			},
		);
		if (first.status !== "yielded") throw new Error("expected a yield");
		expect(
			(await runtime.resumeRun(first.checkpointId, { org: "org-a" }))?.status,
		).toBe("completed");
	});
});

// A run's boundary is ALWAYS a value. Six consumers used to each decide what an absent one meant —
// five narrowed, one widened — and no signature carrying `ScopeRef | undefined` could say which was
// intended. `UNSCOPED` is the answer for "this run names no tenant", the same move `UNCONTAINED`
// already made for the redaction container.
describe("every run carries a boundary", () => {
	const boundarySeenBy = async (
		config: Partial<Parameters<typeof createRuntime>[0]>,
		ctx: Record<string, unknown> = {},
	): Promise<{ scope: unknown; scopeId: unknown }> => {
		let seen: { scope: unknown; scopeId: unknown } = {
			scope: undefined,
			scopeId: undefined,
		};
		const runtime = createRuntime({
			model: callsInOrder("t"),
			tools: { t: noopTool() },
			plugins: [
				{
					id: "watch",
					gates: [
						{
							id: "watch",
							matcher: () => true,
							handler: (_call, c) => {
								seen = {
									scope: c[CONFIG_SCOPE_CONTEXT_KEY],
									scopeId: c[CONFIG_SCOPE_ID_CONTEXT_KEY],
								};
								return { decision: "permit" };
							},
						},
					],
				},
			],
			...config,
		});
		await runtime.generate("go", ctx);
		return seen;
	};

	it("a deployment with no configScope resolver still names one — the unscoped boundary", async () => {
		expect(await boundarySeenBy({})).toEqual(UNSCOPED);
	});

	it("a resolver that returns undefined for THIS run lands there too", async () => {
		// The multi-tenant deployment whose resolver could not place a particular request. It gets the
		// boundary that finds nothing, not a missing key each consumer reads its own way.
		expect(
			await boundarySeenBy({ configScope: () => undefined }, { org: "org-a" }),
		).toEqual(UNSCOPED);
	});

	it("half a resolved key names no boundary and collapses to the same one", async () => {
		// Collapsed at the ONE place that answers the question. A half-named boundary used to form its
		// own bucket — distinct from the absent one and from every real tenant — which is an open family
		// of near-misses rather than a case anything could handle.
		expect(
			await boundarySeenBy({
				configScope: () => ({ scope: "organization" }) as never,
			}),
		).toEqual(UNSCOPED);
	});

	it("a real boundary is passed through untouched", async () => {
		// The case that keeps the three above from passing because everything collapses.
		expect(
			await boundarySeenBy(
				{
					configScope: (c) =>
						typeof c.org === "string"
							? { scope: "organization", scopeId: c.org }
							: undefined,
				},
				{ org: "org-a" },
			),
		).toEqual({ scope: "organization", scopeId: "org-a" });
	});
});

describe("the authority is a PARSE boundary, not a cast", () => {
	// The principal goes into the context typed and comes back out as `unknown` — the one place in a run
	// where the brand is lost. `captureAuthority` re-establishes it with `asPrincipal`, so a resolver that
	// answers a bare host id is rejected HERE, once, instead of stamping a value that every door
	// downstream then compares, logs and authorizes against. `identity` is typed to return a `Principal`,
	// so reaching this needs a cast — which is exactly the host that would have gotten through before.
	const runWithIdentity = async (answer: string): Promise<void> => {
		const runtime = createRuntime({
			model: callsInOrder("t"),
			tools: { t: noopTool() },
			identity: (() => answer) as never,
		});
		await runtime.generate("go", {});
	};

	it("an untagged host id is refused rather than stamped", async () => {
		// `alice` — what a host passes when it wires `getSession().user.id` straight through. It is not a
		// principal: nothing downstream can tell it from a system name, and the owner rule would compare
		// it against tagged values forever without matching.
		await expect(runWithIdentity("alice")).rejects.toThrow(/principal/i);
	});

	it("an unknown kind is refused too — the tag is checked, not just present", async () => {
		// A colon alone is not the contract. Exactly `user:` and `system:` are principals, so an
		// `agent:`-tagged value is rejected at the same door — the deliberate absence of an agent
		// principal kind is enforced here, not only documented.
		await expect(runWithIdentity("agent:claw-7")).rejects.toThrow(/principal/i);
	});

	it("a well-formed principal passes through untouched", async () => {
		// The guard above is worthless if it also rejects the real thing.
		await expect(
			runWithIdentity(userPrincipal("alice")),
		).resolves.toBeUndefined();
	});
});
