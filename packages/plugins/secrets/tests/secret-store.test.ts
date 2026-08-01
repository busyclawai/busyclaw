// The secrets() store end-to-end at the unit seam: the (scope, scopeId, name) rows, the
// nearest-scope provider walk over the context's OWN boundaries, the data-tier precedence in
// buildSecrets, and AES-GCM at rest (values sealed on write, opened only in the provider's read
// path). Wiring mirrors production: the provider is read STATICALLY off the plugin object, the
// store + reader arrive at configure (tests hand a schema-wrapped memory adapter, the channels
// pattern). `secrets([], { store })` isolates the store provider (empty base ⇒ it is providers[0]).

import {
	type Adapter,
	endpointRoutesOf,
	type SecretResolution,
	UNSCOPED,
	userPrincipal,
} from "@busyclaw/contracts";
import { buildSecrets, env } from "@busyclaw/secrets";
import { entityAdapter, memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	createSecretCipher,
	createStoredSecretsStore,
	parseSecretStoreKey,
	SECRET_STORE_KEY_NAME,
	type SecretStoreOptions,
	secretKeyId,
	secretKeyring,
	secrets,
	storedSecretFields,
} from "../src/index";

// 32 bytes, hex — the shape parseSecretStoreKey demands.
const TEST_KEY = "0123456789abcdef".repeat(4);
const OTHER_KEY = "fedcba9876543210".repeat(4);

const storedSecretModels = {
	stored_secret: { fields: storedSecretFields },
};

const cipherFor = (...keys: string[]) =>
	createSecretCipher(async () => secretKeyring(keys.map(parseSecretStoreKey)));

/** A plugin configured against a fresh in-memory table (config key by default; tests override),
 *  plus a same-key store over the same adapter as the seeding surface. */
