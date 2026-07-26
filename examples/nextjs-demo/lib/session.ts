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

/** A known demo user, or `undefined` for anything unrecognised — including nothing at all. */
export function userById(id: string | undefined): DemoUser | undefined {
	if (id === undefined) return undefined;
	return DEMO_USERS.find((u) => u.id === id);
}

export function principalOf(user: DemoUser): Principal {
	return `user:${user.id}` as Principal;
}

/** Read the demo user off a raw Request's Cookie header. `undefined` when there is no valid one. */
export function DEMO_ONLY_readPrincipal(
	request: Request,
): DemoUser | undefined {
	const header = request.headers.get("cookie") ?? "";
	const match = header
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${SESSION_COOKIE}=`));
	return userById(match?.slice(SESSION_COOKIE.length + 1));
}

/**
 * What `toNextJsHandler` is wired with.
 *
 * No cookie means `undefined`, NOT a default user. Falling back to one would make the identity seam
 * look like it works while never actually being exercised — every request would arrive as somebody,
 * and the fail-closed path would be dead code nobody ever saw run. Returning `undefined` is what a
 * real unauthenticated request looks like, and euroclaw answers it with a 403.
 *
 * Worth trying once: clear the cookie and the whole api stops answering.
 */
export function resolveCaller(request: Request): ClawApiCaller | undefined {
	const user = DEMO_ONLY_readPrincipal(request);
	return user === undefined ? undefined : { principal: principalOf(user) };
}
