import type { JsonObject } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	normalizeOrigin,
	planHttpRequest,
} from "../src/tools/invoke/request-plan";
import type { OpenApiBinding } from "../src/tools/sources/openapi";

function binding(overrides: Partial<OpenApiBinding>): OpenApiBinding {
	return {
		method: "get",
		path: "/",
		server: "https://api.example",
		parameters: [],
		...overrides,
	};
}

describe("planHttpRequest — routing", () => {
	it("substitutes and percent-encodes path parameters", () => {
		const plan = planHttpRequest(
			binding({
				method: "get",
				path: "/pets/{petId}",
				server: "https://api.example/v1",
				parameters: [{ name: "petId", in: "path", required: true }],
			}),
			{ petId: 7 },
		);
		expect(plan.method).toBe("GET");
		expect(plan.origin).toBe("https://api.example");
		expect(plan.url).toBe("https://api.example/v1/pets/7");
	});

	it("percent-encodes a path value so slashes stay inside the segment", () => {
		const plan = planHttpRequest(
			binding({
				path: "/files/{name}",
				parameters: [{ name: "name", in: "path", required: true }],
			}),
			{ name: "a b/c" },
		);
		expect(plan.url).toBe("https://api.example/files/a%20b%2Fc");
	});

	it("serializes query arrays: form+explode (default), form, spaceDelimited, pipeDelimited", () => {
		const explode = planHttpRequest(
			binding({
				path: "/search",
				parameters: [{ name: "tags", in: "query", required: false }],
			}),
			{ tags: ["a", "b"] },
		);
		expect(explode.url).toBe("https://api.example/search?tags=a&tags=b");

		const form = planHttpRequest(
			binding({
				path: "/search",
				parameters: [
					{
						name: "tags",
						in: "query",
						required: false,
						style: "form",
						explode: false,
					},
				],
			}),
			{ tags: ["a", "b"] },
		);
		expect(form.url).toBe("https://api.example/search?tags=a,b");

		const spaced = planHttpRequest(
			binding({
				path: "/search",
				parameters: [
					{
						name: "tags",
						in: "query",
						required: false,
						style: "spaceDelimited",
						explode: false,
					},
				],
			}),
			{ tags: ["a", "b"] },
		);
		expect(spaced.url).toBe("https://api.example/search?tags=a%20b");

		const piped = planHttpRequest(
			binding({
				path: "/search",
				parameters: [
					{
						name: "tags",
						in: "query",
						required: false,
						style: "pipeDelimited",
						explode: false,
					},
				],
			}),
			{ tags: ["a", "b"] },
		);
		expect(piped.url).toBe("https://api.example/search?tags=a|b");
	});

	it("routes header parameters to headers, not the URL", () => {
		const plan = planHttpRequest(
			binding({
				path: "/x",
				parameters: [{ name: "X-Trace", in: "header", required: false }],
			}),
			{ "X-Trace": "abc" },
		);
		expect(plan.headers["X-Trace"]).toBe("abc");
		expect(plan.url).toBe("https://api.example/x");
	});

	it("flattens non-parameter args into a JSON body with a default Content-Type", () => {
		const plan = planHttpRequest(
			binding({ method: "post", path: "/pets", parameters: [] }),
			{ name: "Rex", age: 3 },
		);
		expect(plan.body).toBe(JSON.stringify({ name: "Rex", age: 3 }));
		expect(plan.headers["content-type"]).toBe("application/json");
	});

	it("bodyWrapped: the single `body` arg IS the body", () => {
		const plan = planHttpRequest(
			binding({
				method: "post",
				path: "/bulk",
				parameters: [],
				bodyWrapped: true,
				bodyContentType: "application/json",
			}),
			{ body: [1, 2, 3] },
		);
		expect(plan.body).toBe("[1,2,3]");
		expect(plan.headers["content-type"]).toBe("application/json");
	});

	it("throws when the binding has no server (uninvokable)", () => {
		expect(() =>
			planHttpRequest(
				{ method: "get", path: "/x", parameters: [] } as OpenApiBinding,
				{},
			),
		).toThrow(/server/);
	});
});