function connectedStore(options: SecretStoreOptions = {}) {
	const plugin = secrets([], { store: { key: TEST_KEY, ...options } });
	const db = entityAdapter(memoryAdapter(), storedSecretModels);
	// configure fills the store/reader slots AND returns the runtime half — the management api, which
	// closes over the same store the provider reads (so a set here resolves through provider.get).
	const runtime = plugin.configure?.({ adapter: db });
	const [provider] = plugin.secrets.providers;
	return {
		api: runtime?.api?.(undefined).secrets,
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

/**
 * A whole resolution — what a provider is contractually handed.
 *
 * These tests call the provider DIRECTLY, so they stand in for the door: `buildSecrets` collapses an
 * omitted boundary to UNSCOPED before any provider is consulted, which is why `SecretResolution.configScope`
 * is total and this provider does not carry an absent-case rule of its own.
 */
const asked = (r: Partial<SecretResolution> = {}): SecretResolution => ({
	configScope: UNSCOPED,
	...r,
});

describe("secrets([], { store: true }) — the plugin shape", () => {
	it("contributes the table and the data-tier store provider statically", () => {
		const plugin = secrets([], { store: true });
		expect(plugin.id).toBe("busyclaw.secrets");
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
		expect(() => secrets([], { store: { key: "too-short" } })).toThrow(
			/not valid hex/,
		);
		expect(() => secrets([], { store: { key: "abcd" } })).toThrow(
			/wrong length/,
		);
	});
});

describe("stored-secrets store — (scope, scopeId, name) rows", () => {
	it("defaults a new row to personal:createdBy — the one scope literal", async () => {
		const { store } = connectedStore();
		const record = await store.set({
			name: "MY_NOTION_TOKEN",
			value: "v1",
			createdBy: "user:alice",
		});
		expect(record).toMatchObject({
			scope: "personal",
			scopeId: "user:alice",
			kind: "value",
		});
	});

	it("upserts by the natural key — a re-set rotates the value in place", async () => {
		const { provider, store } = connectedStore();
		const first = await store.set({
			name: "MY_NOTION_TOKEN",
			value: "v1",
			createdBy: "user:alice",
		});
		const second = await store.set({
			name: "MY_NOTION_TOKEN",
			value: "v2",
			createdBy: "user:alice",
		});
		expect(second.id).toBe(first.id);
		expect(
			await provider.get("MY_NOTION_TOKEN", asked({ principal: "user:alice" })),
		).toEqual({
			kind: "token",
			value: "v2",
		});
	});

	it("rejects a set without a value — the store writes value-kind rows", async () => {
		const { store } = connectedStore();
		await expect(
			store.set({ name: "NO_MATERIAL", createdBy: "user:alice" }),
		).rejects.toThrow(/value is required/);
	});
});

describe("the store provider — nearest-scope resolution", () => {
	it("personal beats org-wide for the same name; others fall through to the org rung", async () => {
		const { provider, store } = connectedStore();
		await store.set({
			name: "MY_TOKEN",
			value: "org-wide",
			createdBy: "user:admin",
			scope: "organization",
			scopeId: "org-a",
		});
		await store.set({
			name: "MY_TOKEN",
			value: "alices-own",
			createdBy: "user:alice",
		});
		expect(
			await provider.get(
				"MY_TOKEN",
				asked({
					principal: "user:alice",
					configScope: { scope: "organization", scopeId: "org-a" },
				}),
			),
		).toEqual({ kind: "token", value: "alices-own" });
		// bob saved nothing personally — the org-wide row serves him.
		expect(
			await provider.get(
				"MY_TOKEN",
				asked({
					principal: "user:bob",
					configScope: { scope: "organization", scopeId: "org-a" },
				}),
			),
		).toEqual({ kind: "token", value: "org-wide" });
	});

	it("isolates scopes — another principal's personal row is unreachable", async () => {
		const { provider, store } = connectedStore();
		await store.set({
			name: "PRIVATE",
			value: "alices",
			createdBy: "user:alice",
		});
		expect(
			await provider.get("PRIVATE", asked({ principal: "user:mallory" })),
		).toBeNull();
		// and a personal row never doubles as an org-wide one
		expect(
			await provider.get(
				"PRIVATE",
				asked({
					configScope: { scope: "organization", scopeId: "org-a" },
				}),
			),
		).toBeNull();
	});

	it("an ORG-LESS context resolves personal rows — org is fully additive", async () => {
		const { provider, store } = connectedStore();
		await store.set({ name: "MY_TOKEN", value: "v", createdBy: "user:alice" });
		expect(
			await provider.get("MY_TOKEN", asked({ principal: "user:alice" })),
		).toEqual({
			kind: "token",
			value: "v",
		});
	});

	it("a miss returns null; infrastructure failure THROWS — never coerced into a miss", async () => {
		const { provider } = connectedStore();
		expect(
			await provider.get(
				"NOWHERE",
				asked({
					principal: "user:alice",
					configScope: { scope: "organization", scopeId: "org-a" },
				}),
			),
		).toBeNull();

		const broken = secrets([], { store: { key: TEST_KEY } });
		broken.configure?.({
			adapter: entityAdapter(
				failingAdapter("connection refused"),
				storedSecretModels,
			),
		});
		const [brokenProvider] = broken.secrets.providers;
		await expect(
			brokenProvider.get("ANY", asked({ principal: "user:alice" })),
		).rejects.toThrow(/connection refused/);
	});

	it("wraps a missing-table error into a clear configurationError (not-migrated)", async () => {
		const plugin = secrets([], { store: { key: TEST_KEY } });
		plugin.configure?.({
			adapter: entityAdapter(
				failingAdapter("SqliteError: no such table: stored_secret"),
				storedSecretModels,
			),
		});
		const [provider] = plugin.secrets.providers;
		await expect(
			provider.get("ANY", asked({ principal: "user:alice" })),
		).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(
				/stored_secret table isn't in your database/,
			),
		});
	});

	it("fails loud when resolved before configure wires a database", async () => {
		const plugin = secrets([], { store: { key: TEST_KEY } });
		const [provider] = plugin.secrets.providers;
		await expect(
			provider.get("ANY", asked({ principal: "user:alice" })),
		).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(/secret store has no database/),
		});
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
				createdBy: "user:alice",
				scope: "personal",
				scopeId: "user:alice",
				name: "PTR",
				kind: "pointer",
				provider: "vault",
				ref: "kv/telegram/prod",
				createdAt: ts,
				updatedAt: ts,
			},
		});
		await expect(
			provider.get("PTR", asked({ principal: "user:alice" })),
		).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(/pointers are not supported yet/),
		});
	});
});

