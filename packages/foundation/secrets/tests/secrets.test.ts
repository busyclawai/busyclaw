import {
	BusyclawError,
	RESERVED_SCOPE_PREFIX,
	type ResolveContext,
	type ScopeRef,
	type SecretProvider,
	type SecretResolution,
	UNSCOPED,
	userPrincipal,
} from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { buildSecrets, env } from "../src/index";

/** Read the env global the way `env()` does — used only to prove the default-vars path. */
const envGlobal = (): Record<string, string | undefined> | undefined =>
	(globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env;

describe("env — the environment provider", () => {
	it("reads a value out of its vars as token material", async () => {
		const provider = env({ vars: { GITHUB_TOKEN: "ghp_abc" } });
		expect(
			await provider.get("GITHUB_TOKEN", { configScope: UNSCOPED }),
		).toEqual({
			kind: "token",
			value: "ghp_abc",
		});
	});

	it("returns null for a missing key (env var unset)", async () => {
		expect(
			await env({ vars: {} }).get("MISSING", { configScope: UNSCOPED }),
		).toBeNull();
	});

	it("returns null for an explicitly-undefined key", async () => {
		expect(
			await env({ vars: { EMPTY: undefined } }).get("EMPTY", {
				configScope: UNSCOPED,
			}),
		).toBeNull();
	});

	it('defaults its name to "env", and takes a custom name', () => {
		expect(env().name).toBe("env");
		expect(env({ name: "ci-env" }).name).toBe("ci-env");
	});

	it("is get-only — capability.manage is false", () => {
		expect(env().capability.manage).toBe(false);
	});

	it("defaults vars to the env global (globalThis.process.env)", async () => {
		const store = envGlobal();
		if (!store) return; // edge runtime without process.env resolves nothing — nothing to assert
		const key = "BUSYCLAW_SECRETS_ENV_PROBE";
		store[key] = "probe";
		try {
			expect(await env().get(key, { configScope: UNSCOPED })).toEqual({
				kind: "token",
				value: "probe",
			});
		} finally {
			delete store[key];
		}
	});
});

describe("buildSecrets — the one-door resolver", () => {
	it("defaults to a single env() provider — buildSecrets() reads env", async () => {
		const store = envGlobal();
		if (!store) return;
		const key = "BUSYCLAW_SECRETS_DEFAULT_PROBE";
		store[key] = "from-env";
		try {
			expect(await buildSecrets().get(key)).toEqual({
				kind: "token",
				value: "from-env",
			});
		} finally {
			delete store[key];
		}
	});

	it("resolves down the chain — the first non-null provider wins", async () => {
		const secrets = buildSecrets([
			env({ name: "a", vars: { SHARED: "from-a" } }),
			env({ name: "b", vars: { SHARED: "from-b", ONLY_B: "b-only" } }),
		]);
		expect(await secrets.get("SHARED")).toEqual({
			kind: "token",
			value: "from-a",
		});
		expect(await secrets.get("ONLY_B")).toEqual({
			kind: "token",
			value: "b-only",
		});
		expect(await secrets.get("NOWHERE")).toBeNull();
	});

	it("applies a provider's aliases (canonical → backend key); pass-through when unaliased", async () => {
		const secrets = buildSecrets([
			env({
				vars: { PROD_TELEGRAM: "prod-token", GITHUB_TOKEN: "gh" },
				aliases: { TELEGRAM_BOT_TOKEN: "PROD_TELEGRAM" },
			}),
		]);
		// aliased: the canonical name is remapped to the backend key
		expect(await secrets.get("TELEGRAM_BOT_TOKEN")).toEqual({
			kind: "token",
			value: "prod-token",
		});
		// unaliased: the name passes through unchanged
		expect(await secrets.get("GITHUB_TOKEN")).toEqual({
			kind: "token",
			value: "gh",
		});
		// an alias whose backend key is unset resolves to null (the caller fails loud)
		expect(await secrets.get("SLACK_TOKEN")).toBeNull();
	});

	it("remaps per provider — each provider's own aliases apply to its own get", async () => {
		const secrets = buildSecrets([
			env({ name: "a", vars: {}, aliases: { API_KEY: "A_KEY" } }), // A_KEY unset → miss
			env({
				name: "b",
				vars: { B_KEY: "from-b" },
				aliases: { API_KEY: "B_KEY" },
			}),
		]);
		// A remaps API_KEY→A_KEY (miss), then B remaps API_KEY→B_KEY (hit)
		expect(await secrets.get("API_KEY")).toEqual({
			kind: "token",
			value: "from-b",
		});
	});

	it("forwards the remapped key and ctx to the provider", async () => {
		const calls: Array<{ ref: string; ctx: ResolveContext }> = [];
		const spy: SecretProvider = {
			name: "spy",
			capability: { manage: false },
			aliases: { CANON: "backend-key" },
			// A tenant-scoped resolution below, so this config-tier provider only answers for names it
			// declares shared — the tenancy fence, not part of what this test is about.
			shared: ["CANON"],
			get: async (ref, ctx) => {
				calls.push({ ref, ctx });
				return null;
			},
		};
		await buildSecrets([spy]).get("CANON", {
			configScope: { scope: "organization", scopeId: "org_1" },
			principal: userPrincipal("user_1"),
		});
		expect(calls).toEqual([
			{
				ref: "backend-key",
				ctx: {
					configScope: { scope: "organization", scopeId: "org_1" },
					principal: userPrincipal("user_1"),
				},
			},
		]);
	});

	it("orders data-tier providers before config-tier, stable within each tier", async () => {
		const dataProvider = (
			name: string,
			vars: Record<string, string>,
		): SecretProvider => ({
			name,
			tier: "data",
			capability: { manage: true },
			get: async (ref) =>
				ref in vars ? { kind: "token", value: vars[ref] ?? "" } : null,
		});
		// data providers listed LAST — they must still resolve first; env (config, absent tier)
		// serves only what no data provider has.
		const secrets = buildSecrets([
			env({ vars: { SHARED: "from-env", ENV_ONLY: "env-only" } }),
			dataProvider("rows-a", { SHARED: "from-rows-a" }),
			dataProvider("rows-b", { SHARED: "from-rows-b" }),
		]);
		expect(await secrets.get("SHARED")).toEqual({
			kind: "token",
			value: "from-rows-a", // data beats config; listing order preserved within the data tier
		});
		expect(await secrets.get("ENV_ONLY")).toEqual({
			kind: "token",
			value: "env-only",
		});
	});

	it("fails loud on a duplicate provider name — a configurationError", () => {
		let caught: unknown;
		try {
			buildSecrets([env({ name: "dup" }), env({ name: "dup" })]);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(BusyclawError);
		expect(caught).toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(/distinct/),
		});
	});

	it("buildSecrets([]) — no providers — resolves everything to null", async () => {
		const secrets = buildSecrets([]);
		expect(await secrets.get("ANYTHING")).toBeNull();
		expect(await secrets.has("ANYTHING")).toBe(false);
	});

	it("has — true iff some provider resolves the name", async () => {
		const secrets = buildSecrets([env({ vars: { PRESENT: "v" } })]);
		expect(await secrets.has("PRESENT")).toBe(true);
		expect(await secrets.has("ABSENT")).toBe(false);
	});
});

