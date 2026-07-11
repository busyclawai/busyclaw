// The secret-store plugin end-to-end at the unit seam: the (scope, scopeId, name) rows, the
// nearest-scope provider walk over the context's OWN boundaries, and the data-tier precedence in
// buildSecrets. Wiring mirrors production: the provider is read STATICALLY off the plugin object,
// the store arrives at configure (tests hand a schema-wrapped memory adapter, the channels pattern).

import type { Adapter } from "@euroclaw/contracts";
import { buildSecrets, env } from "@euroclaw/secrets";
import { memoryAdapter, schemaAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	createStoredSecretsStore,
	type SecretStoreOptions,
	secretStore,
	storedSecretSchema,
} from "../src/index";

/** A plugin configured against a fresh in-memory table, plus the store as the seeding surface
 *  (same adapter — the plugin's internal store and this one read/write the same rows). */
function connectedStore(options: SecretStoreOptions = {}) {
	const plugin = secretStore(options);
	const db = schemaAdapter(memoryAdapter(), storedSecretSchema);
	plugin.configure?.({ adapter: db });
	const [provider] = plugin.secretProviders;
	return { db, plugin, provider, store: createStoredSecretsStore(db) };
}

// A stub adapter whose reads throw — infrastructure failure and the enabled-but-not-migrated case.
// Only the methods the store touches need to throw.
function failingAdapter(message: string): Adapter {
	const boom = (): never => {
		throw new Error(message);
	};
	return {
		id: "failing",
		create: boom,
		findOne: boom,
		findMany: boom,
		count: boom,
		update: boom,
		updateMany: boom,
		delete: boom,
		deleteMany: boom,
		consumeOne: boom,
	};
}

describe("secretStore() — the plugin shape", () => {
	it("contributes the table and the data-tier store provider statically", () => {
		const plugin = secretStore();
		expect(plugin.id).toBe("euroclaw.secret-store");
		expect(plugin.$RequiresDatabase).toBe(true);
		expect(plugin.schema?.stored_secret).toBeDefined();
		const [provider] = plugin.secretProviders;
		expect(provider).toMatchObject({
			name: "store",
			tier: "data",
			capability: { manage: true },
		});
	});
});

describe("stored-secrets store — (scope, scopeId, name) rows", () => {
	it("defaults a new row to personal:createdBy — the one scope literal", async () => {
		const { store } = connectedStore();
		const record = await store.set({
			name: "MY_NOTION_TOKEN",
			value: "v1",
			createdBy: "alice",
		});
		expect(record).toMatchObject({
			scope: "personal",
			scopeId: "alice",
			kind: "value",
			value: "v1",
		});
	});

	it("upserts by the natural key — a re-set rotates the value in place", async () => {
		const { store } = connectedStore();
		const first = await store.set({
			name: "MY_NOTION_TOKEN",
			value: "v1",
			createdBy: "alice",
		});
		const second = await store.set({
			name: "MY_NOTION_TOKEN",
			value: "v2",
			createdBy: "alice",
		});
		expect(second.id).toBe(first.id);
		expect(second.value).toBe("v2");
	});

	it("rejects a set without a value — the store writes value-kind rows", async () => {
		const { store } = connectedStore();
		await expect(
			store.set({ name: "NO_MATERIAL", createdBy: "alice" }),
		).rejects.toThrow(/value is required/);
	});
});