describe("data-tier precedence through buildSecrets", () => {
	it("a store row beats env for the SAME canonical name, even listed after env", async () => {
		const { provider, store } = connectedStore();
		await store.set({
			name: "SHARED_NAME",
			value: "from-store",
			createdBy: "user:alice",
		});
		// env FIRST in the listing — tier ordering must still consult the store first.
		const secrets = buildSecrets([
			env({ vars: { SHARED_NAME: "from-env" } }),
			provider,
		]);
		expect(
			await secrets.get("SHARED_NAME", { principal: "user:alice" }),
		).toEqual({
			kind: "token",
			value: "from-store",
		});
		// a store miss falls through to the config tier — env still serves everyone else.
		expect(await secrets.get("SHARED_NAME", { principal: "user:bob" })).toEqual(
			{
				kind: "token",
				value: "from-env",
			},
		);
	});
});

describe("encryption at rest", () => {
	it("roundtrips through the provider — set seals, get opens", async () => {
		const { provider, store } = connectedStore();
		await store.set({
			name: "ROUNDTRIP",
			value: "plain-secret",
			createdBy: "user:alice",
		});
		expect(
			await provider.get("ROUNDTRIP", asked({ principal: "user:alice" })),
		).toEqual({
			kind: "token",
			value: "plain-secret",
		});
	});

	it("never rests plaintext — the raw row holds k1.<keyId>.hex(nonce ‖ ciphertext+tag)", async () => {
		const { db, store } = connectedStore();
		await store.set({
			name: "AT_REST",
			value: "plain-secret",
			createdBy: "user:alice",
		});
		const raw = (await db.findOne({
			model: "stored_secret",
			where: [
				{ field: "scope", value: "personal" },
				{ field: "scopeId", value: "user:alice", connector: "AND" },
				{ field: "name", value: "AT_REST", connector: "AND" },
			],
		})) as { value?: string } | null;
		const sealed = raw?.value;
		if (sealed === undefined) throw new Error("expected a sealed value");
		expect(sealed).not.toBe("plain-secret");
		expect(sealed).not.toContain("plain-secret");
		// The documented encoding: version, the id of the key that sealed it, then hex of a 12-byte
		// nonce + ciphertext + 16-byte GCM tag ⇒ ≥ 56 hex chars of payload.
		expect(sealed).toMatch(/^k1\.[0-9a-f]{16}\.[0-9a-f]+$/);
		expect(sealed.split(".")[2]?.length).toBeGreaterThanOrEqual(56);
		// and it is EXACTLY the sealed form — the same-key cipher, given the row's own binding, opens
		// it back to the plaintext
		expect(
			await cipherFor(TEST_KEY).open(sealed, {
				scope: "personal",
				scopeId: "user:alice",
				name: "AT_REST",
			}),
		).toBe("plain-secret");
	});

	// The binding, from the outside: a sealed value is not portable. Someone able to write the value
	// column but NOT holding the master key — SQL injection, a backup restored into the wrong boundary,
	// an app bug addressing the wrong row — cannot move one row's secret into another and have it
	// resolve. Without AAD every one of these decrypts happily: the key is right and the tag is valid.
	describe("a sealed value is bound to its row", () => {
		const sealFor = async (
			scope: string,
			scopeId: string,
			name: string,
			value: string,
		) => cipherFor(TEST_KEY).seal(value, { scope, scopeId, name });

		it("refuses to open under another scope's boundary", async () => {
			const sealed = await sealFor(
				"organization",
				"org-a",
				"STRIPE_KEY",
				"sk_live_a",
			);
			await expect(
				cipherFor(TEST_KEY).open(sealed, {
					scope: "organization",
					scopeId: "org-b",
					name: "STRIPE_KEY",
				}),
			).rejects.toThrow(/cannot decrypt stored secret/);
		});

		it("refuses to open under another secret's name", async () => {
			const sealed = await sealFor(
				"personal",
				"user:alice",
				"STRIPE_KEY",
				"sk_live_a",
			);
			await expect(
				cipherFor(TEST_KEY).open(sealed, {
					scope: "personal",
					scopeId: "user:alice",
					name: "WEBHOOK_URL",
				}),
			).rejects.toThrow(/cannot decrypt stored secret/);
		});

		it("refuses to open under another scope kind", async () => {
			const sealed = await sealFor("personal", "org-a", "TOKEN", "t");
			await expect(
				cipherFor(TEST_KEY).open(sealed, {
					scope: "organization",
					scopeId: "org-a",
					name: "TOKEN",
				}),
			).rejects.toThrow(/cannot decrypt stored secret/);
		});

		// The parts are encoded as an array, not concatenated: ("a","bc") and ("ab","c") must not
		// collide into the same AAD, or a relocation between two such rows would silently verify.
		it("does not confuse boundaries that would concatenate alike", async () => {
			const sealed = await sealFor("personal", "a", "bc", "v");
			await expect(
				cipherFor(TEST_KEY).open(sealed, {
					scope: "personal",
					scopeId: "ab",
					name: "c",
				}),
			).rejects.toThrow(/cannot decrypt stored secret/);
		});

		// End to end through the real surfaces: a blob physically relocated in the database does not
		// resolve as the victim row's secret.
		it("a value relocated between rows in the database does not resolve", async () => {
			const { db, provider, store } = connectedStore();
			await store.set({
				name: "SHARED_NAME",
				value: "alice-secret",
				createdBy: "user:alice",
			});
			await store.set({
				name: "SHARED_NAME",
				value: "bob-secret",
				createdBy: "user:bob",
			});

			const aliceRow = (await db.findOne({
				model: "stored_secret",
				where: [
					{ field: "scope", value: "personal" },
					{ field: "scopeId", value: "user:alice", connector: "AND" },
					{ field: "name", value: "SHARED_NAME", connector: "AND" },
				],
			})) as { value?: string } | null;
			if (!aliceRow?.value) throw new Error("expected alice's sealed value");

			// The out-of-band write the app APIs never expose: alice's ciphertext into bob's row.
			await db.update({
				model: "stored_secret",
				where: [
					{ field: "scope", value: "personal" },
					{ field: "scopeId", value: "user:bob", connector: "AND" },
					{ field: "name", value: "SHARED_NAME", connector: "AND" },
				],
				update: { value: aliceRow.value },
			});

			// Bob's read fails loud instead of returning alice's secret.
			await expect(
				provider.get("SHARED_NAME", asked({ principal: "user:bob" })),
			).rejects.toThrow(/cannot decrypt stored secret/);
		});
	});

	it("an unresolvable master key with rows present fails loud — never ciphertext, never null", async () => {
		// Rows exist (sealed under TEST_KEY by the seeding store)…
		const db = entityAdapter(memoryAdapter(), storedSecretModels);
		const seeder = createStoredSecretsStore(db, {
			cipher: cipherFor(TEST_KEY),
		});
		await seeder.set({
			name: "LOCKED",
			value: "material",
			createdBy: "user:alice",
		});
		// …but the plugin has no config key and its reader resolves nothing.
		const plugin = secrets([], { store: true });
		plugin.configure?.({ adapter: db, secrets: buildSecrets([]) });
		const [provider] = plugin.secrets.providers;
		await expect(
			provider.get("LOCKED", asked({ principal: "user:alice" })),
		).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			// secrets.require names the key and fails loud when nothing resolves it.
			message: expect.stringMatching(
				/BUSYCLAW_SECRET_STORE_KEY.*resolves nowhere/,
			),
		});
	});

	it("a wrong (rotated) master key fails loud on decrypt — never garbage material", async () => {
		const db = entityAdapter(memoryAdapter(), storedSecretModels);
		const seeder = createStoredSecretsStore(db, {
			cipher: cipherFor(TEST_KEY),
		});
		await seeder.set({
			name: "ROTATED",
			value: "material",
			createdBy: "user:alice",
		});
		const plugin = secrets([], { store: { key: OTHER_KEY } });
		plugin.configure?.({ adapter: db });
		const [provider] = plugin.secrets.providers;
		// M-13 made this failure NAMEABLE. It used to be "cannot decrypt" — one message covering a
		// rotated key, a tampered row, and a relocated value alike, because the envelope carried
		// nothing to tell them apart. The key id says which key is missing, so an operator who dropped
		// one still in use has a fixable mistake rather than a row that has silently become garbage.
		await expect(
			provider.get("ROTATED", asked({ principal: "user:alice" })),
		).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			message: expect.stringMatching(/no longer holds/),
		});
	});

	// ── rotation, which was previously not a procedure ───────────────────────────────────────────
	//
	// One key forever: swapping it made every row fail to open, indistinguishably from tampering. So
	// a leaked key could not be retired without an outage and re-entering every secret by hand.

	it("opens rows sealed under a retired key when it stays in the keyring", async () => {
		const db = entityAdapter(memoryAdapter(), storedSecretModels);
		const before = createStoredSecretsStore(db, {
			cipher: cipherFor(TEST_KEY),
		});
		await before.set({
			name: "CARRIED",
			value: "still-readable",
			createdBy: "user:alice",
		});

		// Rotation: the NEW key first (it seals), the old one behind it (it still opens).
		const after = createStoredSecretsStore(db, {
			cipher: cipherFor(OTHER_KEY, TEST_KEY),
		});
		const row = await after.get("personal", "user:alice", "CARRIED");
		if (!row) throw new Error("expected the row");
		expect(
			await cipherFor(OTHER_KEY, TEST_KEY).open(row.value, {
				scope: "personal",
				scopeId: "user:alice",
				name: "CARRIED",
			}),
		).toBe("still-readable");
	});

	it("seals NEW writes under the active key, so re-setting a row retires it", async () => {
		const db = entityAdapter(memoryAdapter(), storedSecretModels);
		const before = createStoredSecretsStore(db, {
			cipher: cipherFor(TEST_KEY),
		});
		await before.set({
			name: "MOVED",
			value: "v1",
			createdBy: "user:alice",
		});
		const sealedBefore = (await before.get("personal", "user:alice", "MOVED"))
			?.value;

		const after = createStoredSecretsStore(db, {
			cipher: cipherFor(OTHER_KEY, TEST_KEY),
		});
		await after.set({ name: "MOVED", value: "v2", createdBy: "user:alice" });
		const sealedAfter = (await after.get("personal", "user:alice", "MOVED"))
			?.value;

		const oldId = secretKeyId(parseSecretStoreKey(TEST_KEY));
		const newId = secretKeyId(parseSecretStoreKey(OTHER_KEY));
		expect(sealedBefore?.split(".")[1]).toBe(oldId);
		// The row moved onto the new key by being re-set — which is what makes "is anything still on
		// the old key?" a question the data answers.
		expect(sealedAfter?.split(".")[1]).toBe(newId);
	});

	it("short-circuits its own master-key name — env serves it, the store row is never consulted", async () => {
		// The production shape: no config key, the key lives in env, and the reader includes the
		// store provider itself (data tier ⇒ consulted FIRST for every name — including the key's,
		// which without the short-circuit would recurse: get → decrypt → resolve key → get …).
		const plugin = secrets([], { store: true });
		const db = entityAdapter(memoryAdapter(), storedSecretModels);
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
			createdBy: "user:alice",
		});
		await seeder.set({
			name: "USER_TOKEN",
			value: "sealed",
			createdBy: "user:alice",
		});

		// The key name resolves from ENV (the short-circuit made the data tier a miss)…
		expect(
			await reader.get(SECRET_STORE_KEY_NAME, { principal: "user:alice" }),
		).toEqual({ kind: "token", value: TEST_KEY });
		// …and a normal name resolves THROUGH that same reader-resolved key: the full loop — store
		// row → decrypt → lazy key via env — with no recursion and no hang.
		expect(await reader.get("USER_TOKEN", { principal: "user:alice" })).toEqual(
			{
				kind: "token",
				value: "sealed",
			},
		);
	});
});

