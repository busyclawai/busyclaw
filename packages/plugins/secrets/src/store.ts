import {
	type Adapter,
	configurationError,
	type EntityRecord,
	type EntitySchemaInput,
	errorMessage,
	stateError,
	validationError,
} from "@euroclaw/contracts";
import { type EntityWhere, entityView } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import type { SecretCipher } from "./crypto";
import {
	setStoredSecretInput,
	type setStoredSecretInputOptions,
	storedSecretFields,
} from "./schema";

// Types projected from the one entity (the schema module is this store's contract): the record and
// the input shape derive from the field map + the schema options, so there is one source of truth.
export type StoredSecretRecord = EntityRecord<typeof storedSecretFields>;
export type SetStoredSecretInput = EntitySchemaInput<
	typeof storedSecretFields,
	typeof setStoredSecretInputOptions
>;

export type StoredSecretsStore = {
	/**
	 * Upsert a value-kind row by its `(scope, scopeId, name)` natural key — re-setting a name inside
	 * the same boundary rotates the value in place. Boundary defaults: `scope ?? "personal"`,
	 * `scopeId ?? createdBy` — a secret is personal to its creator until saved wider (the one scope
	 * literal in this store; mirrors claws/skills create). The value is SEALED before it touches the
	 * adapter — the returned record (like the row) carries the encoded form, never plaintext.
	 */
	set: (input: SetStoredSecretInput) => Promise<StoredSecretRecord>;
	/** Exact single-boundary lookup — the provider's scope walk issues one of these per rung. The
	 *  row's `value` is the SEALED form; only the provider's read path opens it. */
	get: (
		scope: string,
		scopeId: string,
		name: string,
	) => Promise<StoredSecretRecord | null>;
};

export type StoredSecretsStoreOptions = {
	/** Seals values on the write path — REQUIRED so plaintext structurally cannot reach the adapter
	 *  (the plugin builds one over its master key; tests build one over a fixed key). */
	cipher: SecretCipher;
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

const MODEL = "stored_secret";
const newId = (): string => bytesToHex(randomBytes(16));

// ── Enabled-but-not-migrated safety net (the channels-registrations precedent) ───────────────────
// Connecting the plugin adds `stored_secret` to the generated schema (host runs generate→migrate).
// If the table isn't there, a DB call throws a native "no such table"/"does not exist" error —
// every op wraps that into a clear configurationError. Fail LOUD: the resolver contract says an
// infrastructure failure must never be coerced into a miss (a fall-through here could resolve a
// WRONG credential from a later provider).

/** A DB error meaning the `stored_secret` table isn't migrated — sqlite/postgres/mysql phrasings. */
function isMissingTableError(err: unknown): boolean {
	const message = errorMessage(err).toLowerCase();
	return (
		message.includes("no such table") || // sqlite
		message.includes("does not exist") || // postgres: relation "stored_secret" does not exist
		message.includes("doesn't exist") || // mysql
		message.includes("no such relation") ||
		message.includes("unknown table")
	);
}

/** Rethrow a table-missing DB error as an actionable configurationError; otherwise rethrow as-is. */
function wrapMissingTable(err: unknown): never {
	if (isMissingTableError(err)) {
		throw configurationError(
			"stored_secret table isn't in your database — run the migration for the secrets() store",
			{
				reason:
					"enabling secrets({ store }) adds stored_secret to the generated schema — run generate + migrate to create it",
				cause: errorMessage(err),
			},
		);
	}
	throw err;
}

/** Run one adapter op behind the missing-table safety net. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		return wrapMissingTable(err);
	}
}

function assertSetInput(input: unknown): SetStoredSecretInput {
	const valid = setStoredSecretInput(input);
	if (valid instanceof type.errors) {
		throw validationError("stored secret input invalid", valid.summary);
	}
	return valid;
}

type SecretWhere = EntityWhere<typeof storedSecretFields>;

const keyWhere = (
	scope: string,
	scopeId: string,
	name: string,
): SecretWhere[] => [
	{ field: "scope", value: scope },
	{ field: "scopeId", value: scopeId, connector: "AND" },
	{ field: "name", value: name, connector: "AND" },
];

/** Back the StoredSecretsStore port with the entity-validating adapter the assembly hands through
 *  the configure context (entityView opens the typed lens for this plugin's own model — every row
 *  crossing the adapter boundary is parsed against the record schema; tests wrap manually). */
export function createStoredSecretsStore(
	adapter: Adapter,
	options: StoredSecretsStoreOptions,
): StoredSecretsStore {
	const db = entityView(adapter, {
		stored_secret: { fields: storedSecretFields },
	});
	const { cipher } = options;
	const now = options.now ?? (() => new Date().toISOString());

	const findByKey = (
		scope: string,
		scopeId: string,
		name: string,
	): Promise<StoredSecretRecord | null> =>
		guarded(() =>
			db.findOne({
				model: MODEL,
				where: keyWhere(scope, scopeId, name),
			}),
		);

	return {
		async set(input) {
			const valid = assertSetInput(input);
			// This slice writes value-kind rows only (pointer rows arrive WITH their target-gate, a
			// later slice) — a set without material is meaningless, reject at the boundary.
			if (valid.value === undefined) {
				throw validationError(
					"stored secret input invalid",
					"value is required — the store writes value-kind rows",
				);
			}
			// A secret is personal to its creator until saved wider — the one scope literal in this
			// store (mirrors claws.create / the skills installation store).
			const scope = valid.scope ?? "personal";
			const scopeId = valid.scopeId ?? valid.createdBy;
			// Seal BEFORE any adapter call — plaintext never at rest. An unresolvable master key
			// propagates loud out of the write (configurationError from the cipher), never a raw row.
			const sealed = await cipher.seal(valid.value);
			const existing = await findByKey(scope, scopeId, valid.name);
			const stamp = now();
			if (existing) {
				const updated = await guarded(() =>
					db.update({
						model: MODEL,
						where: [{ field: "id", value: existing.id }],
						// The store owns updatedAt; the value is the only column a re-set rotates.
						update: { value: sealed, updatedAt: stamp },
					}),
				);
				if (!updated) {
					throw stateError("stored secret vanished mid-set", {
						id: existing.id,
					});
				}
				return updated;
			}
			return guarded(() =>
				db.create({
					model: MODEL,
					data: {
						id: newId(),
						createdBy: valid.createdBy,
						scope,
						scopeId,
						name: valid.name,
						kind: "value",
						value: sealed,
						createdAt: stamp,
						updatedAt: stamp,
					},
				}),
			);
		},

		async get(scope, scopeId, name) {
			// Every READ is parsed through the record schema inside the entity layer (untrusted
			// boundary: a hostile row fails loud, never a cast).
			return findByKey(scope, scopeId, name);
		},
	};
}
