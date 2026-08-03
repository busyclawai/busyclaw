import {
	type Adapter,
	configurationError,
	type EntityRecord,
	type EntitySchemaInput,
	errorMessage,
	isConflict,
	stateError,
	validationError,
} from "@busyclaw/contracts";
import type { SecretCipher } from "@busyclaw/secrets";
import { type EntityWhere, entityView } from "@busyclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
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
	/** Delete the row at the exact `(scope, scopeId, name)` key — a no-op when no such row exists
	 *  (so the management api's `delete` is idempotent by construction). */
	delete: (scope: string, scopeId: string, name: string) => Promise<void>;
	/** Every row inside one `(scope, scopeId)` boundary (for personal: one principal's secrets). Returns
	 *  FULL records — the `value` is the SEALED form, NEVER opened here; the read side strips it to a
	 *  metadata view. The store stays a dumb data port: no decrypt, no projection. */
	list: (scope: string, scopeId: string) => Promise<StoredSecretRecord[]>;
};

export type StoredSecretsStoreOptions = {
	/** Seals values on the write path — REQUIRED so plaintext structurally cannot reach the adapter
	 *  (the plugin builds one over its master key; tests build one over a fixed key). */
	cipher: SecretCipher;
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

const MODEL = "stored_secret";

/**
 * The row id for one `(scope, scopeId, name)` — the natural key, hashed.
 *
 * M-13. `set` used to read the row, then create or update depending on what it found, with a random
 * id. Two concurrent sets of the same name both missed and both created, leaving two rows for one
 * resolution key — and the read path uses `findOne`, so which value a lookup served afterwards was
 * arbitrary. A caller who rotated a secret could go on being served the old one, which is the exact
 * failure rotation exists to prevent.
 *
 * There is no compound unique in the entity DSL to lean on, but there does not need to be: making
 * the natural key BE the id borrows the uniqueness the primary key already has. The insert becomes
 * the claim, the database arbitrates, and a duplicate is a conflict rather than a race two readers
 * can both win — the same shape the effect ledger, the approval lease and the channel delivery inbox
 * use, for the same reason.
 *
 * Hashed as a JSON array for the same reason the AAD binding is: concatenating the parts would make
 * `("a","bc",…)` and `("ab","c",…)` collide, and here a collision is one boundary's secret answering
 * for another's.
 */
function rowId(scope: string, scopeId: string, name: string): string {
	return bytesToHex(
		sha256(utf8ToBytes(JSON.stringify([scope, scopeId, name]))),
	);
}

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

// M-13. The schema said "a string" and stopped there, so a name and a value were each bounded only
// by what the caller cared to send — and this table is the honeypot, reached through an authenticated
// api that anyone with an account can write to.
//
// The name additionally has a GRAMMAR, because it is a resolution key, not a label. Names come from
// callers and are compared against provider-supplied ones (env vars, the deployment's own), so
// leading/trailing space, or two names differing only by case, are the makings of a lookup that
// resolves to a row nobody meant. Canonical means: trimmed, and drawn from an alphabet where two
// distinct-looking names are distinct.
const MAX_SECRET_NAME_LENGTH = 128;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const SECRET_NAME_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSetInput(input: unknown): SetStoredSecretInput {
	const valid = setStoredSecretInput(input);
	if (valid instanceof type.errors) {
		throw validationError("stored secret input invalid", valid.summary);
	}
	const name = valid.name.trim();
	if (name !== valid.name) {
		// Refused rather than silently trimmed: a caller who wrote `" AWS_KEY"` and a caller who wrote
		// `"AWS_KEY"` mean the same row, and quietly making that true would hide the fact that one of
		// them is generating names from something untrusted.
		throw validationError(
			"stored secret name has leading or trailing whitespace",
			JSON.stringify(valid.name),
		);
	}
	if (name.length === 0 || name.length > MAX_SECRET_NAME_LENGTH) {
		throw validationError(
			"stored secret name is out of range",
			`1..${MAX_SECRET_NAME_LENGTH} characters, received ${name.length}`,
		);
	}
	if (!SECRET_NAME_GRAMMAR.test(name)) {
		throw validationError(
			"stored secret name is not canonical",
			"letters, digits, dot, dash and underscore only, starting with a letter or digit",
		);
	}
	// Presence is a separate rule enforced downstream ("value is required"); this only bounds a value
	// that IS there, so the two messages stay distinct.
	if (
		valid.value !== undefined &&
		valid.value.length > MAX_SECRET_VALUE_BYTES
	) {
		// Length, not the value: this message travels to logs and to the caller.
		throw validationError(
			"stored secret value is too large",
			`limit ${MAX_SECRET_VALUE_BYTES} bytes, received ${valid.value.length}`,
		);
	}
	return valid;
}

type SecretWhere = EntityWhere<typeof storedSecretFields>;

/** The two-clause boundary predicate — every row inside one `(scope, scopeId)`. `list` reads it
 *  whole; `keyWhere` narrows it to a single name. */
const boundaryWhere = (scope: string, scopeId: string): SecretWhere[] => [
	{ field: "scope", value: scope },
	{ field: "scopeId", value: scopeId, connector: "AND" },
];

const keyWhere = (
	scope: string,
	scopeId: string,
	name: string,
): SecretWhere[] => [
	...boundaryWhere(scope, scopeId),
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
			// Bound to the RESOLVED boundary (the defaults above, not the raw input), because that tuple
			// is what the read path will look this row up by — bind to anything else and the two can
			// disagree. A re-set rotates only `value`, so the binding stays true for the row's life.
			const sealed = await cipher.seal(valid.value, {
				scope,
				scopeId,
				name: valid.name,
			});
			const stamp = now();
			const id = rowId(scope, scopeId, valid.name);
			// CREATE FIRST, update on conflict — not read-then-decide. The id is the natural key, so a
			// second concurrent set loses the insert instead of minting a rival row.
			try {
				return await db.create({
					model: MODEL,
					data: {
						id,
						createdBy: valid.createdBy,
						scope,
						scopeId,
						name: valid.name,
						kind: "value",
						value: sealed,
						createdAt: stamp,
						updatedAt: stamp,
					},
				});
			} catch (err) {
				if (!isConflict(err)) return wrapMissingTable(err);
				// The row already exists — this set is a rotation. Only `value` moves; `createdBy` and
				// the boundary are the row's identity and stay as first written, which is also what
				// keeps the seal's binding true for the row's whole life.
				const updated = await guarded(() =>
					db.update({
						model: MODEL,
						where: [{ field: "id", value: id }],
						update: { value: sealed, updatedAt: stamp },
					}),
				);
				if (!updated) {
					throw stateError("stored secret vanished mid-set", { id });
				}
				return updated;
			}
		},

		async get(scope, scopeId, name) {
			// Every READ is parsed through the record schema inside the entity layer (untrusted
			// boundary: a hostile row fails loud, never a cast).
			return findByKey(scope, scopeId, name);
		},

		async delete(scope, scopeId, name) {
			// The adapter no-ops when nothing matches, so deleting an absent name is silently fine
			// (idempotence the management api relies on). Infrastructure failure still throws (guarded).
			await guarded(() =>
				db.delete({ model: MODEL, where: keyWhere(scope, scopeId, name) }),
			);
		},

		async list(scope, scopeId) {
			// Whole-boundary read — the rows carry the SEALED value, and this port never opens the
			// cipher for a list (the value never leaves via management; only the provider's read path
			// decrypts). The read side strips each row to a metadata view.
			return guarded(() =>
				db.findMany({ model: MODEL, where: boundaryWhere(scope, scopeId) }),
			);
		},
	};
}
