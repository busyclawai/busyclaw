import type {
	PolicyEngine,
	PolicyEngineCapabilities,
	PolicyRequest,
	PolicyResult,
} from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { createShadowPolicyEngine, type ShadowDivergence } from "../src/index";

const req = (action = "x"): PolicyRequest => ({
	principal: { type: "User", id: "alice" },
	action: { type: "Action", id: action },
	resource: { type: "Tool", id: action },
	context: {},
});

const fixed = (
	result: PolicyResult,
	capabilities?: PolicyEngineCapabilities,
): PolicyEngine => ({
	capabilities,
	authorize: () => result,
});

/** An engine whose authorize REJECTS — a broken shadow policy at evaluation time. */
const rejecting = (): PolicyEngine => ({
	authorize: () => Promise.reject(new Error("candidate blew up")),
});

describe("createShadowPolicyEngine", () => {
	it("agreeing decisions → no observe, returns the live result verbatim", async () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "permit", policies: ["live"] }),
			candidate: () => fixed({ decision: "permit", policies: ["cand"] }),
			observe: (d) => seen.push(d),
		});
		const result = await engine.authorize(req());
		expect(result).toEqual({ decision: "permit", policies: ["live"] }); // LIVE, not candidate
		expect(seen).toHaveLength(0);
	});

	it("candidate denies what live permits → observe once, still returns LIVE", async () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "permit", policies: ["live"] }),
			candidate: () => fixed({ decision: "deny" }),
			observe: (d) => seen.push(d),
		});
		const result = await engine.authorize(req("readDoc"));
		expect(result.decision).toBe("permit"); // shadow NEVER changes the answer
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ live: "permit", candidate: "deny" });
		expect(seen[0]?.request.action.id).toBe("readDoc");
	});

	it("records the divergence the other direction too (live deny / candidate permit)", async () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "deny" }),
			candidate: () => fixed({ decision: "permit" }),
			observe: (d) => seen.push(d),
		});
		const result = await engine.authorize(req());
		expect(result.decision).toBe("deny"); // live stands
		expect(seen[0]).toMatchObject({ live: "deny", candidate: "permit" });
	});

	// Per-decision entities reach BOTH sides. Live, because a wrapper that narrows what the request may
	// name is not observing the decision — it is changing it, and installing a shadow slice would have
	// denied every run-registered action. Candidate, because comparing against a narrower world reports
	// divergences the candidate policy never caused, which is exactly the signal shadow mode exists to
	// produce honestly.
	it("forwards per-decision entities to BOTH live and candidate", async () => {
		const live: unknown[] = [];
		const candidate: unknown[] = [];
		const record = (into: unknown[]): PolicyEngine => ({
			authorize: (_r, entities) => {
				into.push(entities);
				return { decision: "permit" };
			},
		});
		const engine = createShadowPolicyEngine({
			live: record(live),
			candidate: () => record(candidate),
			observe: () => {},
		});
		await engine.authorize(req(), [{ uid: { type: "Action", id: "x" } }]);
		expect(live).toEqual([[{ uid: { type: "Action", id: "x" } }]]);
		expect(candidate).toEqual([[{ uid: { type: "Action", id: "x" } }]]);
	});

	it("forwards per-decision entities when the candidate failed to build", async () => {
		const live: unknown[] = [];
		const engine = createShadowPolicyEngine({
			live: {
				authorize: (_r, entities) => {
					live.push(entities);
					return { decision: "permit" };
				},
			},
			candidate: () => {
				throw new Error("malformed shadow slice");
			},
			observe: () => {},
		});
		// The passthrough branch is a SECOND call site for the same argument, and the one a broken
		// customer slice actually lands on.
		await engine.authorize(req(), [{ uid: { type: "Action", id: "x" } }]);
		expect(live).toEqual([[{ uid: { type: "Action", id: "x" } }]]);
	});

	it("passes through the live engine's capabilities", () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed(
				{ decision: "permit" },
				{ reads: "identity+args", approvals: true },
			),
			candidate: () => fixed({ decision: "permit" }),
			observe: (d) => seen.push(d),
		});
		expect(engine.capabilities).toEqual({
			reads: "identity+args",
			approvals: true,
		});
	});

	// ── isolation: a "safe to experiment with" shadow slice must NEVER break live authz ──────────

	it("a candidate that throws at BUILD disables shadow, serves live, surfaces the error", async () => {
		const buildErrors: unknown[] = [];
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "permit", policies: ["live"] }),
			// a malformed shadow policy set throws at construction
			candidate: () => {
				throw new Error("malformed shadow policy set");
			},
			observe: (d) => seen.push(d),
			onCandidateBuildError: (e) => buildErrors.push(e),
		});
		const result = await engine.authorize(req());
		expect(result).toEqual({ decision: "permit", policies: ["live"] }); // live unaffected
		expect(seen).toHaveLength(0); // no candidate → nothing to diverge
		expect(buildErrors).toHaveLength(1); // surfaced, not swallowed silently
	});

	it("a candidate that REJECTS at authorize is swallowed → live returned, no throw", async () => {
		const seen: ShadowDivergence[] = [];
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "permit", policies: ["live"] }),
			candidate: () => rejecting(),
			observe: (d) => seen.push(d),
		});
		const result = await engine.authorize(req()); // must NOT reject
		expect(result).toEqual({ decision: "permit", policies: ["live"] });
		expect(seen).toHaveLength(0);
	});

	it("a throwing observer does not change or crash the live decision", async () => {
		const engine = createShadowPolicyEngine({
			live: fixed({ decision: "permit", policies: ["live"] }),
			candidate: () => fixed({ decision: "deny" }), // diverges → observe fires
			observe: () => {
				throw new Error("observer blew up");
			},
		});
		const result = await engine.authorize(req()); // must NOT reject
		expect(result.decision).toBe("permit");
	});
});
