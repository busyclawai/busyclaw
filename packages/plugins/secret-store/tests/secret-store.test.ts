// The secret-store plugin end-to-end at the unit seam: the (scope, scopeId, name) rows, the
// nearest-scope provider walk over the context's OWN boundaries, the data-tier precedence in
// buildSecrets, and AES-GCM at rest (values sealed on write, opened only in the provider's read
// path). Wiring mirrors production: the provider is read STATICALLY off the plugin object, the
// store + reader arrive at configure (tests hand a schema-wrapped memory adapter, the channels
// pattern).

import type { Adapter } from "@euroclaw/contracts";
import { buildSecrets, env } from "@euroclaw/secrets";
import { memoryAdapter, schemaAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	createSecretCipher,
	createStoredSecretsStore,
	parseSecretStoreKey,
	SECRET_STORE_KEY_NAME,
	type SecretStoreOptions,
	secretStore,
	storedSecretSchema,
} from "../src/index";

// 32 bytes, hex — the shape parseSecretStoreKey demands.
const TEST_KEY = "0123456789abcdef".repeat(4);
const OTHER_KEY = "fedcba9876543210".repeat(4);

const cipherFor = (key: string) =>
	createSecretCipher(async () => parseSecretStoreKey(key));

/** A plugin configured against a fresh in-memory table (config key by default; tests override),
 *  plus a same-key store over the same adapter as the seeding surface. */
