import type {
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
} from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { createOrgPolicyRouter } from "../src/index";

const req = (scopeId?: string): PolicyRequest => ({
	principal: { type: "User", id: "alice" },
	action: { type: "Action", id: "x" },
	resource: { type: "Tool", id: "x" },
	context:
		scopeId !== undefined
			? { configScope: "organization", configScopeId: scopeId }
			: {},
});

/** A fake engine that tags its decision so a test can tell which bundle answered. */
const taggedEngine = (tag: string): PolicyEngine => ({
	authorize: () => ({ decision: "permit", policies: [tag] }),
});

describe("createOrgPolicyRouter", () => {
	it("shares one bundle across orgs with the same key (engineFor called once)", async () => {
		let builds = 0;
		const router = createOrgPolicyRouter({
			keyFor: () => "system",
			engineFor: () => {
				builds++;
				return taggedEngine("system");
			},
		});
		const a = await router.authorize(req("org-a"));
		const b = await router.authorize(req("org-b"));
		expect(builds).toBe(1);
		expect(a.policies).toEqual(["system"]);
		expect(b.policies).toEqual(["system"]);
	});

	it("rebuilds on the next decision after the key changes (content-keyed invalidation)", async () => {
		let version = "v1";
		let builds = 0;
		const router = createOrgPolicyRouter({
			keyFor: () => `org-a:${version}`,
			engineFor: () => {
				builds++;
				return taggedEngine(version);
			},
		});
		await router.authorize(req("org-a"));
		await router.authorize(req("org-a")); // same key — cached
		expect(builds).toBe(1);
		version = "v2"; // a registration bumped the content key
		const after = await router.authorize(req("org-a"));
		expect(builds).toBe(2);
		expect(after.policies).toEqual(["v2"]);
	});

	it("is single-flight: concurrent first decisions build exactly once", async () => {
		let builds = 0;
		const router = createOrgPolicyRouter({
			keyFor: async () => "k",
			engineFor: async () => {
				builds++;
				await Promise.resolve();
				return taggedEngine("k");
			},
		});
		await Promise.all([
			router.authorize(req("org-a")),
			router.authorize(req("org-a")),
			router.authorize(req("org-a")),
		]);
		expect(builds).toBe(1);
	});

	it("evicts a failed build so the next decision retries", async () => {
		let builds = 0;
		const router = createOrgPolicyRouter({
			keyFor: () => "k",
			engineFor: () => {
				builds++;
				if (builds === 1) throw new Error("build boom");
				return taggedEngine("recovered");
			},
		});
		await expect(router.authorize(req("org-a"))).rejects.toThrow("build boom");
		const retried = await router.authorize(req("org-a")); // rejected promise was evicted
		expect(builds).toBe(2);
		expect(retried.policies).toEqual(["recovered"]);
	});

	it("evicts the least-recently-used bundle and rebuilds it on return", async () => {
		let builds = 0;
		const seen: (string | undefined)[] = [];
		const router = createOrgPolicyRouter({
			maxBundles: 2,
			keyFor: (ref) => ref?.scopeId ?? "system",
			engineFor: (ref) => {
				builds++;
				seen.push(ref?.scopeId);
				return taggedEngine(ref?.scopeId ?? "system");
			},
		});
		await router.authorize(req("a")); // build a
		await router.authorize(req("b")); // build b
		await router.authorize(req("a")); // HIT — refreshes a's recency (b is now oldest)
		await router.authorize(req("c")); // build c → evicts b (LRU)
		expect(builds).toBe(3);
		await router.authorize(req("a")); // still cached — no rebuild
		expect(builds).toBe(3);
		await router.authorize(req("b")); // was evicted → rebuild
		expect(builds).toBe(4);
	});

	it("routes an absent config scope to the undefined (system) bundle", async () => {
		// A non-string config-scope key can't reach the router: the PARC request schema types it
		// (contracts authz/request.ts) and createPolicyPlugin validates every request at the gate.
		const seen: (unknown | undefined)[] = [];
		const router = createOrgPolicyRouter({
			keyFor: (ref) => ref?.scopeId ?? "system",
			engineFor: (ref) => {
				seen.push(ref);
				return taggedEngine("system");
			},
		});
		await router.authorize(req());
		// Neither half present ⇒ no config scope at all, not a half-formed ref.
		expect(seen).toEqual([undefined]);
	});

	it("passes the resolved engine's decision through verbatim", async () => {
		const decision: PolicyResult = {
			decision: "needs-approval",
			reason: "confirmation required",
			policies: ["p1"],
		};
		const router = createOrgPolicyRouter({
			keyFor: (ref) => ref?.scopeId ?? "system",
			engineFor: () => ({ authorize: () => decision }),
		});
		expect(await router.authorize(req("org-a"))).toEqual(decision);
	});

	// The router is a WRAPPER, and the gate hands per-decision entities positionally — the supplement
	// that makes a run-registered action nameable at all. Routing chooses which bundle answers; it must
	// not narrow what that bundle may name. Dropping the argument denied every registered tool with "no
	// policy permits this action", which reads as a policy decision and is really a lost parameter.
	// A wrapper of one parameter stays assignable to the port, so only a test can hold this.
	it("forwards per-decision entities to the resolved bundle", async () => {
		const seen: unknown[] = [];
		const router = createOrgPolicyRouter({
			keyFor: () => "system",
			engineFor: (): PolicyEngine => ({
				authorize: (_r, entities) => {
					seen.push(entities);
					return { decision: "permit" };
				},
			}),
		});
		await router.authorize(req("org-a"), [
			{ uid: { type: "Action", id: "x" } },
		]);
		expect(seen).toEqual([[{ uid: { type: "Action", id: "x" } }]]);
	});

	it("exposes the configured capabilities as its own", () => {
		const router = createOrgPolicyRouter({
			keyFor: () => "system",
			engineFor: () => taggedEngine("system"),
			capabilities: { reads: "identity+args", approvals: true },
		});
		expect(router.capabilities).toEqual({
			reads: "identity+args",
			approvals: true,
		});
	});
});
