// Slice-5 proof at the PEP layer (`governApi` over stubs) for the branches the assembly can't reach
// without an engine or an org plugin: run owner-isolation (a `runs` stub), a `team:` grant that fires
// ONLY via a stubbed membership (dormant otherwise), and the LOAD-BEARING invariant that grants are
// DATA — inserting/deleting one flips the decision while the compiled api bundle stays byte-identical.

import type { AccessGrant, PrincipalScope } from "@euroclaw/authz";
import { API_ACCESS_BASELINE, loadPolicyBundle } from "@euroclaw/authz";
import type {
	AccessGrantStore,
	ClawRunReadModel,
	ClawsStore,
} from "@euroclaw/contracts";
import { asPrincipal } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	buildApiPolicyEngine,
	enumerateApiMethodIds,
	governApi,
} from "../src/authz-pep";

const ALICE = "user:alice";
const BOB = "user:bob";
const CAROL = "user:carol";
const STRANGER = "user:stranger";

type Governed = {
	[method: string]: (
		input: unknown,
		caller?: { principal?: string },
	) => Promise<unknown>;
};

// A stub api the PEP wraps — two governed reads (`getRun` = run kind, `getClaw` = claw kind). The engine
// is stateless (its bundle depends only on the method ids + baseline), so one instance serves every test.
const api = {
	getRun: async (input: unknown) => ({ ran: input }),
	getClaw: async (input: unknown) => ({ got: input }),
};
const engine = buildApiPolicyEngine({
	methodIds: enumerateApiMethodIds(api),
	createMethodIds: [],
	plugins: [],
});

function govern(opts: {
	clawsStore?: ClawsStore;
	runs?: ClawRunReadModel;
	grantStore?: AccessGrantStore;
	resolvePrincipalScopes?: (principal: string) => readonly PrincipalScope[];
}): Governed {
	return governApi({
		api,
		engine,
		clawsStore: opts.clawsStore,
		runs: opts.runs,
		grantStore: opts.grantStore,
		adapter: undefined,
		plugins: [],
		resolvePrincipalScopes: opts.resolvePrincipalScopes ?? (() => []),
		appAuthz: undefined,
		warn: () => {},
	}) as unknown as Governed;
}

describe("app-authz slice 5 — run owner-isolation via the run loader", () => {
	const runs: ClawRunReadModel = {
		get: async (id) =>
			id === "run-alice"
				? {
						id,
						status: "completed",
						input: {},
						principal: asPrincipal(ALICE),
						createdAt: "t",
						updatedAt: "t",
					}
				: null,
		events: async () => [],
	};

	it("getRun is permitted for the run's principal, denied for another, denied for a ghost", async () => {
		const governed = govern({ runs });
		await expect(
			governed.getRun({ id: "run-alice" }, { principal: ALICE }),
		).resolves.toEqual({ ran: { id: "run-alice" } });
		await expect(
			governed.getRun({ id: "run-alice" }, { principal: BOB }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
		// a not-found run fails closed (no owner to isolate)
		await expect(
			governed.getRun({ id: "ghost" }, { principal: ALICE }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz slice 5 — a team grant is dormant without scopes", () => {
	const clawsStore = {
		claws: {
			get: async (id: string) =>
				id === "claw-1"
					? {
							id,
							createdBy: ALICE,
							scope: "team",
							scopeId: "team-eng",
							status: "active",
							context: {},
							createdAt: "t",
							updatedAt: "t",
						}
					: null,
		},
		threads: { get: async () => null },
	} as unknown as ClawsStore;

	function grantStoreWith(rows: Map<string, AccessGrant[]>): AccessGrantStore {
		return {
			listForResource: async (kind, id) => rows.get(`${kind}:${id}`) ?? [],
			create: async () => {
				throw new Error("unused");
			},
			delete: async () => 0,
		};
	}

	it("a team:Y grant reaches ONLY a caller with a matching stubbed membership", async () => {
		const rows = new Map<string, AccessGrant[]>([
			["claw:claw-1", [{ principalRef: "team:team-eng", level: "read" }]],
		]);
		const governed = govern({
			clawsStore,
			grantStore: grantStoreWith(rows),
			resolvePrincipalScopes: (principal) =>
				principal === BOB
					? [{ scope: "team", scopeId: "team-eng", level: "read" }]
					: [],
		});
		// bob holds the matching membership → the team grant reaches him
		await expect(
			governed.getClaw({ id: "claw-1" }, { principal: BOB }),
		).resolves.toEqual({ got: { id: "claw-1" } });
		// carol has no membership → the SAME grant is dormant → deny
		await expect(
			governed.getClaw({ id: "claw-1" }, { principal: CAROL }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});

	it("grants are DATA: an insert/delete flips the decision while the api bundle is byte-identical", async () => {
		const rows = new Map<string, AccessGrant[]>();
		const governed = govern({ clawsStore, grantStore: grantStoreWith(rows) });
		const bundleBefore = loadPolicyBundle({
			system: API_ACCESS_BASELINE,
			slices: [],
		}).live;

		// no grant → a stranger is denied
		await expect(
			governed.getClaw({ id: "claw-1" }, { principal: STRANGER }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);

		// INSERT a public grant (pure data — the same fixed engine)
		rows.set("claw:claw-1", [{ principalRef: "public", level: "read" }]);
		await expect(
			governed.getClaw({ id: "claw-1" }, { principal: STRANGER }),
		).resolves.toEqual({ got: { id: "claw-1" } });
		// the decision flipped, yet the compiled bundle never moved
		expect(
			loadPolicyBundle({ system: API_ACCESS_BASELINE, slices: [] }).live,
		).toEqual(bundleBefore);

		// DELETE (unshare) → flips back; bundle STILL unchanged
		rows.delete("claw:claw-1");
		await expect(
			governed.getClaw({ id: "claw-1" }, { principal: STRANGER }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
		expect(
			loadPolicyBundle({ system: API_ACCESS_BASELINE, slices: [] }).live,
		).toEqual(bundleBefore);
	});
});
