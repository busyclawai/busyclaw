// WHERE a credential goes on an outbound request — the one implementation, shared by the two callers
// that need it.
//
// The OpenAPI invoker reads placement from a spec's `securityScheme`; the governed fetch tool reads
// it from a destination binding, because a guest-supplied URL has no spec behind it. Those are two
// ways of DECIDING the placement and one way of performing it, and performing it twice is how a
// credential ends up in the right header on one path and the wrong one on the other — which is not a
// bug anybody notices from the outside, because both look like a 401.
//
// Foundation, so both tiers can reach it: the invoker lives in the runtime, the fetch tool lives here
// beside the floor.

import { configurationError, type SecretMaterial } from "@busyclaw/contracts";

/**
 * How a credential is placed on a request. The vocabulary is deliberately small — it is what an
 * HTTP credential can BE, not what any one spec dialect calls it.
 *
 * Request SIGNING (AWS SigV4, OAuth1) is absent and cannot be added here: a signature is computed
 * over the request with the secret, so it is not a placement at all. Naming it as one would make it
 * look supported.
 */
export type CredentialPlacement =
	| { kind: "bearer" }
	| { kind: "basic" }
	| { kind: "header"; name: string }
	| { kind: "query"; name: string };

/** What a placement writes to. Both callers own a URL and a mutable header bag; neither shares a
 *  request TYPE with the other, so this names the two fields rather than either's shape. */
export type CredentialTarget = {
	url: string;
	headers: Record<string, string>;
};

/**
 * Place `material` onto `target` per `placement`. Mutates, and returns nothing — the callers both
 * own a fresh copy by the time they get here, and pretending otherwise would invite one of them to
 * skip the copy.
 *
 * A material/placement mismatch FAILS LOUD rather than sending something malformed: `basic` needs a
 * username and password, everything else needs a token. A request that goes out with a credential
 * shaped wrong gets a 401 the caller then has to guess the cause of.
 */
export function placeCredential(
	target: CredentialTarget,
	placement: CredentialPlacement,
	material: SecretMaterial,
	// Named in the error so a misconfiguration says WHICH binding or scheme it came from.
	label: string,
): void {
	if (placement.kind === "basic") {
		if (material.kind !== "basic") {
			throw configurationError(
				`${label} places basic auth but the resolver returned ${material.kind} material`,
				{ label },
			);
		}
		target.headers.authorization = `Basic ${base64Utf8(
			`${material.username}:${material.password}`,
		)}`;
		return;
	}
	if (material.kind !== "token") {
		throw configurationError(
			`${label} needs token material but the resolver returned ${material.kind}`,
			{ label },
		);
	}
	if (placement.kind === "bearer") {
		target.headers.authorization = `Bearer ${material.value}`;
		return;
	}
	if (placement.kind === "header") {
		target.headers[placement.name] = material.value;
		return;
	}
	const separator = target.url.includes("?") ? "&" : "?";
	target.url = `${target.url}${separator}${encodeURIComponent(
		placement.name,
	)}=${encodeURIComponent(material.value)}`;
}

/**
 * The header a placement OWNS, or undefined for a query placement.
 *
 * Claim-check integrity needs this: before injecting, the caller strips whatever the guest put in
 * the slot this credential is about to fill. Without it a guest can smuggle its own token to a bound
 * host under the header the host manages — which reads, at the destination, exactly like the
 * deployment authorized it.
 */
export function managedHeader(
	placement: CredentialPlacement,
): string | undefined {
	if (placement.kind === "bearer" || placement.kind === "basic") {
		return "authorization";
	}
	if (placement.kind === "header") return placement.name;
	return undefined;
}

/** Base64 of a UTF-8 string using web-standard primitives (busyclaw packages avoid node `Buffer`
 *  types): TextEncoder → bytes → btoa. Correct for non-ASCII basic-auth credentials. */
function base64Utf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
