// The governed guest fetch. The guest has no sockets of its own, so `fetchAdapter` is the single
// door out of the sandbox — and the provider opens that door on the adapter's PRESENCE, never
// inspecting what it does. These assert that the shipped adapter is the floor: a bare `fetch`
// passthrough in this slot would pass every one of these targets straight through.

import type { EgressLookup } from "@euroclaw/egress";
import { describe, expect, it } from "vitest";
import { governedFetch } from "../src/fetch";

const publicLookup: EgressLookup = async () => [
	{ address: "93.184.216.34", family: 4 },
];

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: () => Response): {
	fn: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		fn: (async (url: string, init: RequestInit) => {
			calls.push({ url: String(url), init });
			return handler();
		}) as unknown as typeof fetch,
	};
}

describe("governedFetch", () => {
	it("returns the response as plain data the guest can read", async () => {
		const { fn, calls } = fakeFetch(
			() =>
				new Response("hello", {
					status: 201,
					headers: { "content-type": "text/plain" },
				}),
		);
		const doFetch = governedFetch({ fetch: fn, lookup: publicLookup });

		const result = (await doFetch("https://api.example/thing")) as {
			status: number;
			headers: Record<string, string>;
			body: string;
		};

		expect(calls[0]?.url).toBe("https://api.example/thing");
		expect(result.status).toBe(201);
		expect(result.body).toBe("hello");
		expect(result.headers["content-type"]).toBe("text/plain");
	});

	// The whole point: the floor runs host-side, before a socket exists.
	it("blocks a private target (the floor applies)", async () => {
		const { fn, calls } = fakeFetch(() => new Response("{}"));
		const doFetch = governedFetch({ fetch: fn });

		await expect(doFetch("https://10.0.0.1/admin")).rejects.toThrow(
			/disallowed address/,
		);
		// Never dialled — the guard is before the request, not after it.
		expect(calls).toHaveLength(0);
	});

	it("blocks the cloud metadata endpoint", async () => {
		const { fn, calls } = fakeFetch(() => new Response("{}"));
		const doFetch = governedFetch({ fetch: fn });

		await expect(
			doFetch("https://169.254.169.254/latest/meta-data/"),
		).rejects.toThrow(/disallowed address/);
		expect(calls).toHaveLength(0);
	});

	it("blocks a name that RESOLVES to a private address", async () => {
		const { fn, calls } = fakeFetch(() => new Response("{}"));
		const internalLookup: EgressLookup = async () => [
			{ address: "127.0.0.1", family: 4 },
		];
		const doFetch = governedFetch({ fetch: fn, lookup: internalLookup });

		await expect(doFetch("https://looks-public.example/")).rejects.toThrow(
			/disallowed address/,
		);
		expect(calls).toHaveLength(0);
	});

	it("pins the connection and never follows redirects", async () => {
		const { fn, calls } = fakeFetch(() => new Response("ok"));
		const doFetch = governedFetch({ fetch: fn, lookup: publicLookup });
		await doFetch("https://api.example/thing");

		// The vetted address is carried into the connection, closing the re-resolution window.
		expect(
			(calls[0]?.init as { dispatcher?: unknown } | undefined)?.dispatcher,
		).toBeDefined();
		// A 3xx to a private host would otherwise walk around the floor entirely.
		expect(calls[0]?.init.redirect).toBe("manual");
	});

	it("caps an oversized response body", async () => {
		const { fn } = fakeFetch(() => new Response("x".repeat(50_000)));
		const doFetch = governedFetch({
			fetch: fn,
			lookup: publicLookup,
			maxResponseBytes: 1024,
		});

		await expect(doFetch("https://api.example/big")).rejects.toThrow(
			/byte cap/,
		);
	});

	it("is https-only unless the host explicitly allows http", async () => {
		const { fn } = fakeFetch(() => new Response("ok"));
		await expect(
			governedFetch({ fetch: fn, lookup: publicLookup })("http://api.example/"),
		).rejects.toThrow();

		const allowed = governedFetch({
			fetch: fn,
			lookup: publicLookup,
			allowInsecure: true,
		});
		await expect(allowed("http://api.example/")).resolves.toBeDefined();
	});
});
