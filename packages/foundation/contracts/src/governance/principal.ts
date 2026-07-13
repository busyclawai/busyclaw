// The Principal vocabulary: euroclaw's ONE identity concept — an AUTHORIZABLE "on behalf of whom?".
// It is the same "who" that attribution/audit, authz (Cedar's `principal`), data-scoping, and erasure
// all key off; authz is its loudest consumer, not its definition. It is NOT the concurrency
// actor-model — euroclaw's concurrency unit is the run/task, never this. Construct via the helpers and
// discriminate via `parsePrincipal`; never hand-format the tag. See docs/plans/principal-standardization.md.

import { validationError } from "@euroclaw/errors";
import { type } from "arktype";

/**
 * A Principal is an AUTHORIZABLE identity — the thing you could write a Cedar `permit`/`forbid`
 * about, and the "who" attribution/audit, authz, data-scoping, and erasure all key off. It answers
 * *"on behalf of whom?"*, NOT *"which concurrency actor?"* (euroclaw's concurrency unit is the
 * run/task, never this).
 *
 * The form is a tagged string `<kind>:<id>` — one legible column — with exactly two kinds:
 * - **`user:<hostUserId>`** — a human the host authenticated (from the `IdentityResolver`).
 * - **`system:<name>`** — a non-human euroclaw actor: `cron` (a scheduled run), `anonymous` (a
 *   stranger's bot conversation), `engine` (autonomous resume/compensation), `migration`. Build with
 *   {@link systemPrincipal}; the well-known ones are {@link SYSTEM_CRON} / {@link SYSTEM_ANONYMOUS}.
 *
 * These are NOT principals (they cannot be authorized, so none is ever a Principal): the **agent/claw**
 * (it *wields* a principal — borrowed authority, never its own), an **organization** (a scope/boundary),
 * a **role** (what a principal may do), a **tool** (a capability), the **external party**
 * (`externalActorId` — attribution/pii), the **transport endpoint** (`endpointKey` — routing).
 *
 * Slice 1: a plain `string` alias. Slice 4 brands it, so passing a raw string / external id where a
 * Principal is expected becomes a compile error — which is why call sites should construct via
 * {@link userPrincipal} / {@link systemPrincipal} and branch via {@link parsePrincipal}, not the raw tag.
 *
 * @see docs/plans/principal-standardization.md
 */
export type Principal = string;

/**
 * Build the principal for a human the host authenticated: `` `user:${id}` ``. The `id` is the host's
 * own user id (opaque to euroclaw, may itself contain colons, e.g. `auth0|abc`). A blank id is
 * rejected — a principal must identify someone.
 */
export function userPrincipal(id: string): Principal {
	if (id.trim() === "") {
		throw validationError(
			"principal invalid",
			"a user principal needs a non-empty host user id",
			{ id },
		);
	}
	return `user:${id}`;
}

/**
 * Build a non-human euroclaw principal: `` `system:${name}` `` (e.g. `system:cron`,
 * `system:anonymous`). A blank name is rejected. Prefer the well-known {@link SYSTEM_CRON} /
 * {@link SYSTEM_ANONYMOUS} constants over re-deriving them at each use site.
 */
export function systemPrincipal(name: string): Principal {
	if (name.trim() === "") {
		throw validationError(
			"principal invalid",
			"a system principal needs a non-empty name",
			{ name },
		);
	}
	return `system:${name}`;
}

/** The discriminated parts of a principal, or a rejection phrase for the one broken rule — the ONE
 *  place the well-formedness rules live, shared by {@link parsePrincipal} (throws) and the
 *  {@link principal} arktype schema (rejects at a boundary). `reject` reads as an arktype "must be…"
 *  expected-clause. Splits on the FIRST colon only, so an id may itself contain colons. */
function principalParts(
	value: string,
): { kind: "user" | "system"; id: string } | { reject: string } {
	const colon = value.indexOf(":");
	if (colon === -1) {
		return { reject: "a `<kind>:<id>` tagged principal — no colon found" };
	}
	const kind = value.slice(0, colon);
	const id = value.slice(colon + 1);
	if (kind === "") {
		return { reject: "a principal with a non-empty kind before the colon" };
	}
	if (id === "") {
		return { reject: "a principal with a non-empty id after the colon" };
	}
	if (kind === "user" || kind === "system") {
		return { kind, id };
	}
	return {
		reject: `a principal of kind "user" or "system" (got "${kind}")`,
	};
}

/**
 * Split a Principal into the `kind` (the discriminator authz/audit/erasure branch on) and its `id`.
 * Splits on the FIRST colon only, so an id may itself contain colons
 * (`user:auth0|abc:xyz` → `{ kind: "user", id: "auth0|abc:xyz" }`). Throws a `validationError` when the
 * value is not a well-formed principal: no colon, an empty kind, an empty id, or a kind that is not
 * exactly `"user"` or `"system"`.
 */
export function parsePrincipal(
	principal: Principal,
): { kind: "user" | "system"; id: string } {
	const parts = principalParts(principal);
	if ("reject" in parts) {
		throw validationError("principal invalid", `expected ${parts.reject}`, {
			principal,
		});
	}
	return parts;
}

/**
 * The BOUNDARY validator: a `string` that validates as a well-formed principal — the same rules
 * {@link parsePrincipal} enforces (a colon, a non-empty `user`|`system` kind, a non-empty id),
 * expressed as an arktype narrow. This is the `ark` behind {@link field.principal}, so a stamp
 * column validates a raw principal string on the way in (create inputs) and on the way out (durable
 * reads through the record schema) — an untagged / unauthorizable value can never enter or leave a
 * principal column. It stays a plain `string` at the persisted level (no morph): the tagged form IS
 * the stored form.
 */
export const principal = type("string").narrow((value, ctx) => {
	const parts = principalParts(value);
	return "reject" in parts ? ctx.reject(parts.reject) : true;
});

/** The well-known system principal for a scheduled run. */
export const SYSTEM_CRON: Principal = systemPrincipal("cron");

/** The well-known system principal for a stranger's (unauthenticated) bot conversation. */
export const SYSTEM_ANONYMOUS: Principal = systemPrincipal("anonymous");
