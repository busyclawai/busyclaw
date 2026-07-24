import { asPrincipal, endpoints, validationError } from "@euroclaw/contracts";
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
// plain TS). Personal-only, so there is no scope/scopeId param AND no `principal` param: the owner is the
// whole access boundary and it is NEVER caller input — a body `principal` would let a caller key a row to
// a VICTIM (docs/plans/stamped-fields.md, #3). The owner comes SOLELY from the out-of-band app-authz
// caller argument (`claw.api.secrets.set(input, { principal })`) — the ONE identity path for a governed
// in-process call, and the actor floor guarantees it is present before the handler runs. (Over HTTP the
// adapter-ingress seam must resolve the caller from the session/token — a separate follow-on; the raw
// route hands the handler no caller yet, so an over-the-wire secrets call fails closed until it lands.)
export const setSecretInput = type({
	name: nonEmptyString.configure({
		euroclaw: {
			doc: "The natural-key name component: re-setting the same name for this caller rotates the stored value in place (an upsert on `(personal, caller, name)`) — it never creates a second row.",
		},
	}),
	value: type("string").configure({
		euroclaw: {
			doc: "Write-only material: the store seals it (AES-256-GCM) before any adapter call, so plaintext is never at rest. It is never returned by set or list and there is no get-plaintext method — it exits solely through the store provider (`secrets.get`).",
		},
	}),
});
export const deleteSecretInput = type({
	name: nonEmptyString.configure({
		euroclaw: {
			doc: "Delete is idempotent by construction: the store no-ops when `(personal, caller, name)` matches nothing, so deleting an absent or foreign name silently succeeds — only infrastructure failure throws.",
		},
	}),
});
export const listSecretInput = type({});

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

/** The out-of-band app-authz caller the PEP threads as the 2nd argument — the SOLE identity path. */
export type SecretsCaller = { principal?: string };

/** The `claw.api.secrets.*` management methods (present only on the store path). Every method keys
 *  strictly to the CALLER's `(personal, principal)` boundary — the owner rides in the 2nd `caller`
 *  argument (the app-authz identity path), never the input body (docs/plans/stamped-fields.md, #3). */
export type SecretsManagementApi = {
	/** Upsert a personal `value`-kind secret for the CALLER — pasting the same name again rotates the
	 *  value in place (one row). Returns the metadata VIEW, never the value. */
	set: (
		input: SetSecretInput,
		caller?: SecretsCaller,
	) => Promise<StoredSecretView>;
	/** Delete the CALLER's secret by name — idempotent (a no-op when the name isn't theirs / is absent). */
	delete: (input: DeleteSecretInput, caller?: SecretsCaller) => Promise<void>;
	/** The CALLER's own secrets as metadata VIEWS — names + timestamps, never values. */
	list: (
		input: ListSecretInput,
		caller?: SecretsCaller,
	) => Promise<StoredSecretView[]>;
};

/** The `claw.api` shape the store path contributes (folded onto `claw.api` via the `$Api` phantom). */
export type SecretsPluginApi = {
	readonly secrets: SecretsManagementApi;
};

/**
 * The governed owner of the row: the app-authz caller principal — the SOLE identity path (the owner is
 * NEVER read from the input body, so a caller can only ever touch their own rows;
 * docs/plans/stamped-fields.md, #3). Fails loud when the caller is absent — a secret row must have an
 * owner, and keying an owner-less secret to a shared fallback would let unauthenticated callers collide
 * on one credential boundary. The PEP's actor floor already guarantees a caller for a governed in-process
 * call; this backstops the raw HTTP route, which the adapter-ingress identity seam does not yet reach.
 */
function ownerFrom(caller: SecretsCaller | undefined): string {
	const raw = caller?.principal;
	if (raw === undefined) {
		throw validationError(
			"secret input invalid",
			"no owner principal — pass the app-authz caller `{ principal }` (the 2nd argument)",
		);
	}
	return raw;
}

/**
 * Build the management api over the store's lazy guard — a DECLARED `endpoints()` namespace, so the
 * adapter can route it (`POST /secrets/set`, `POST /secrets/delete`, `GET /secrets/list`) while the
 * in-process methods stay the plain handlers below. Every method resolves `requireStore()` at call time
 * (fails loud with no database, the provider's posture) and keys strictly to `(personal, owner)` — the
 * structural principal-scoping. The owner is the app-authz caller (2nd arg), input principal fallback.
 */
export function createSecretsManagementApi(
	requireStore: () => StoredSecretsStore,
): SecretsManagementApi {
	return endpoints({
		set: {
			input: setSecretInput,
			handler: async (
				input: SetSecretInput,
				caller?: SecretsCaller,
			): Promise<StoredSecretView> => {
				const valid = assertSetSecretInput(input);
				// Structural scoping: personal:owner, always. Both `createdBy` and the personal boundary
				// key are the caller — the caller never names a target — and `asPrincipal` re-establishes
				// the brand the `createdBy` stamp column carries. `kind` is the store's to write.
				const owner = asPrincipal(ownerFrom(caller));
				const record = await requireStore().set({
					name: valid.name,
					value: valid.value,
					createdBy: owner,
					scope: "personal",
					scopeId: owner,
				});
				return toView(record);
			},
		},
		delete: {
			input: deleteSecretInput,
			handler: async (
				input: DeleteSecretInput,
				caller?: SecretsCaller,
			): Promise<void> => {
				const valid = assertDeleteSecretInput(input);
				const owner = ownerFrom(caller);
				// Keys on the owner boundary, so it must match `set`'s scopeId.
				await requireStore().delete("personal", owner, valid.name);
			},
		},
		list: {
			input: listSecretInput,
			handler: async (
				input: ListSecretInput,
				caller?: SecretsCaller,
			): Promise<StoredSecretView[]> => {
				assertListSecretInput(input);
				const owner = ownerFrom(caller);
				// Reads the owner boundary the rows were written under.
				const records = await requireStore().list("personal", owner);
				return records.map(toView);
			},
		},
	});
}
