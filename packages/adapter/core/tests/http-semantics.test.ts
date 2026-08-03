// How the HTTP door behaves as an HTTP door — M-10, M-17, L-10, L-11.
//
// Each of these was a place where the transport made a decision nobody had written down: what a
// media type means, which of two matching routes wins, what a duplicated query parameter is, and
// whether a per-caller answer may be cached. Left unstated, each resolved to whatever the code
// happened to do first.

import type { Claw } from "busyclaw";
import { describe, expect, it } from "vitest";
import { createClawClient, toRequestHandler } from "../src/index";

const base = "https://app.test/api/busyclaw";

function echoClaw(): Claw {
	return {
		api: {
			createClaw: async (input: unknown) => input,
			getClaw: async (input: unknown) => input,
		},
	} as unknown as Claw;
}

function post(body: unknown, headers: Record<string, string>): Request {
	return new Request(`${base}/create-claw`, {
		method: "POST",
		body: JSON.stringify(body),
		headers,
	});
}

describe("M-10 — media type", () => {
	it("accepts application/json", async () => {
		const response = await toRequestHandler(echoClaw())(
			post({ id: "c1" }, { "content-type": "application/json" }),
		);
		expect(response.status).toBe(200);
	});

	it("accepts a +json suffix and ignores parameters", async () => {
		const response = await toRequestHandler(echoClaw())(
			post(
				{ id: "c1" },
				{ "content-type": "application/vnd.busyclaw+json; charset=utf-8" },
			),
		);
		expect(response.status).toBe(200);
	});

	it.each([
		"text/plain",
		"application/x-www-form-urlencoded",
		"multipart/form-data",
	])("refuses %s — the shapes a cross-site form can send", async (media) => {
		// The CSRF vector: a plain HTML form on an attacker's page can POST any of these to another
		// origin with the user's cookies attached and no preflight. None can carry a JSON content
		// type, which is why demanding one removes the shape rather than filtering it.
		const response = await toRequestHandler(echoClaw())(
			post({ id: "c1" }, { "content-type": media }),
		);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: { message: expect.stringContaining("content type") },
		});
	});

	// R-M13. The guard returned early whenever the header was ABSENT — "no body declared, nothing was
	// parsed as one" — and then the very next line read the body and JSON.parsed it anyway. So the
	// whole media-type defence was reachable-around by leaving something OUT, which is the easiest
	// thing in the world for a raw HTTP client to do.
	//
	// The body is BYTES on purpose: `new Request(url, { body: "..." })` has the platform fill in
	// `text/plain` for you, so a string body cannot express "no content type" and a test written with
	// one proves nothing — it exercises the text/plain branch that already worked. A Uint8Array (or a
	// typeless Blob) is the shape that genuinely arrives header-less.
	it("refuses a body sent with no content type at all", async () => {
		const request = new Request(`${base}/create-claw`, {
			method: "POST",
			body: new TextEncoder().encode(JSON.stringify({ id: "c1" })),
		});
		expect(request.headers.get("content-type")).toBeNull();

		const response = await toRequestHandler(echoClaw())(request);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: { message: expect.stringContaining("content type") },
		});
	});

	// …and a request that genuinely carries NO body still needs no header: the check is about what
	// arrived, not about what was claimed, so a bodiless POST is not collateral.
	it("still accepts a bodiless request with no content type", async () => {
		const response = await toRequestHandler(echoClaw())(
			new Request(`${base}/create-claw`, { method: "POST" }),
		);
		await expect(response.json()).resolves.not.toMatchObject({
			error: { message: expect.stringContaining("content type") },
		});
	});
});

describe("L-10 — one representation, no duplicates", () => {
	const handler = toRequestHandler(echoClaw());

	it("reads flat query parameters", async () => {
		const response = await handler(new Request(`${base}/get-claw?id=c1`));
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			data: { id: "c1" },
		});
	});

	it("refuses `input` combined with query parameters", async () => {
		const response = await handler(
			new Request(
				`${base}/get-claw?input=${encodeURIComponent('{"id":"c1"}')}&id=c2`,
			),
		);
		expect(response.status).toBe(400);
	});

	it("refuses a repeated `input`", async () => {
		const one = encodeURIComponent('{"id":"c1"}');
		const two = encodeURIComponent('{"id":"c2"}');
		const response = await handler(
			new Request(`${base}/get-claw?input=${one}&input=${two}`),
		);
		expect(response.status).toBe(400);
	});

	it("refuses a repeated query parameter", async () => {
		// Silently taking one of them lets a proxy or a client that appends a duplicate change the
		// input a request carries without changing what a reader of the URL would see.
		const response = await handler(new Request(`${base}/get-claw?id=c1&id=c2`));
		expect(response.status).toBe(400);
	});
});

