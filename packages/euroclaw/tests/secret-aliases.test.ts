// The per-org dynamic secret aliases feature end-to-end through the assembly: the conditional table,
// the runtime DB backstop, DB-wins resolution via the one-door reader, the claw.api.secrets surface,
// and boot validation. The compile-time DB guard is proved in dynamic-secret-aliases.test-d.ts.

import type { EuroclawPlugin } from "@euroclaw/contracts";
import { buildSecrets, env } from "@euroclaw/secrets";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createSecretAliasStore } from "@euroclaw/storage-durable";
import { describe, expect, it } from "vitest";
import {
	collectSecretDeclarations,
	createClaw,
	getEuroclawTables,
	type SecretBootWarning,
	validateSecretsAtBoot,
} from "../src/index";
import { durableRedactor, textModel } from "./fixtures";

describe("getEuroclawTables — secret_alias is opt-in", () => {
	it("is absent by default and when explicitly disabled", () => {
		expect(getEuroclawTables({}).secret_alias).toBeUndefined();
		expect(
			getEuroclawTables({ dynamicSecretAliases: { enabled: false } })
				.secret_alias,
		).toBeUndefined();
	});

	it("is contributed only when enabled", () => {
		expect(
			getEuroclawTables({ dynamicSecretAliases: { enabled: true } })
				.secret_alias,
		).toBeDefined();
	});
});

describe("createClaw — dynamicSecretAliases runtime backstop", () => {
	it("throws when enabled without a database (JS / `as any` callers who dodge the type guard)", () => {
		// The type guard rejects this at compile time; the loose cast simulates a JS caller.
		const build = createClaw as (config: unknown) => unknown;
		expect(() =>
			build({
				model: textModel("ok"),
				dynamicSecretAliases: { enabled: true },
			}),
		).toThrow(/dynamicSecretAliases\.enabled requires a database/);
	});

	it("is fine enabled WITH a database, and fine disabled without one", () => {
		const { db, redactor } = durableRedactor();
		expect(() =>
			createClaw({
				model: textModel("ok"),
				database: db,
				redactor,
				dynamicSecretAliases: { enabled: true },
			}),
		).not.toThrow();
		expect(() => createClaw({ model: textModel("ok") })).not.toThrow();
	});
});

describe("createClaw — DB-wins resolution through the one-door reader", () => {
	it("resolves a name through its per-org DB alias, over env", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			model: textModel("ok"),
			database: db,
			redactor,
			dynamicSecretAliases: { enabled: true },
			secretProviders: [
				env({ source: { VAULT_BACKEND: "resolved-from-alias" } }),
			],
		});
		await claw.api.secrets.setAlias({
			organizationId: "org-a",
			name: "SOME_TOKEN",
			provider: "env",
			ref: "VAULT_BACKEND",
		});
		const reader = claw.$context.secrets;
		expect(reader).toBeDefined();
		// With the org, the DB alias routes SOME_TOKEN → env's VAULT_BACKEND.
		expect(
			await reader?.get("SOME_TOKEN", { organizationId: "org-a" }),
		).toEqual({
			kind: "token",
			value: "resolved-from-alias",
		});
		// A different org has no alias → resolves nowhere (env has no SOME_TOKEN key).
		expect(
			await reader?.get("SOME_TOKEN", { organizationId: "org-b" }),
		).toBeNull();
	});
});