describe("secrets.require — the fail-loud, kind-narrowing branch", () => {
	it("throws (configurationError naming the secret) when nothing resolves it", async () => {
		const secrets = buildSecrets([env({ vars: {} })]);
		await expect(secrets.require("MISSING")).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(/MISSING.*resolves nowhere/),
		});
	});

	it("returns the material when it resolves — get, but non-null", async () => {
		const secrets = buildSecrets([env({ vars: { PRESENT: "v" } })]);
		expect(await secrets.require("PRESENT")).toEqual({
			kind: "token",
			value: "v",
		});
	});

	it("throws on a kind mismatch — a wrong-kind result is never silently returned", async () => {
		const basic: SecretProvider = {
			name: "basic",
			capability: { manage: false },
			get: async () => ({ kind: "basic", username: "u", password: "p" }),
		};
		await expect(
			buildSecrets([basic]).require("CREDS", { kind: "token" }),
		).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(/basic material but token was required/),
		});
	});

	it("narrows to the requested kind — the token value is reachable with no second check", async () => {
		const secrets = buildSecrets([env({ vars: { TOK: "t" } })]);
		const material = await secrets.require("TOK", { kind: "token" });
		// `material` is `{ kind: "token"; value }` — `.value` needs no `.kind` guard.
		expect(material.value).toBe("t");
	});
});