describe("L-11 — per-caller answers are not cacheable", () => {
	it("sends no-store on api responses and on errors", async () => {
		const handler = toRequestHandler(echoClaw());

		const ok = await handler(
			post({ id: "c1" }, { "content-type": "application/json" }),
		);
		expect(ok.headers.get("cache-control")).toBe("no-store");

		const bad = await handler(
			post({ id: "c1" }, { "content-type": "text/plain" }),
		);
		expect(bad.headers.get("cache-control")).toBe("no-store");
	});

	it("lets the OpenAPI document opt out — it is the same for everyone", async () => {
		const handler = toRequestHandler(echoClaw(), { openApi: true });
		const spec = await handler(new Request(`${base}/openapi.json`));
		expect(spec.status).toBe(200);
		expect(spec.headers.get("cache-control")).toMatch(/max-age/);
	});
});

describe("M-17 — two patterns must not match one URL", () => {
	const patternPlugin = (id: string, path: string) =>
		({
			id,
			routes: [
				{
					method: "POST" as const,
					path,
					handler: () => ({ body: { ok: true, from: id } }),
				},
			],
		}) as never;

	it("refuses patterns that overlap on a different shape", () => {
		// `/c/app/hook` matches both. Neither is a prefix of the other and their normalized shapes
		// differ, so shape-comparison alone saw no conflict — and which handler ran came down to
		// which plugin loaded first, which is not a way to decide who may call what.
		expect(() =>
			toRequestHandler(echoClaw(), {
				plugins: [
					patternPlugin("a", "/c/:provider/hook"),
					patternPlugin("b", "/c/app/:key"),
				],
			}),
		).toThrow(/ambiguous route patterns/);
	});

	it("allows patterns that cannot both match", () => {
		expect(() =>
			toRequestHandler(echoClaw(), {
				plugins: [
					patternPlugin("a", "/c/:provider/hook"),
					patternPlugin("b", "/c/:provider/poll"),
					patternPlugin("c", "/d/:one/:two/:three"),
				],
			}),
		).not.toThrow();
	});

	it("still allows a literal beside a pattern — the literal wins by rule, not by order", () => {
		// Static paths are matched from a map BEFORE patterns are tried, so this pair is defined
		// rather than ambiguous, and refusing it would break every real mount.
		expect(() =>
			toRequestHandler(echoClaw(), {
				plugins: [
					patternPlugin("a", "/c/:provider/hook"),
					patternPlugin("b", "/c/app/hook"),
				],
			}),
		).not.toThrow();
	});
});

// R-M14. Every envelope field used to be optional, so ANY JSON object validated as one. A 2xx
// carrying somebody else's JSON — a proxy's health blob, a rewritten route's index page, a gateway
// that swallowed the call and answered 200 — reported `ok` as undefined and resolved as a data-less
// SUCCESS. Callers rendered "no results" for a request that never reached the server.
//
// This client THROWS on failure (the browser client returns `{ data, error }`; both now apply the
// same rule).
describe("R-M14 — a body that is not an envelope is not an answer", () => {
	const clientFor = (body: string, status = 200) =>
		createClawClient({
			baseUrl: base,
			fetch: async () =>
				new Response(body, {
					status,
					headers: { "content-type": "application/json" },
				}),
		});

	it("refuses a 200 whose body is not an envelope", async () => {
		await expect(
			clientFor(JSON.stringify({ healthy: true })).getClaw({ id: "c1" }),
		).rejects.toThrow(/not a valid envelope/);
	});

	it("refuses a 200 carrying an HTML error page", async () => {
		await expect(
			clientFor("<!doctype html><h1>502</h1>").getClaw({ id: "c1" }),
		).rejects.toThrow(/not a valid envelope/);
	});

	it("still reads a well-formed success", async () => {
		await expect(
			clientFor(JSON.stringify({ ok: true, data: { id: "c1" } })).getClaw({
				id: "c1",
			}),
		).resolves.toMatchObject({ id: "c1" });
	});

	// A well-formed success envelope under a non-2xx is still a failure: the status is the transport's
	// answer and it outranks the body's claim about itself.
	it("refuses a success envelope served under an error status", async () => {
		await expect(
			clientFor(JSON.stringify({ ok: true, data: { id: "c1" } }), 500).getClaw({
				id: "c1",
			}),
		).rejects.toThrow(/status 500/);
	});
});

// R-M12. Request ingress was bounded and egress was not — the asymmetry that matters, because the
// response body is assembled from whatever a list returned and several lists had no ceiling. One
// request's cost was set by how much data the caller already had, not by anything they sent.
describe("R-M12 — the response has a ceiling too", () => {
	it("refuses to send a body past the cap, as a limit rather than a fault", async () => {
		// A claw whose api hands back more than the door will write.
		const huge = {
			api: {
				getClaw: async () => ({ id: "c1", blob: "x".repeat(9 * 1024 * 1024) }),
			},
		} as unknown as Claw;

		const response = await toRequestHandler(huge)(
			new Request(`${base}/get-claw?id=c1`),
		);
		// 413, not 500: the same value will be refused again however well-formed it is, and the caller
		// can act on that by asking for less.
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "BUSYCLAW_LIMIT_EXCEEDED" },
			ok: false,
		});
	});

	it("leaves an ordinary response alone", async () => {
		const response = await toRequestHandler(echoClaw())(
			new Request(`${base}/get-claw?id=c1`),
		);
		expect(response.status).toBe(200);
	});
});