// The personal management api (claw.api.secrets.*) — end-user self-service, PERSONAL-ONLY. Every
// method keys to `(personal, input.principal)`, values are WRITE-ONLY (set/list return metadata views,
// there is no get-plaintext), and the material only ever exits via the provider (secrets.get). The
// api rides configure's runtime half; connectedStore exposes it (`api`).
describe("the personal management api — claw.api.secrets.*", () => {
	// Metadata a view carries — never `value`, never the `provider`/`ref` pointer fields.
	const VIEW_KEYS = ["createdAt", "createdBy", "kind", "name", "updatedAt"];

	it("set writes a personal row, list shows the name (no value), and the provider resolves the material", async () => {
		const { api, provider } = connectedStore();
		if (!api) throw new Error("expected the store path to expose an api");
		const view = await api.set(
			{ name: "MY_NOTION_TOKEN", value: "secret-v1" },
			{ principal: userPrincipal("alice") },
		);
		// The caller (arg 2) is the already-tagged principal — createdBy is that `user:alice`, verbatim.
		expect(view).toMatchObject({
			name: "MY_NOTION_TOKEN",
			kind: "value",
			createdBy: userPrincipal("alice"),
		});
		expect(view).not.toHaveProperty("value");
		// The name shows in alice's inventory, still with no value…
		const listed = await api.list({}, { principal: userPrincipal("alice") });
		expect(listed.map((v) => v.name)).toEqual(["MY_NOTION_TOKEN"]);
		expect(listed[0]).not.toHaveProperty("value");
		// …and the write-side meets the read-side: the row was written under `user:alice`, so the
		// provider resolves it for the SAME tagged ctx principal sessionIdentity stamps (the round-trip).
		expect(
			await provider.get(
				"MY_NOTION_TOKEN",
				asked({
					principal: userPrincipal("alice"),
				}),
			),
		).toEqual({
			kind: "token",
			value: "secret-v1",
		});
	});

	it("principal isolation — a caller only ever touches their OWN personal rows (the security invariant)", async () => {
		const { api, provider } = connectedStore();
		if (!api) throw new Error("expected the store path to expose an api");
		await api.set(
			{ name: "X", value: "alices" },
			{ principal: userPrincipal("alice") },
		);
		// bob's list does not include alice's X…
		expect(await api.list({}, { principal: userPrincipal("bob") })).toEqual([]);
		// …bob's delete of X is a no-op (alice's row survives — a caller cannot reach across principals)…
		await api.delete({ name: "X" }, { principal: userPrincipal("bob") });
		expect(
			(await api.list({}, { principal: userPrincipal("alice") })).map(
				(v) => v.name,
			),
		).toEqual(["X"]);
		// …and the isolation holds on the tagged boundary: alice's row lives at `user:alice`, so
		// `user:bob` cannot read it through the provider and `user:alice` can (disjoint principals).
		expect(
			await provider.get("X", asked({ principal: userPrincipal("bob") })),
		).toBeNull();
		expect(
			await provider.get("X", asked({ principal: userPrincipal("alice") })),
		).toEqual({
			kind: "token",
			value: "alices",
		});
	});

	it("values are write-only — neither set's return nor list's entries carry value/provider/ref", async () => {
		const { api } = connectedStore();
		if (!api) throw new Error("expected the store path to expose an api");
		const view = await api.set(
			{ name: "WO", value: "hidden" },
			{ principal: userPrincipal("alice") },
		);
		for (const key of ["value", "provider", "ref"]) {
			expect(view).not.toHaveProperty(key);
		}
		expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
		const [listed] = await api.list({}, { principal: userPrincipal("alice") });
		for (const key of ["value", "provider", "ref"]) {
			expect(listed).not.toHaveProperty(key);
		}
		expect(Object.keys(listed).sort()).toEqual(VIEW_KEYS);
	});

	it("upsert — re-setting a name rotates the value in place (one row, latest wins)", async () => {
		const { api, provider } = connectedStore();
		if (!api) throw new Error("expected the store path to expose an api");
		await api.set(
			{ name: "ROT", value: "v1" },
			{ principal: userPrincipal("alice") },
		);
		await api.set(
			{ name: "ROT", value: "v2" },
			{ principal: userPrincipal("alice") },
		);
		// one row, not two…
		expect(
			await api.list({}, { principal: userPrincipal("alice") }),
		).toHaveLength(1);
		// …and the resolved value is the latest (read on the tagged boundary the api wrote under).
		expect(
			await provider.get("ROT", asked({ principal: userPrincipal("alice") })),
		).toEqual({
			kind: "token",
			value: "v2",
		});
	});

	it("delete — set then delete leaves an empty list and the provider resolves null", async () => {
		const { api, provider } = connectedStore();
		if (!api) throw new Error("expected the store path to expose an api");
		await api.set(
			{ name: "GONE", value: "v" },
			{ principal: userPrincipal("alice") },
		);
		await api.delete({ name: "GONE" }, { principal: userPrincipal("alice") });
		expect(await api.list({}, { principal: userPrincipal("alice") })).toEqual(
			[],
		);
		expect(
			await provider.get("GONE", asked({ principal: userPrincipal("alice") })),
		).toBeNull();
	});

	it("a call with no identity writes nothing — the owner is never inferable from the body", async () => {
		const { api, store } = connectedStore();
		if (!api) throw new Error("expected the store path to expose an api");
		// A personal secret must have an owner, and the owner comes from the app-authz identity passed
		// beside the input — NEVER the input body (docs/plans/stamped-fields.md, #3). The input cannot
		// carry a `principal` at all, so with no identity there is nothing to key a row to and the call
		// must fail rather than invent an anonymous owner that later callers would collide on.
		//
		// WHERE THE CHECK LIVES: the principal floor is the PEP's, not this handler's. `route.…​.handler()`
		// hands every handler an AuthzContext whose `principal` is already guaranteed present and
		// non-blank, which is why the handler reads it directly instead of re-deriving it — a local
		// re-derivation would be the only path that could disagree with the floor. The governed property
		// (`secrets.set` over HTTP with no resolved caller → 403, with one → 200) is pinned in busyclaw's
		// plugin-endpoint governance tests, where a real assembled claw exists to enforce it.
		//
		// What this test pins is the LOCAL half: reaching the raw handler without an identity throws and,
		// crucially, leaves no row behind.
		await expect(api.set({ name: "X", value: "v" })).rejects.toThrow();
		await expect(api.list({})).rejects.toThrow();
		await expect(api.delete({ name: "X" })).rejects.toThrow();
		expect(await store.list("personal", "")).toEqual([]);
		expect(await store.list("personal", "undefined")).toEqual([]);
	});

	it("is a DECLARED endpoints() namespace — route metadata rides the same callable api", () => {
		const { api } = connectedStore();
		if (!api) throw new Error("expected the store path to expose an api");
		// The declared routes an HTTP adapter mounts under /secrets — set/delete write (POST), list
		// reads (GET by the name rule). The namespace's enumerable shape stays the three methods.
		expect(
			endpointRoutesOf(api)?.map((route) => [route.path, route.method]),
		).toEqual([
			["/set", "POST"],
			["/delete", "POST"],
			["/list", "GET"],
		]);
		expect(Object.keys(api).sort()).toEqual(["delete", "list", "set"]);
	});
});