describe("the store provider — nearest-scope resolution", () => {
	it("personal beats org-wide for the same name; others fall through to the org rung", async () => {
		const { provider, store } = connectedStore();
		await store.set({
			name: "MY_TOKEN",
			value: "org-wide",
			createdBy: "admin",
			scope: "organization",
			scopeId: "org-a",
		});
		await store.set({
			name: "MY_TOKEN",
			value: "alices-own",
			createdBy: "alice",
		});
		expect(
			await provider.get("MY_TOKEN", {
				actor: "alice",
				organizationId: "org-a",
			}),
		).toEqual({ kind: "token", value: "alices-own" });
		// bob saved nothing personally — the org-wide row serves him.
		expect(
			await provider.get("MY_TOKEN", { actor: "bob", organizationId: "org-a" }),
		).toEqual({ kind: "token", value: "org-wide" });
	});

	it("isolates scopes — another actor's personal row is unreachable", async () => {
		const { provider, store } = connectedStore();
		await store.set({ name: "PRIVATE", value: "alices", createdBy: "alice" });
		expect(await provider.get("PRIVATE", { actor: "mallory" })).toBeNull();
		// and a personal row never doubles as an org-wide one
		expect(
			await provider.get("PRIVATE", { organizationId: "org-a" }),
		).toBeNull();
	});

	it("an ORG-LESS context resolves personal rows — org is fully additive", async () => {
		const { provider, store } = connectedStore();
		await store.set({ name: "MY_TOKEN", value: "v", createdBy: "alice" });
		expect(await provider.get("MY_TOKEN", { actor: "alice" })).toEqual({
			kind: "token",
			value: "v",
		});
	});

	it("a miss returns null; infrastructure failure THROWS — never coerced into a miss", async () => {
		const { provider } = connectedStore();
		expect(
			await provider.get("NOWHERE", {
				actor: "alice",
				organizationId: "org-a",
			}),
		).toBeNull();

		const broken = secretStore();
		broken.configure?.({ adapter: failingAdapter("connection refused") });
		const [brokenProvider] = broken.secretProviders;
		await expect(brokenProvider.get("ANY", { actor: "alice" })).rejects.toThrow(
			/connection refused/,
		);
	});

	it("wraps a missing-table error into a clear configurationError (not-migrated)", async () => {
		const plugin = secretStore();
		plugin.configure?.({
			adapter: failingAdapter("SqliteError: no such table: stored_secret"),
		});
		const [provider] = plugin.secretProviders;
		await expect(provider.get("ANY", { actor: "alice" })).rejects.toMatchObject(
			{
				code: "EUROCLAW_CONFIGURATION_ERROR",
				message: expect.stringMatching(
					/stored_secret table isn't in your database/,
				),
			},
		);
	});

	it("fails loud when resolved before configure wires a database", async () => {
		const plugin = secretStore();
		const [provider] = plugin.secretProviders;
		await expect(provider.get("ANY", { actor: "alice" })).rejects.toMatchObject(
			{
				code: "EUROCLAW_CONFIGURATION_ERROR",
				message: expect.stringMatching(/secret store has no database/),
			},
		);
	});

	it("refuses a pointer-kind row loud — no write surface exists for one yet", async () => {
		const { db, provider } = connectedStore();
		// Seed the row past the store deliberately (the store cannot write pointers) — the tampered/
		// version-skew shape the defensive throw exists for.
		const ts = new Date().toISOString();
		await db.create({
			model: "stored_secret",
			data: {
				id: "ptr-1",
				createdBy: "alice",
				scope: "personal",
				scopeId: "alice",
				name: "PTR",
				kind: "pointer",
				provider: "vault",
				ref: "kv/telegram/prod",
				createdAt: ts,
				updatedAt: ts,
			},
		});
		await expect(provider.get("PTR", { actor: "alice" })).rejects.toMatchObject(
			{
				code: "EUROCLAW_CONFIGURATION_ERROR",
				message: expect.stringMatching(/pointers are not supported yet/),
			},
		);
	});
});

describe("data-tier precedence through buildSecrets", () => {
	it("a store row beats env for the SAME canonical name, even listed after env", async () => {
		const { provider, store } = connectedStore();
		await store.set({
			name: "SHARED_NAME",
			value: "from-store",
			createdBy: "alice",
		});
		// env FIRST in the listing — tier ordering must still consult the store first.
		const secrets = buildSecrets([
			env({ vars: { SHARED_NAME: "from-env" } }),
			provider,
		]);
		expect(await secrets.get("SHARED_NAME", { actor: "alice" })).toEqual({
			kind: "token",
			value: "from-store",
		});
		// a store miss falls through to the config tier — env still serves everyone else.
		expect(await secrets.get("SHARED_NAME", { actor: "bob" })).toEqual({
			kind: "token",
			value: "from-env",
		});
	});
});