describe("secrets.with — a pre-bound reader", () => {
	it("pre-binds ctx onto get so a per-principal provider resolves the bound principal (the store-row shape)", async () => {
		// A provider that returns a different value per principal — the personal-row shape.
		const perActor: SecretProvider = {
			name: "per-principal",
			tier: "data",
			capability: { manage: true },
			get: async (ref, resolution) =>
				resolution.principal === userPrincipal("alice")
					? { kind: "token", value: `alice:${ref}` }
					: null,
		};
		const secrets = buildSecrets([perActor]);
		// No bound principal ⇒ the provider has nothing for it.
		expect(await secrets.get("TOKEN")).toBeNull();
		// with({ principal }) threads the principal to every call — the invoker/endpoint per-turn shape.
		expect(
			await secrets.with({ principal: userPrincipal("alice") }).get("TOKEN"),
		).toEqual({
			kind: "token",
			value: "alice:TOKEN",
		});
	});

	it("merges a later explicit ctx over the bound one — last-wins per field", async () => {
		const calls: ResolveContext[] = [];
		const spy: SecretProvider = {
			name: "spy",
			capability: { manage: false },
			// Shared, so the tenant-scoped ctx below still reaches it — this test is about ctx merging.
			shared: ["X"],
			get: async (_ref, ctx) => {
				calls.push(ctx);
				return null;
			},
		};
		const bound = buildSecrets([spy]).with({
			configScope: { scope: "organization", scopeId: "org" },
			principal: userPrincipal("alice"),
		});
		await bound.get("X", { principal: userPrincipal("bob") });
		expect(calls).toEqual([
			{
				configScope: { scope: "organization", scopeId: "org" },
				principal: userPrincipal("bob"),
			},
		]);
	});

	it("pre-binds ctx onto require too", async () => {
		const calls: SecretResolution[] = [];
		const spy: SecretProvider = {
			name: "spy",
			capability: { manage: false },
			get: async (_ref, ctx) => {
				calls.push(ctx);
				return { kind: "token", value: "v" };
			},
		};
		await buildSecrets([spy])
			.with({ principal: userPrincipal("alice") })
			.require("X", { kind: "token" });
		// The bound principal, plus the boundary the reader always names — a binding is partial, what
		// the provider is asked never is.
		expect(calls).toEqual([
			{ principal: userPrincipal("alice"), configScope: UNSCOPED },
		]);
	});

	// M-12. A tenant-scoped miss used to fall through to deployment infrastructure, handing the tenant
	// the DEPLOYMENT's credential under a name the tenant chose — its quota, its billing, its data
	// scope. Nothing in the chain marked the difference between "the deployment's key" and "a key".
	describe("deployment credentials do not answer tenant-scoped resolutions", () => {
		const deployment = (options: { shared?: readonly string[] } = {}) =>
			env({ vars: { PETSTORE: "deployment-key" }, ...options });

		it("resolves for an UNSCOPED read — an app bot's token has no tenant to lend to", async () => {
			const secrets = buildSecrets([deployment()]);
			expect(await secrets.get("PETSTORE")).toEqual({
				kind: "token",
				value: "deployment-key",
			});
		});

		it("sits out a tenant-scoped read it never declared shared", async () => {
			const secrets = buildSecrets([deployment()]);
			expect(
				await secrets.get("PETSTORE", {
					configScope: { scope: "organization", scopeId: "org-a" },
				}),
			).toBeNull();
		});

		it("answers a tenant-scoped read for a name it DOES declare shared", async () => {
			const secrets = buildSecrets([deployment({ shared: ["PETSTORE"] })]);
			expect(
				await secrets.get("PETSTORE", {
					configScope: { scope: "organization", scopeId: "org-a" },
				}),
			).toEqual({ kind: "token", value: "deployment-key" });
		});

		it("still lets a tenant's OWN credential win, and does not lend one to the next tenant", async () => {
			const rows: SecretProvider = {
				name: "rows",
				tier: "data",
				capability: { manage: false },
				get: async (ref, resolution) =>
					resolution.configScope.scopeId === "org-a" && ref === "PETSTORE"
						? { kind: "token", value: "org-a-key" }
						: null,
			};
			const secrets = buildSecrets([rows, deployment()]);
			// org-a configured its own — data beats config, unchanged.
			expect(
				await secrets.get("PETSTORE", {
					configScope: { scope: "organization", scopeId: "org-a" },
				}),
			).toEqual({ kind: "token", value: "org-a-key" });
			// org-b configured nothing. It gets NOTHING, not the deployment's key.
			expect(
				await secrets.get("PETSTORE", {
					configScope: { scope: "organization", scopeId: "org-b" },
				}),
			).toBeNull();
		});

		it("treats the UNSCOPED sentinel as unscoped — it is present, but it is not a tenant", async () => {
			// Once the absent config scope became a VALUE, `scope === undefined` stopped being the way to
			// ask "does this name a tenant?" — every run now carries a pair. If this check keyed on
			// presence, the deployment's credential would stop resolving for the runs it exists for
			// (an app bot's token, a sandbox credential); if it keyed on the label being a tenant's, it
			// would lend that credential to whoever named the sentinel. `namesTenant` is the question.
			const secrets = buildSecrets([deployment()]);
			expect(await secrets.get("PETSTORE", { configScope: UNSCOPED })).toEqual({
				kind: "token",
				value: "deployment-key",
			});
		});

		it("a RESERVED label is never a tenant, whichever one it is", async () => {
			// The predicate is about the reserved PREFIX, not about one sentinel. A future core-minted
			// stand-in for "no boundary" must not become the one that quietly does name a tenant.
			const secrets = buildSecrets([deployment()]);
			expect(
				await secrets.get("PETSTORE", {
					configScope: {
						scope: `${RESERVED_SCOPE_PREFIX}something-later`,
						scopeId: "-",
					},
				}),
			).toEqual({ kind: "token", value: "deployment-key" });
		});

		it("a later boundary replaces a bound one WHOLE, never half of it", async () => {
			// What carrying the pair in ONE field buys. The merge is per-field: as two independent halves,
			// binding `{ scope, scopeId }` and then passing `{ scopeId }` left the bound LABEL beside the
			// new ID — a boundary neither caller named, which then read another tenant's credential. The
			// half-named case that test suite used to cover is now unrepresentable rather than handled.
			const seen: ScopeRef[] = [];
			const spy: SecretProvider = {
				name: "spy",
				tier: "data",
				capability: { manage: false },
				get: async (_ref, resolution) => {
					seen.push(resolution.configScope);
					return null;
				},
			};
			const bound = buildSecrets([spy]).with({
				configScope: { scope: "organization", scopeId: "org-a" },
			});
			await bound.get("X", {
				configScope: { scope: "team", scopeId: "team-1" },
			});
			expect(seen).toEqual([{ scope: "team", scopeId: "team-1" }]);
		});

		it("no ctx at all resolves as UNSCOPED — the reader names the boundary, not the caller", async () => {
			// The other half of totality: a provider is never handed an absent boundary to interpret.
			const seen: ScopeRef[] = [];
			const spy: SecretProvider = {
				name: "spy",
				tier: "data",
				capability: { manage: false },
				get: async (_ref, resolution) => {
					seen.push(resolution.configScope);
					return null;
				},
			};
			await buildSecrets([spy]).get("X");
			expect(seen).toEqual([UNSCOPED]);
		});
	});
});
