import { userPrincipal, validationError } from "@euroclaw/contracts";
import { type } from "arktype";
import type { StoredSecretRecord, StoredSecretsStore } from "./store";

// The personal secret-store MANAGEMENT api — end-user self-service over a caller's OWN secrets
// (docs/plans/secret-store-plugin.md, "Management surface"). Two posture decisions are load-bearing:
//
//   - PERSONAL-ONLY, structurally actor-scoped. Every method keys strictly to `(personal,
//     input.actor)`; none takes a scope/scopeId or a target actor, so a caller can only ever touch
//     their own rows. That scoping IS the access control in v0: the app-authz PEP that will wrap
//     claw.api (docs/plans/app-authz.md) is NOT built yet, so the surface is HOST-GATED — the host
//     authenticates the user and passes `actor` through function-intake, and euroclaw trusts that
//     actor exactly like the rest of claw.api. Org-wide / admin-tier rows are deferred WITH app-authz.
//
//   - VALUES ARE WRITE-ONLY. `set` and `list` return metadata VIEWS only — never the value, nor the
//     `provider`/`ref` pointer fields — and there is no get-plaintext method at all. The material
//     exits solely through the store provider (`secrets.get`) into governed consumers.

/** A string that is non-empty after trimming (plain `"string"` accepts `""`). The identity fields —
 *  the secret name and the owning actor — are validated non-empty at the boundary, so a missing or
 *  blank actor fails loud rather than keying a row to nobody. */
const nonEmptyString = type("string").narrow(
	(value, ctx) => value.trim().length > 0 || ctx.reject("non-empty"),
);

// The boundary inputs — host-passed, UNTRUSTED, so arktype validates HERE (internal store calls stay
// plain TS). Personal-only, so there is no scope/scopeId param: the actor is the whole boundary.
export const setSecretInput = type({
	name: nonEmptyString,
	value: "string",
	actor: nonEmptyString,
});
export const deleteSecretInput = type({
	name: nonEmptyString,
	actor: nonEmptyString,
});
export const listSecretInput = type({ actor: nonEmptyString });

export type SetSecretInput = typeof setSecretInput.infer;
export type DeleteSecretInput = typeof deleteSecretInput.infer;
export type ListSecretInput = typeof listSecretInput.infer;

/** What `set` and `list` return: metadata ONLY. NEVER the `value` (write-only), nor the
 *  `provider`/`ref` pointer fields (the deferred pointer kind). A host-assembled view over a trusted
 *  record — plain TS, no schema. */
export type StoredSecretView = {
	name: string;
	kind: StoredSecretRecord["kind"];
	createdBy: string;
	createdAt: string;
	updatedAt: string;
};

/** Project a row to its write-only-safe view — the ONE place a record is narrowed for return, so the
 *  value (and any pointer target) structurally cannot leave through the management surface. */
const toView = (record: StoredSecretRecord): StoredSecretView => ({
	name: record.name,
	kind: record.kind,
	createdBy: record.createdBy,
	createdAt: record.createdAt,
	updatedAt: record.updatedAt,
});

function assertSetSecretInput(input: unknown): SetSecretInput {
	const valid = setSecretInput(input);
	if (valid instanceof type.errors) {
		throw validationError("set secret input invalid", valid.summary);
	}
	return valid;
}

function assertDeleteSecretInput(input: unknown): DeleteSecretInput {
	const valid = deleteSecretInput(input);
	if (valid instanceof type.errors) {
		throw validationError("delete secret input invalid", valid.summary);
	}
	return valid;
}

function assertListSecretInput(input: unknown): ListSecretInput {
	const valid = listSecretInput(input);
	if (valid instanceof type.errors) {
		throw validationError("list secret input invalid", valid.summary);
	}
	return valid;
}

/** The `claw.api.secrets.*` management methods (present only on the store path). */
export type SecretsManagementApi = {
	/** Upsert a personal `value`-kind secret for `actor` — pasting the same name again rotates the
	 *  value in place (one row). Returns the metadata VIEW, never the value. */
	set: (input: SetSecretInput) => Promise<StoredSecretView>;
	/** Delete `actor`'s secret by name — idempotent (a no-op when the name isn't theirs / is absent). */
	delete: (input: DeleteSecretInput) => Promise<void>;
	/** `actor`'s own secrets as metadata VIEWS — names + timestamps, never values. */
	list: (input: ListSecretInput) => Promise<StoredSecretView[]>;
};

/** The `claw.api` shape the store path contributes (folded onto `claw.api` via the `$Api` phantom). */
export type SecretsPluginApi = {
	readonly secrets: SecretsManagementApi;
};

/**
 * Build the management api over the store's lazy guard. Every method resolves `requireStore()` at
 * call time (fails loud with no database, the provider's posture) and keys strictly to
 * `(personal, actor)` — the structural actor-scoping that IS v0's access control.
 */
export function createSecretsManagementApi(
	requireStore: () => StoredSecretsStore,
): SecretsManagementApi {
	return {
		async set(input) {
			const valid = assertSetSecretInput(input);
			// Structural scoping: personal:principal, always. The store is end-user self-service, so the
			// host-authenticated actor is always a user — tag it as the `user:<id>` principal at this
			// producing boundary (the api INPUT stays a raw host id). Both `createdBy` and the boundary
			// take that principal — the caller never names a target — and because sessionIdentity stamps
			// the same `user:<id>` onto ctx.actor, the written `scopeId` matches the provider's read.
			// `kind` is the store's to write (value-kind rows), so it is not passed here.
			const principal = userPrincipal(valid.actor);
			const record = await requireStore().set({
				name: valid.name,
				value: valid.value,
				createdBy: principal,
				scope: "personal",
				scopeId: principal,
			});
			return toView(record);
		},
		async delete(input) {
			const valid = assertDeleteSecretInput(input);
			// Same tag as the write — delete keys on the principal boundary, so it must match `set`'s scopeId.
			await requireStore().delete(
				"personal",
				userPrincipal(valid.actor),
				valid.name,
			);
		},
		async list(input) {
			const valid = assertListSecretInput(input);
			// Same tag as the write — list reads the principal boundary the rows were written under.
			const records = await requireStore().list(
				"personal",
				userPrincipal(valid.actor),
			);
			return records.map(toView);
		},
	};
}