// M-13: the name is a resolution KEY, and the value is stored in the honeypot.
//
// The schema said "a string" and stopped. Both are written through an authenticated api anyone with
// an account can reach, so "however much the caller cared to send" was the only bound on either —
// and a name that differs only by surrounding space is a lookup resolving to a row nobody meant.

describe("stored-secrets store — input bounds", () => {
	const store = () =>
		createStoredSecretsStore(
			entityAdapter(memoryAdapter(), storedSecretModels),
			{ cipher: cipherFor(TEST_KEY) },
		);

	it("refuses a name with surrounding whitespace rather than trimming it", async () => {
		// Trimming silently would make `" AWS_KEY"` and `"AWS_KEY"` the same row, which hides that one
		// caller is deriving names from something untrusted.
		await expect(
			store().set({ name: " AWS_KEY", value: "v", createdBy: "user:alice" }),
		).rejects.toThrow(/whitespace/);
	});

	it.each([
		"has space",
		"curly{brace}",
		"slash/es",
		"",
		"üñî",
	])("refuses a non-canonical name (%j)", async (name) => {
		await expect(
			store().set({ name, value: "v", createdBy: "user:alice" }),
		).rejects.toThrow(/stored secret name/);
	});

	it("accepts the ordinary shapes a real secret name takes", async () => {
		for (const name of ["AWS_KEY", "stripe.live", "gh-token", "v2_KEY.9"]) {
			await expect(
				store().set({ name, value: "v", createdBy: "user:alice" }),
			).resolves.toBeDefined();
		}
	});

	it("refuses an oversized name and an oversized value", async () => {
		await expect(
			store().set({
				name: "A".repeat(200),
				value: "v",
				createdBy: "user:alice",
			}),
		).rejects.toThrow(/out of range/);

		await expect(
			store().set({
				name: "BIG",
				value: "x".repeat(100_000),
				createdBy: "user:alice",
			}),
		).rejects.toThrow(/too large/);
	});

	it("reports the SIZE of an oversized value, never the value", async () => {
		// This message reaches logs and the caller. Echoing a rejected secret back would make the
		// bound itself the disclosure.
		await expect(
			store().set({
				name: "BIG",
				value: `sk-live-${"x".repeat(100_000)}`,
				createdBy: "user:alice",
			}),
		).rejects.not.toThrow(/sk-live/);
	});
});

