import type {
	EgressCapability,
	GovernedOutbound,
	PolicyEngine,
	Secrets,
	StampedFacts,
} from "@euroclaw/contracts";
import { buildSecrets } from "@euroclaw/secrets";
import { describe, expect, it } from "vitest";
import { planEgress } from "../src/index";

// Fakes for the stable signature. The slice-2 compiler does NOT call these (the interceptor outbound
// will, in slice 3) — a permit-all engine, an empty reader, and minimal stamped facts suffice.
const policy: PolicyEngine = { authorize: () => ({ decision: "permit" }) };
const secrets: Secrets = buildSecrets([]);
const facts: StampedFacts = { organizationId: "org_1", runMode: "autonomous" };

// A fake governed outbound — proves an interceptor plan carries through whatever `buildOutbound`
// returns WITHOUT the compiler inspecting it. Slice 3 replaces this with the real
// authorize+floor+claim-check+audit outbound.
function fakeOutbound(): GovernedOutbound {
	return { fetch: async () => ({ status: 200, headers: {} }) };
}

describe("planEgress — compiles a capability into the plan the backend can enforce", () => {
	it("blocked → { mode: blocked } with no unenforced notes", () => {
		const { plan, unenforced } = planEgress({
			capability: { posture: "blocked" },
			policy,
			facts,
			secrets,
		});
		expect(plan).toEqual({ mode: "blocked" });
		expect(unenforced).toEqual([]);
	});

	it("allowlist → the static host-set + the static unenforced notes", () => {
		const hosts = ["api.github.com", "*.example.com"];
		const { plan, unenforced } = planEgress({
			capability: { posture: "allowlist" },
			policy,
			facts,
			secrets,
			hosts,
		});
		expect(plan).toEqual({ mode: "allowlist", allow: hosts });

		// The honest gap: host-level enforcement can't do method/path/resource, per-request
		// conditions, or claim-check — all five non-host dimensions are reported as unenforced.
		const dimensions = unenforced.map((note) => note.dimension).sort();
		expect(dimensions).toEqual([
			"conditions",
			"credential-isolation",
			"method",
			"path",
			"resource",
		]);
		for (const note of unenforced)
			expect(note.detail.length).toBeGreaterThan(0);
	});

	it("allowlist with no hosts → an empty allow-set (decision 2: explicit list, none supplied yet)", () => {
		const { plan } = planEgress({
			capability: { posture: "allowlist" },
			policy,
			facts,
			secrets,
		});
		expect(plan).toEqual({ mode: "allowlist", allow: [] });
	});

	it("interceptor → the injected governed outbound, no unenforced notes", () => {
		const outbound = fakeOutbound();
		const { plan, unenforced } = planEgress({
			capability: { posture: "interceptor", transport: "fetch" },
			policy,
			facts,
			secrets,
			buildOutbound: () => outbound,
		});
		expect(plan.mode).toBe("interceptor");
		if (plan.mode === "interceptor") expect(plan.outbound).toBe(outbound);
		expect(unenforced).toEqual([]);
	});

	it("interceptor without buildOutbound → fails loud (never a silent mis-plan)", () => {
		expect(() =>
			planEgress({
				capability: { posture: "interceptor", transport: "fetch+connect" },
				policy,
				facts,
				secrets,
			}),
		).toThrow(/buildOutbound/);
	});

	// The pressure-test (brief §Acceptance): the three exemplars — PLUS the SAME backend (Firecracker)
	// at TWO tiers — must all express through EgressPlan/EgressCapability with NO special-casing. If a
	// row needed a field the union can't carry, the port would be wrong; every row plans cleanly.
	const cases: {
		backend: string;
		capability: EgressCapability;
		mode: "blocked" | "allowlist" | "interceptor";
		unenforced: number;
	}[] = [
		{
			backend: "QuickJS (in-proc)",
			capability: { posture: "interceptor", transport: "fetch" },
			mode: "interceptor",
			unenforced: 0,
		},
		{
			backend: "Cloudflare (platform gateway)",
			capability: { posture: "interceptor", transport: "fetch+connect" },
			mode: "interceptor",
			unenforced: 0,
		},
		{
			backend: "Firecracker microVM (host firewall)",
			capability: { posture: "allowlist" },
			mode: "allowlist",
			unenforced: 5,
		},
		{
			backend: "Firecracker + transparent MITM proxy",
			capability: { posture: "interceptor", transport: "fetch+connect" },
			mode: "interceptor",
			unenforced: 0,
		},
	];

	it.each(
		cases,
	)("$backend → plan.mode=$mode with $unenforced unenforced note(s)", ({
		capability,
		mode,
		unenforced,
	}) => {
		const { plan, unenforced: notes } = planEgress({
			capability,
			policy,
			facts,
			secrets,
			hosts: ["api.example.com"],
			buildOutbound: () => fakeOutbound(),
		});
		expect(plan.mode).toBe(mode);
		expect(notes).toHaveLength(unenforced);
	});

	it("one backend expresses either tier through the same union (Firecracker: firewall vs proxy)", () => {
		const asAllowlist = planEgress({
			capability: { posture: "allowlist" },
			policy,
			facts,
			secrets,
			hosts: ["api.example.com"],
		});
		const asInterceptor = planEgress({
			capability: { posture: "interceptor", transport: "fetch+connect" },
			policy,
			facts,
			secrets,
			buildOutbound: () => fakeOutbound(),
		});
		// Same backend, two postures per how it is provisioned — no special-casing in the compiler.
		expect(asAllowlist.plan.mode).toBe("allowlist");
		expect(asInterceptor.plan.mode).toBe("interceptor");
	});
});
