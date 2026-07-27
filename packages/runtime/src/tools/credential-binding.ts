// Where a registered tool's credential may go, and how it is placed there.
//
// Credential resolution keys on the registration SOURCE name; the destination came independently from
// the uploaded spec's `servers:`. Nothing tied the two together, so a spec replaced under an existing
// source kept the name, changed the server, and the next invocation resolved the established
// credential and sent it to the new host — a confused deputy with the operator's own secret.
//
// The tie is a pair recorded on each row at registration and re-asserted at two moments: when a
// re-registration would move it (fail loud, before any write) and when a credential is about to be
// placed (fail closed, before the secret is even resolved). Deriving it from the binding at use time
// would prove nothing — the binding is the thing that gets edited.

import {
	configurationError,
	errorMessage,
	validationError,
} from "@busyclaw/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { normalizeOrigin } from "./invoke/request-plan";
import type { OpenApiBinding } from "./sources/openapi/binding";

/** What a row pins: the canonical destination and the shape of the credential placement. */
export type CredentialBinding = {
	credentialOrigin: string;
	credentialPlacement: string;
};

/**
 * The placement digest — every security scheme's identity and where its material lands, order-
 * independent (a spec may list schemes in any order; that is not a change).
 *
 * Covers what an edit could relocate: the scheme NAME (which requirement it satisfies), its TYPE, and
 * for `apiKey` the `in`/`name` it writes to, for `http` the bearer-vs-basic choice. `oauth2` and
 * `openIdConnect` carry only a type, which is all the invoker reads from them.
 */
export function placementDigest(binding: OpenApiBinding): string {
	const lines = Object.entries(binding.authSchemes ?? {})
		.map(([name, def]) => {
			if (def.type === "apiKey") {
				return `${name}\tapiKey\t${def.in}\t${def.name}`;
			}
			if (def.type === "http") return `${name}\thttp\t${def.scheme}`;
			return `${name}\t${def.type}`;
		})
		.sort();
	return bytesToHex(sha256(utf8ToBytes(lines.join("\n"))));
}

/**
 * Derive the pair from a freshly extracted binding. A binding with no `server` has no destination to
 * approve, so it is refused at REGISTRATION rather than becoming a row whose credential could later be
 * sent anywhere — an unresolvable origin is a spec problem, and the caller can see it now.
 */
export function credentialBindingOf(
	binding: OpenApiBinding,
	context: { source: string; address: string },
): CredentialBinding {
	// `normalizeOrigin` throws on a spec with no `servers:`. That check already existed, but it ran at
	// the FIRST INVOCATION — so a serverless spec registered cleanly and failed later, in a run, at the
	// tool call. Reaching it here moves the same refusal to the upload, where the person holding the
	// document is still there; the enrichment is which operation to look at.
	let credentialOrigin: string;
	try {
		credentialOrigin = normalizeOrigin(binding.server);
	} catch (cause) {
		throw validationError(
			"registered operation has no server URL to bind its credential to",
			"give the document (or the operation) a `servers:` entry with an absolute URL",
			{ ...context, cause: errorMessage(cause) },
		);
	}
	return { credentialOrigin, credentialPlacement: placementDigest(binding) };
}

/**
 * The INVOCATION-time half: refuse to build a request whose destination is not the origin this row's
 * credential was approved for.
 *
 * Registration already refuses to move the pin, so in a healthy system this never fires. It is here
 * because the registration check protects one path and this protects the value itself: a binding
 * mutated by a direct write, a restored backup, a bug elsewhere — none of them go through `register`,
 * and all of them end here, before any secret is resolved. Fail-closed and cheap.
 */
export function assertApprovedOrigin(
	url: string,
	row: CredentialBinding & { address: string; source: string },
	allowInsecure?: boolean,
): void {
	const target = normalizeOrigin(url);
	if (target === row.credentialOrigin) return;
	// A host that opted into plaintext for local development is comparing http:// against an https://
	// pin (or the reverse) and would be blocked on scheme alone. The HOST is what a credential is
	// approved for; the scheme is the egress floor's call, and `allowInsecure` is where that is said.
	if (
		allowInsecure === true &&
		stripScheme(target) === stripScheme(row.credentialOrigin)
	) {
		return;
	}
	throw configurationError(
		"registered tool would send its credential to an unapproved origin",
		{
			address: row.address,
			source: row.source,
			approvedOrigin: row.credentialOrigin,
			attemptedOrigin: target,
			reason:
				"the stored binding no longer matches the origin this credential was registered against — re-register the source, or investigate how the binding changed",
		},
	);
}

const stripScheme = (origin: string): string =>
	origin.replace(/^https?:\/\//, "");

/**
 * Refuse a re-registration that would move an existing row's credential.
 *
 * There is deliberately no flag to wave this through. Sending an established credential somewhere new
 * is a new trust relationship, not an attribute of a routine spec upload, and a boolean on the same
 * call an attacker already controls would authorize nothing. Register the new destination under a NEW
 * source name — it starts with no credential, and configuring one is the explicit act.
 */
export function assertCredentialBindingUnchanged(
	prior: CredentialBinding,
	next: CredentialBinding,
	context: { source: string; address: string },
): void {
	if (prior.credentialOrigin !== next.credentialOrigin) {
		throw configurationError(
			"re-registration would send this source's credential to a different origin",
			{
				...context,
				approvedOrigin: prior.credentialOrigin,
				attemptedOrigin: next.credentialOrigin,
				reason:
					"a credential is approved for the origin it was registered against — register the new destination under a new source name and configure its own credential",
			},
		);
	}
	if (prior.credentialPlacement !== next.credentialPlacement) {
		throw configurationError(
			"re-registration would place this source's credential differently",
			{
				...context,
				approvedOrigin: prior.credentialOrigin,
				reason:
					"the security schemes changed how the credential is sent (header/query/scheme) — register the new shape under a new source name",
			},
		);
	}
}
