/**
 * THE SHAPE A BROWSER CAN SEND WITHOUT ASKING.
 *
 * A cross-site `<form method=post>` is a simple request: it goes out with the user's cookies, no
 * preflight, no script on the attacker's page. The content-type floor exists to remove that shape,
 * because a browser cannot send `application/json` cross-site without asking permission first.
 *
 * The floor had a carve-out for an EMPTY body, on the reasoning that nothing gets parsed so nothing
 * is at risk. The reasoning holds for the parse and not for the ROUTE: the handler still runs, with
 * `{}` as its input, and a method whose fields are all optional performs its action. `createClaw` is
 * exactly that method — so a form with no fields created a claw as the logged-in user.
 *
 * An HTML form cannot omit its encoding. That is what separates the two cases this file pins: a
 * declared type is answered for however empty the body is, and a request carrying neither header nor
 * body — which no form can produce — is left alone.
 */

import { userPrincipal } from "@busyclaw/contracts";
import { afterEach, expect, it } from "vitest";
import { BASE, httpFor, ROUTES } from "../src/http";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

/** The three encodings an HTML form can submit. None of them may reach a handler. */
const FORM_TYPES = [
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"text/plain",
];

async function cookieAuthenticated() {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
		principal: "user:alice",
	});
	// The precondition CSRF needs: identity resolved from ambient state, so a request the user never
	// meant to make still arrives as them.
	return {
		w,
		http: httpFor(w.claw, () => ({ principal: userPrincipal("alice") })),
	};
}

it("refuses a form-shaped write on every route, empty body included", async () => {
	const { w, http } = await cookieAuthenticated();
	open = w;

	const reached: string[] = [];
	for (const route of ROUTES) {
		if (route.httpMethod === "GET") continue;
		for (const contentType of FORM_TYPES) {
			const response = await http(
				new Request(`${BASE}${route.path}`, {
					method: route.httpMethod,
					headers: { "content-type": contentType },
					// EMPTY, which is what a form with no fields sends — and what used to skip the check.
					body: "",
				}),
			);
			const text = await response.text();
			if (!text.includes("unsupported content type")) {
				reached.push(`${route.httpMethod} ${route.path} (${contentType})`);
			}
		}
	}
	expect(reached).toEqual([]);
});

it("creates nothing from a fieldless cross-site form", async () => {
	// The concrete consequence, stated as itself. `createClaw` takes no required field, so it was the
	// one route that did not merely fail validation — it succeeded, and left a row behind.
	const { w, http } = await cookieAuthenticated();
	open = w;

	const before = (await w.rows("claw")).length;
	await http(
		new Request(`${BASE}/create-claw`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "",
		}),
	);
	expect((await w.rows("claw")).length).toBe(before);
});

it("still accepts a bodiless request that declares nothing", async () => {
	// THE CARVE-OUT THAT SURVIVES, and the reason the fix is narrow. A client POSTing genuinely
	// nothing sends no content-type, and no HTML form can produce that shape — so refusing it would
	// be collateral damage for no gain. `create-claw` with no body and no header is not a form.
	const { w, http } = await cookieAuthenticated();
	open = w;

	const response = await http(
		new Request(`${BASE}/create-claw`, { method: "POST" }),
	);
	expect(await response.text()).not.toContain("unsupported content type");
});
