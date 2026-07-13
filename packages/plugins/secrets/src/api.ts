import {
	endpoints,
	principal as principalSchema,
	validationError,
} from "@euroclaw/contracts";
import { type } from "arktype";
import type { StoredSecretRecord, StoredSecretsStore } from "./store";

// The personal secret-store MANAGEMENT api — end-user self-service over a caller's OWN secrets
// (docs/plans/secret-store-plugin.md, "Management surface"). Two posture decisions are load-bearing:
//
//   - PERSONAL-ONLY, structurally principal-scoped. Every method keys strictly to `(personal,
//     input.principal)`; none takes a scope/scopeId or a target principal, so a caller can only ever
//     touch their own rows. That scoping IS the access control in v0: the app-authz PEP that will wrap
//     claw.api (docs/plans/app-authz.md) is NOT built yet, so the surface is HOST-GATED — the host
//     authenticates the user and passes `principal` through function-intake, and euroclaw trusts that
//     principal exactly like the rest of claw.api. Org-wide / admin-tier rows are deferred WITH app-authz.
//
//   - VALUES ARE WRITE-ONLY. `set` and `list` return metadata VIEWS only — never the value, nor the
//     `provider`/`ref` pointer fields — and there is no get-plaintext method at all. The material
//     exits solely through the store provider (`secrets.get`) into governed consumers.

/** A string that is non-empty after trimming (plain `"string"` accepts `""`). The secret name is
 *  validated non-empty at the boundary, so a blank name never keys a row to nowhere. The
 *  `.describe()` doubles as documentation: it flows through `toJsonSchema()` into the generated
 *  OpenAPI document (and into the domain-mismatch error message). */
const nonEmptyString = type("string")
	.narrow((value, ctx) => value.trim().length > 0 || ctx.reject("non-empty"))
	.describe("a non-empty secret name");

// The boundary inputs — host-passed, UNTRUSTED, so arktype validates HERE (internal store calls stay
// plain TS). Personal-only, so there is no scope/scopeId param: the principal is the whole boundary.
// `principalSchema` (the contracts `principal` narrow) rejects a bare / malformed value, so a row is
// never keyed to an untagged / unauthorizable owner — the host constructs it via `userPrincipal(id)`.
export const setSecretInput = type({
	name: nonEmptyString,
	value: "string",
	principal: principalSchema,
});
export const deleteSecretInput = type({
	name: nonEmptyString,
	principal: principalSchema,
});
export const listSecretInput = type({ principal: principalSchema });

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
	/** Upsert a personal `value`-kind secret for `principal` — pasting the same name again rotates the
	 *  value in place (one row). Returns the metadata VIEW, never the value. */
	set: (input: SetSecretInput) => Promise<StoredSecretView>;
	/** Delete `principal`'s secret by name — idempotent (a no-op when the name isn't theirs / is absent). */
	delete: (input: DeleteSecretInput) => Promise<void>;
	/** `principal`'s own secrets as metadata VIEWS — names + timestamps, never values. */
	list: (input: ListSecretInput) => Promise<StoredSecretView[]>;
};

/** The `claw.api` shape the store path contributes (folded onto `claw.api` via the `$Api` phantom). */
export type SecretsPluginApi = {
	readonly secrets: SecretsManagementApi;
};

/**
 * Build the management api over the store's lazy guard — a DECLARED `endpoints()` namespace, so the
 * adapter can route it (`POST /secrets/set`, `POST /secrets/delete`, `GET /secrets/list`) while the
 * in-process methods stay the plain handlers below. Every method resolves `requireStore()` at
 * call time (fails loud with no database, the provider's posture) and keys strictly to
 * `(personal, principal)` — the structural principal-scoping that IS v0's access control.
 */
export function createSecretsManagementApi(
	requireStore: () => StoredSecretsStore,
): SecretsManagementApi {
	return endpoints({
		set: {
			input: setSecretInput,
			handler: async (input: SetSecretInput): Promise<StoredSecretView> => {
				const valid = assertSetSecretInput(input);
				// Structural scoping: personal:principal, always. The HOST passes the already-tagged
				// `Principal` (it constructs `userPrincipal(userId)` at the trusted boundary); the api takes it
				// directly. Both `createdBy` and the personal boundary key are that principal — the caller never
				// names a target — and because sessionIdentity stamps the same principal onto ctx.principal, the
				// written `scopeId` matches the provider's read. `kind` is the store's to write (value-kind
				// rows), so it is not passed here.
				const record = await requireStore().set({
					name: valid.name,
					value: valid.value,
					createdBy: valid.principal,
					scope: "personal",
					scopeId: valid.principal,
				});
				return toView(record);
			},
		},
		delete: {
			input: deleteSecretInput,
			handler: async (input: DeleteSecretInput): Promise<void> => {
				const valid = assertDeleteSecretInput(input);
				// Keys on the principal boundary, so it must match `set`'s scopeId.
				await requireStore().delete("personal", valid.principal, valid.name);
			},
		},
		list: {
			input: listSecretInput,
			handler: async (input: ListSecretInput): Promise<StoredSecretView[]> => {
				const valid = assertListSecretInput(input);
				// Reads the principal boundary the rows were written under.
				const records = await requireStore().list("personal", valid.principal);
				return records.map(toView);
			},
		},
	});
}
