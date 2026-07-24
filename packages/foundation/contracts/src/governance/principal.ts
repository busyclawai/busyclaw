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
 * BRANDED (slice 4): a raw `string` is no longer assignable where a `Principal` is expected — passing
 * a bare host id or an external id at a stamp column / principal boundary is now a COMPILE error. The
 * brand is minted ONLY by construction ({@link userPrincipal} / {@link systemPrincipal}) or by parsing
 * a raw string through the {@link principal} schema (durable-store reads, host-input validators). It is
 * still a plain `string` at runtime — the `__brand` is phantom, never present on the persisted value.
 *
 * A structural brand (not arktype's `.brand`) so the type is self-contained in contracts: every entity
 * / record / input that transitively carries a principal column must name `Principal` in its emitted
 * declaration, and a `@ark/util`-referencing brand is not portable across the consumer packages.
 *
 * @see docs/plans/principal-standardization.md
 */
export type Principal = string & { readonly __brand: "Principal" };

/**
 * The out-of-band caller context every governed `claw.api` method takes as its 2nd argument — the
 * function-intake image of better-auth's server `auth.api.x({ headers })`. Identity travels BESIDE the
 * pure domain input, never inside it: the PEP reads `principal` as the authz subject, and the HTTP
 * adapter's `resolveCaller` seam fills it from the session/token (never the request body). A shared
 * protocol type — euroclaw's api surface (the `WithCaller` transform) and the adapter name ONE caller
 * type instead of re-declaring `{ principal? }` at each boundary.
 */
export type ClawApiCaller = { principal?: Principal };

/**
 * Build the principal for a human the host authenticated: `` `user:${id}` ``. The `id` is the host's
 * own user id (opaque to euroclaw, may itself contain colons, e.g. `auth0|abc`). A blank id is
 * rejected — a principal must identify someone. This constructor is a sanctioned brand producer: the
 * value is well-formed by construction, so the brand is stamped without re-parsing.
 */
export function userPrincipal(id: string): Principal {
	if (id.trim() === "") {
		throw validationError(
			"principal invalid",
			"a user principal needs a non-empty host user id",
			{ id },
		);
	}
	return `user:${id}` as Principal;
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
	return `system:${name}` as Principal;
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
export function parsePrincipal(principal: string): {
	kind: "user" | "system";
	id: string;
} {
	const parts = principalParts(principal);
	if ("reject" in parts) {
		throw validationError("principal invalid", `expected ${parts.reject}`, {
			principal,
		});
	}
	return parts;
}

/**
 * Validate a raw string AT A BOUNDARY and return it as a branded {@link Principal}. The parse-to-brand
 * primitive for values that arrive untyped — a stamped context fact, a durable-store read, a host
 * input — where the static type is only `string` but the value must already be a well-formed principal
 * (typically produced upstream by {@link userPrincipal}). Throws a `validationError` (via
 * {@link parsePrincipal}) when it is not, so a non-principal can never be branded past the boundary.
 * Use the constructors at PRODUCERS (mint a fresh principal from an id); use this at PARSE boundaries
 * (re-establish the brand on a value that is already tagged).
 */
export function asPrincipal(value: string): Principal {
	parsePrincipal(value);
	return value as Principal;
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