function connectedStore(options: SecretStoreOptions = {}) {
	const plugin = secretStore({ key: TEST_KEY, ...options });
	const db = schemaAdapter(memoryAdapter(), storedSecretSchema);
	plugin.configure?.({ adapter: db });
	const [provider] = plugin.secrets.providers;
	return {
		db,
		plugin,
		provider,
		store: createStoredSecretsStore(db, { cipher: cipherFor(TEST_KEY) }),
	};
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
		const [provider] = plugin.secrets.providers;
		expect(provider).toMatchObject({
			name: "store",
			tier: "data",
			capability: { manage: true },
		});
	});

	it("rejects a malformed config key loud at construction", () => {
		expect(() => secretStore({ key: "too-short" })).toThrow(/not valid hex/);
		expect(() => secretStore({ key: "abcd" })).toThrow(/wrong length/);
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
		});
	});

	it("upserts by the natural key — a re-set rotates the value in place", async () => {
		const { provider, store } = connectedStore();
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
		expect(await provider.get("MY_NOTION_TOKEN", { actor: "alice" })).toEqual({
			kind: "token",
			value: "v2",
		});
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

		const broken = secretStore({ key: TEST_KEY });
		broken.configure?.({ adapter: failingAdapter("connection refused") });
		const [brokenProvider] = broken.secrets.providers;
		await expect(brokenProvider.get("ANY", { actor: "alice" })).rejects.toThrow(
			/connection refused/,
		);
	});

	it("wraps a missing-table error into a clear configurationError (not-migrated)", async () => {
		const plugin = secretStore({ key: TEST_KEY });
		plugin.configure?.({
			adapter: failingAdapter("SqliteError: no such table: stored_secret"),
		});
		const [provider] = plugin.secrets.providers;
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
		const plugin = secretStore({ key: TEST_KEY });
		const [provider] = plugin.secrets.providers;
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

describe("encryption at rest", () => {
	it("roundtrips through the provider — set seals, get opens", async () => {
		const { provider, store } = connectedStore();
		await store.set({
			name: "ROUNDTRIP",
			value: "plain-secret",
			createdBy: "alice",
		});
		expect(await provider.get("ROUNDTRIP", { actor: "alice" })).toEqual({
			kind: "token",
			value: "plain-secret",
		});
	});

	it("never rests plaintext — the raw row holds hex(nonce ‖ ciphertext+tag)", async () => {
		const { db, store } = connectedStore();
		await store.set({
			name: "AT_REST",
			value: "plain-secret",
			createdBy: "alice",
		});
		const raw = await db.findOne<{ value?: string }>({
			model: "stored_secret",
			where: [
				{ field: "scope", value: "personal" },
				{ field: "scopeId", value: "alice", connector: "AND" },
				{ field: "name", value: "AT_REST", connector: "AND" },
			],
		});
		const sealed = raw?.value;
		if (sealed === undefined) throw new Error("expected a sealed value");
		expect(sealed).not.toBe("plain-secret");
		expect(sealed).not.toContain("plain-secret");
		// the documented encoding: hex, 12-byte nonce + ciphertext + 16-byte GCM tag ⇒ ≥ 56 hex chars
		expect(sealed).toMatch(/^[0-9a-f]+$/);
		expect(sealed.length).toBeGreaterThanOrEqual(56);
		// and it is EXACTLY the sealed form — the same-key cipher opens it back to the plaintext
		expect(await cipherFor(TEST_KEY).open(sealed)).toBe("plain-secret");
	});

	it("an unresolvable master key with rows present fails loud — never ciphertext, never null", async () => {
		// Rows exist (sealed under TEST_KEY by the seeding store)…
		const db = schemaAdapter(memoryAdapter(), storedSecretSchema);
		const seeder = createStoredSecretsStore(db, {
			cipher: cipherFor(TEST_KEY),
		});
		await seeder.set({ name: "LOCKED", value: "material", createdBy: "alice" });
		// …but the plugin has no config key and its reader resolves nothing.
		const plugin = secretStore();
		plugin.configure?.({ adapter: db, secrets: buildSecrets([]) });
		const [provider] = plugin.secrets.providers;
		await expect(
			provider.get("LOCKED", { actor: "alice" }),
		).rejects.toMatchObject({
			code: "EUROCLAW_CONFIGURATION_ERROR",
			// secrets.require names the key and fails loud when nothing resolves it.
			message: expect.stringMatching(
				/EUROCLAW_SECRET_STORE_KEY.*resolves nowhere/,
			),
		});
	});

	it("a wrong (rotated) master key fails loud on decrypt — never garbage material", async () => {
		const db = schemaAdapter(memoryAdapter(), storedSecretSchema);
		const seeder = createStoredSecretsStore(db, {
			cipher: cipherFor(TEST_KEY),
		});
		await seeder.set({
			name: "ROTATED",
			value: "material",
			createdBy: "alice",
		});
		const plugin = secretStore({ key: OTHER_KEY });
		plugin.configure?.({ adapter: db });
		const [provider] = plugin.secrets.providers;
		await expect(
			provider.get("ROTATED", { actor: "alice" }),
		).rejects.toMatchObject({
			code: "EUROCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(/cannot decrypt stored secret/),
		});
	});

	it("short-circuits its own master-key name — env serves it, the store row is never consulted", async () => {
		// The production shape: no config key, the key lives in env, and the reader includes the
		// store provider itself (data tier ⇒ consulted FIRST for every name — including the key's,
		// which without the short-circuit would recurse: get → decrypt → resolve key → get …).
		const plugin = secretStore();
		const db = schemaAdapter(memoryAdapter(), storedSecretSchema);
		const [provider] = plugin.secrets.providers;
		const reader = buildSecrets([
			env({ vars: { [SECRET_STORE_KEY_NAME]: TEST_KEY } }),
			provider,
		]);
		plugin.configure?.({ adapter: db, secrets: reader });
		// An adversarial row CLAIMING the key's name — resolution must never surface it.
		const seeder = createStoredSecretsStore(db, {
			cipher: cipherFor(TEST_KEY),
		});
		await seeder.set({
			name: SECRET_STORE_KEY_NAME,
			value: "not-the-key",
			createdBy: "alice",
		});
		await seeder.set({
			name: "USER_TOKEN",
			value: "sealed",
			createdBy: "alice",
		});

		// The key name resolves from ENV (the short-circuit made the data tier a miss)…
		expect(await reader.get(SECRET_STORE_KEY_NAME, { actor: "alice" })).toEqual(
			{ kind: "token", value: TEST_KEY },
		);
		// …and a normal name resolves THROUGH that same reader-resolved key: the full loop — store
		// row → decrypt → lazy key via env — with no recursion and no hang.
		expect(await reader.get("USER_TOKEN", { actor: "alice" })).toEqual({
			kind: "token",
			value: "sealed",
		});
	});
});