describe("claw.api.secrets — the admin surface", () => {
	const enabledClaw = () => {
		const { db, redactor } = durableRedactor();
		return createClaw({
			model: textModel("ok"),
			database: db,
			redactor,
			dynamicSecretAliases: { enabled: true },
			secretProviders: [
				env({ source: { INLINE_ONE: "v", VAULT_BACKEND: "secret" } }),
			],
			plugins: [
				{
					id: "declarer",
					secrets: [
						{ name: "CONFIGURED_ONE", description: "will be aliased" },
						{ name: "INLINE_ONE", description: "in the env" },
						{ name: "MISSING_ONE", description: "resolves nowhere" },
					],
				} satisfies EuroclawPlugin,
			],
		});
	};

	it("fails loud when dynamicSecretAliases is disabled", async () => {
		const claw = createClaw({ model: textModel("ok") });
		await expect(
			claw.api.secrets.list({ organizationId: "org-a" }),
		).rejects.toMatchObject({ code: "EUROCLAW_CONFIGURATION_ERROR" });
		await expect(
			claw.api.secrets.setAlias({
				organizationId: "org-a",
				name: "X",
				provider: "env",
				ref: "R",
			}),
		).rejects.toMatchObject({ code: "EUROCLAW_CONFIGURATION_ERROR" });
	});

	it("list reports configured | inline | missing, with the alias pointer when configured", async () => {
		const claw = enabledClaw();
		await claw.api.secrets.setAlias({
			organizationId: "org-a",
			name: "CONFIGURED_ONE",
			provider: "env",
			ref: "VAULT_BACKEND",
		});
		const byName = new Map(
			(await claw.api.secrets.list({ organizationId: "org-a" })).map((e) => [
				e.name,
				e,
			]),
		);
		expect(byName.get("CONFIGURED_ONE")).toEqual({
			name: "CONFIGURED_ONE",
			description: "will be aliased",
			status: "configured",
			alias: { provider: "env", ref: "VAULT_BACKEND" },
		});
		expect(byName.get("INLINE_ONE")).toMatchObject({ status: "inline" });
		expect(byName.get("MISSING_ONE")).toMatchObject({ status: "missing" });
		expect(byName.get("MISSING_ONE")?.alias).toBeUndefined();
	});

	it("deleteAlias removes the pointer (the name reverts to inline/missing)", async () => {
		const claw = enabledClaw();
		await claw.api.secrets.setAlias({
			organizationId: "org-a",
			name: "CONFIGURED_ONE",
			provider: "env",
			ref: "VAULT_BACKEND",
		});
		await claw.api.secrets.deleteAlias({
			organizationId: "org-a",
			name: "CONFIGURED_ONE",
		});
		const entry = (
			await claw.api.secrets.list({ organizationId: "org-a" })
		).find((e) => e.name === "CONFIGURED_ONE");
		// env has no CONFIGURED_ONE key → after the alias is gone it resolves nowhere.
		expect(entry).toMatchObject({ status: "missing" });
	});

	it("is org-scoped — one org's alias is invisible to another", async () => {
		const claw = enabledClaw();
		await claw.api.secrets.setAlias({
			organizationId: "org-a",
			name: "CONFIGURED_ONE",
			provider: "env",
			ref: "VAULT_BACKEND",
		});
		const other = (
			await claw.api.secrets.list({ organizationId: "org-b" })
		).find((e) => e.name === "CONFIGURED_ONE");
		expect(other).toMatchObject({ status: "missing" });
	});
});

describe("collectSecretDeclarations", () => {
	it("dedupes by name across plugins — the first declaration keeps its description", () => {
		const declarations = collectSecretDeclarations([
			{ id: "a", secrets: [{ name: "X", description: "first" }] },
			{
				id: "b",
				secrets: [{ name: "X", description: "second" }, { name: "Y" }],
			},
			{ id: "c" },
		]);
		expect(declarations).toEqual([
			{ name: "X", description: "first" },
			{ name: "Y" },
		]);
	});
});

describe("validateSecretsAtBoot — warn-only coverage + inline/DB duplicate", () => {
	it("warns on an unresolvable declared name and on an inline/DB duplicate", async () => {
		const providers = [
			env({
				source: { DIRECT_HIT: "v", BACKEND: "b" },
				aliases: { INLINE_NAME: "BACKEND" },
			}),
		];
		const secrets = buildSecrets(providers);
		const aliasStore = createSecretAliasStore(memoryAdapter());
		// INLINE_NAME is aliased BOTH inline (above) AND in the DB for org-a → duplicate.
		await aliasStore.set("org-a", "INLINE_NAME", {
			provider: "env",
			ref: "BACKEND",
		});

		const warnings: SecretBootWarning[] = [];
		await validateSecretsAtBoot({
			declarations: [
				{ name: "DIRECT_HIT" }, // resolves directly → covered
				{ name: "INLINE_NAME" }, // resolves via inline alias → covered
				{ name: "UNRESOLVABLE" }, // resolves nowhere → coverage warning
			],
			providers,
			secrets,
			aliasStore,
			warn: (w) => warnings.push(w),
		});

		expect(
			warnings.filter((w) => w.kind === "coverage").map((w) => w.name),
		).toEqual(["UNRESOLVABLE"]);
		expect(warnings.filter((w) => w.kind === "duplicate")).toMatchObject([
			{ name: "INLINE_NAME", organizationId: "org-a" },
		]);
	});

	it("without an alias store, coverage still runs (declared names, no DB)", async () => {
		const providers = [env({ source: { PRESENT: "v" } })];
		const warnings: SecretBootWarning[] = [];
		await validateSecretsAtBoot({
			declarations: [{ name: "PRESENT" }, { name: "ABSENT" }],
			providers,
			secrets: buildSecrets(providers),
			warn: (w) => warnings.push(w),
		});
		expect(warnings.map((w) => w.name)).toEqual(["ABSENT"]);
	});
});