// M-13: one resolution key, one row — even when two sets race.
//
// `set` used to read, then create or update depending on what it found, with a random id. Two
// concurrent sets of the same name both missed and both created. The read path uses `findOne`, so
// which value a lookup served afterwards was arbitrary — a caller who rotated a secret could go on
// being served the old one, which is the exact failure rotation exists to prevent.

describe("stored-secrets store — one resolution key, one row", () => {
	it("upserts in place: a re-set rotates the value and keeps the row's identity", async () => {
		// The row's identity is its boundary and its creator; a re-set moves `value` and nothing else,
		// which is also what keeps the seal's binding true for the row's whole life.
		const db = entityAdapter(memoryAdapter(), storedSecretModels);
		let clock = 0;
		const store = createStoredSecretsStore(db, {
			cipher: cipherFor(TEST_KEY),
			now: () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString(),
		});

		const first = await store.set({
			name: "KEPT",
			value: "v1",
			createdBy: "user:alice",
		});
		const second = await store.set({
			name: "KEPT",
			value: "v2",
			createdBy: "user:alice",
		});

		expect(second.id).toBe(first.id);
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.updatedAt).not.toBe(first.updatedAt);
		expect(second.value).not.toBe(first.value);
		expect(await store.list("personal", "user:alice")).toHaveLength(1);
	});

	it("derives the row id from the natural key, so a rival row is a CONFLICT not a race", async () => {
		// This is what closes the check-then-create window: `set` no longer reads-then-decides, it
		// inserts under an id that IS `(scope, scopeId, name)` and treats the conflict as "rotate".
		// Two boundaries never collide; one boundary can only ever have one row per name.
		const db = entityAdapter(memoryAdapter(), storedSecretModels);
		const store = createStoredSecretsStore(db, { cipher: cipherFor(TEST_KEY) });

		const alice = await store.set({
			name: "SHARED_NAME",
			value: "a",
			createdBy: "user:alice",
		});
		const bob = await store.set({
			name: "SHARED_NAME",
			value: "b",
			createdBy: "user:bob",
		});
		const again = await store.set({
			name: "SHARED_NAME",
			value: "a2",
			createdBy: "user:alice",
		});

		expect(alice.id).not.toBe(bob.id); // different boundary, different row
		expect(again.id).toBe(alice.id); // same boundary + name, same row
	});

	// WHAT THIS SUITE CANNOT SHOW, written down rather than left implied.
	//
	// A genuinely CONCURRENT set is arbitrated by the database's uniqueness constraint on `id`, and
	// the memory adapter has no engine to do that — its `enforcesUnique: false` pre-check is itself a
	// read-then-write, so eight interleaved creates all pass the check before any of them lands and
	// eight rows appear. That is a property of the test double, not of this store: the design here is
	// precisely to stop deciding in application code and let the insert be the claim. Proving it needs
	// a real engine, which the drizzle/MySQL atomicity suite covers for the same pattern.
});