describe("planHttpRequest — the model cannot alter the origin (encoding proof)", () => {
	it("a path value with ../ ? and :// stays in the path; the origin is unchanged", () => {
		const plan = planHttpRequest(
			binding({
				path: "/files/{name}",
				server: "https://api.example",
				parameters: [{ name: "name", in: "path", required: true }],
			}),
			{ name: "../../etc/passwd?x=1://evil.com" },
		);
		expect(plan.origin).toBe("https://api.example");
		expect(plan.url).toBe(
			"https://api.example/files/..%2F..%2Fetc%2Fpasswd%3Fx%3D1%3A%2F%2Fevil.com",
		);
		expect(plan.url).not.toContain("evil.com/");
		// Nothing after the encoded value — no injected query, no host swap.
		expect(plan.url.indexOf("?")).toBe(-1);
	});

	it("a query value with & and = cannot inject extra parameters", () => {
		const plan = planHttpRequest(
			binding({
				path: "/search",
				parameters: [{ name: "q", in: "query", required: false }],
			}),
			{ q: "a&admin=true=c" } as JsonObject,
		);
		expect(plan.url).toBe("https://api.example/search?q=a%26admin%3Dtrue%3Dc");
	});
});

describe("normalizeOrigin", () => {
	it("drops default ports and lowercases the host", () => {
		expect(normalizeOrigin("https://API.Example.com:443/v1")).toBe(
			"https://api.example.com",
		);
		expect(normalizeOrigin("https://api.example.com:8443/v1")).toBe(
			"https://api.example.com:8443",
		);
	});

	it("throws on an absent or unparseable server", () => {
		expect(() => normalizeOrigin(undefined)).toThrow(/server/);
		expect(() => normalizeOrigin("not a url")).toThrow(/server/);
	});
});

// R-H06: a path argument must not resolve to a route other than the registered one.
//
// Percent-encoding stops a value BREAKING OUT of its segment — `/`, `?`, `#`, `:` all encode — and
// that was taken to mean nothing could escape. `encodeURIComponent` leaves `.` untouched, so `..`
// survives intact and is a RELATIVE segment: `/v1/files/..` canonicalizes to `/v1/`. The model
// reaches a sibling route on the same origin while keeping everything decided for the original
// operation — the policy verdict, the method, and the credential attached to it. The egress floor
// sees nothing wrong, because the origin never changed.

describe("planHttpRequest — dot segments", () => {
	const files = () =>
		binding({
			method: "get",
			path: "/v1/files/{name}",
			server: "https://api.test",
			parameters: [{ name: "name", in: "path", required: true }],
		});

	it("plans an ordinary path argument unchanged", () => {
		expect(planHttpRequest(files(), { name: "report.txt" }).url).toBe(
			"https://api.test/v1/files/report.txt",
		);
	});

	it("refuses `..`, which would reach the parent route", () => {
		expect(() => planHttpRequest(files(), { name: ".." })).toThrow(
			/relative path segment/,
		);
	});

	it("refuses `.`, which resolves the segment away", () => {
		expect(() => planHttpRequest(files(), { name: "." })).toThrow(
			/relative path segment/,
		);
	});

	it("still encodes a separator rather than refusing it", () => {
		// `a/b` is not an escape — it encodes to `a%2Fb` and stays in its segment. Refusing it would
		// break legitimate arguments; the rule is about segments that CANONICALIZE away, not about
		// characters that look dangerous.
		expect(planHttpRequest(files(), { name: "a/b" }).url).toBe(
			"https://api.test/v1/files/a%2Fb",
		);
	});

	it("refuses any request whose URL does not canonicalize to the registered path", () => {
		// The structural backstop, independent of the character check: if normalizing the URL changes
		// the path we built, something in it was not the literal path we meant to request. This is
		// what covers whatever a future encoding rule lets through.
		const dotted = binding({
			method: "get",
			path: "/v1/../admin/{name}",
			server: "https://api.test",
			parameters: [{ name: "name", in: "path", required: true }],
		});
		expect(() => planHttpRequest(dotted, { name: "x" })).toThrow(
			/do not resolve to the registered route/,
		);
	});
});
