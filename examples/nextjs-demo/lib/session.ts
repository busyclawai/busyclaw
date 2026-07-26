// The identity seam, in its smallest honest form.
//
// euroclaw's HTTP adapter never reads a who-am-I field out of a request body — it asks the HOST
// via `resolveCaller`, and the host is expected to derive the principal from a SERVER-VERIFIED
// session. A real app puts better-auth (or its own session check) here. This demo puts a signed-
// nothing cookie here, because the point of the demo is what happens AFTER identity is known.
//
// It is deliberately not pretending to be auth: `DEMO_ONLY_readPrincipal` is named so that copying
// it into a real app is uncomfortable. Everything downstream — the PEP, owner isolation, the
// stamped `createdBy`/`decidedBy` fields, the audit chain — is the real thing.

import type { ClawApiCaller, Principal } from "@euroclaw/contracts";

export type DemoUser = {
	id: string;
	name: string;
	role: string;
};

export const DEMO_USERS: readonly DemoUser[] = [
	{ id: "konstantin", name: "Konstantin", role: "Support lead" },
	{ id: "ana", name: "Ana", role: "Support agent" },
	{ id: "finance", name: "Priya", role: "Finance approver" },
];

export const SESSION_COOKIE = "euroclaw_demo_user";

export const DEFAULT_USER: DemoUser = DEMO_USERS[0] as DemoUser;

export function userById(id: string | undefined): DemoUser {
	if (id === undefined) return DEFAULT_USER;
	return DEMO_USERS.find((u) => u.id === id) ?? DEFAULT_USER;
}

export function principalOf(user: DemoUser): Principal {
	return `user:${user.id}` as Principal;
}

/** Read the demo user off a raw Request's Cookie header. */
export function DEMO_ONLY_readPrincipal(request: Request): DemoUser {
	const header = request.headers.get("cookie") ?? "";
	const match = header
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${SESSION_COOKIE}=`));
	return userById(match?.slice(SESSION_COOKIE.length + 1));
}

/**
 * What `toNextJsHandler` is wired with. Returning `undefined` here is what a real unauthenticated
 * request looks like — and euroclaw fails CLOSED on it (403), rather than falling back to some
 * ambient identity. Worth seeing once in the demo: clear the cookie and the api stops answering.
 */
export function resolveCaller(request: Request): ClawApiCaller {
	return { principal: principalOf(DEMO_ONLY_readPrincipal(request)) };
}
