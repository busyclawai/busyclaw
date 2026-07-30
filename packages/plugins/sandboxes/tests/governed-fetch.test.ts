// The governed guest fetch. The guest has no sockets of its own, so `fetchAdapter` is the single
// door out of the sandbox — and the provider opens that door on the adapter's PRESENCE, never
// inspecting what it does. These assert that the shipped adapter is the floor: a bare `fetch`
// passthrough in this slot would pass every one of these targets straight through.

import type { EgressLookup } from "@busyclaw/egress";
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

// Every origin this file's cases aim at. `allow` is required now, so each case has to say where it
// is going — these tests are about the FLOOR (SSRF ranges, pinning, caps), and declaring their
// targets is what keeps them testing that rather than the destination check in front of it. The
// destination check has its own cases at the bottom.
const DECLARED = {
	allow: [
		"https://api.example",
		"http://api.example",
		"https://10.0.0.1",
		"https://169.254.169.254",
		"https://looks-public.example",
	],
};

describe("governedFetch", () => {
	it("returns the response as plain data the guest can read", async () => {
		const { fn, calls } = fakeFetch(
			() =>
				new Response("hello", {
					status: 201,
					headers: { "content-type": "text/plain" },
				}),
		);
		const doFetch = governedFetch({
			...DECLARED,
			fetch: fn,
			lookup: publicLookup,
		});

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
		const doFetch = governedFetch({ ...DECLARED, fetch: fn });

		await expect(doFetch("https://10.0.0.1/admin")).rejects.toThrow(
			/disallowed address/,
		);
		// Never dialled — the guard is before the request, not after it.
		expect(calls).toHaveLength(0);
	});

	it("blocks the cloud metadata endpoint", async () => {
		const { fn, calls } = fakeFetch(() => new Response("{}"));
		const doFetch = governedFetch({ ...DECLARED, fetch: fn });

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
		const doFetch = governedFetch({
			...DECLARED,
			fetch: fn,
			lookup: internalLookup,
		});

		await expect(doFetch("https://looks-public.example/")).rejects.toThrow(
			/disallowed address/,
		);
		expect(calls).toHaveLength(0);
	});

	it("pins the connection and never follows redirects", async () => {
		const { fn, calls } = fakeFetch(() => new Response("ok"));
		const doFetch = governedFetch({
			...DECLARED,
			fetch: fn,
			lookup: publicLookup,
		});
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
			...DECLARED,
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
			governedFetch({ ...DECLARED, fetch: fn, lookup: publicLookup })(
				"http://api.example/",
			),
		).rejects.toThrow();

		const allowed = governedFetch({
			...DECLARED,
			fetch: fn,
			lookup: publicLookup,
			allowInsecure: true,
		});
		await expect(allowed("http://api.example/")).resolves.toBeDefined();
	});
});

// The destination policy in front of the floor. The floor is SSRF containment — it has no opinion
// about which PUBLIC hosts a workload has business with — so before this, "network on" meant every
// host that would answer, which for model-authored code is the shortest exfiltration path there is:
// read something, POST it somewhere.
describe("governedFetch — declared destinations", () => {
	it("refuses an origin nobody declared, and never resolves it", async () => {
		let resolved = 0;
		const { fn, calls } = fakeFetch(() => new Response("ok"));
		const doFetch = governedFetch({
			allow: ["https://api.example"],
			fetch: fn,
			lookup: async () => {
				resolved++;
				return [{ address: "93.184.216.34", family: 4 }];
			},
		});
		await expect(doFetch("https://evil.example/collect")).rejects.toThrow(
			/not a declared destination/,
		);
		expect(calls).toHaveLength(0);
		// A DNS query for an attacker-chosen name is itself a signal leaving the host, so the
		// destination check runs BEFORE the floor rather than beside it.
		expect(resolved).toBe(0);
	});

	it("an empty allow list is no egress at all", async () => {
		const { fn } = fakeFetch(() => new Response("ok"));
		const doFetch = governedFetch({
			allow: [],
			fetch: fn,
			lookup: publicLookup,
		});
		await expect(doFetch("https://api.example/thing")).rejects.toThrow(
			/not a declared destination/,
		);
	});

	it("matches on ORIGIN, so a path or a default port does not change the answer", async () => {
		const { fn } = fakeFetch(() => new Response("ok"));
		const doFetch = governedFetch({
			allow: ["https://api.example"],
			fetch: fn,
			lookup: publicLookup,
		});
		await expect(doFetch("https://api.example/a/b?c=d")).resolves.toBeDefined();
		// Same destination written differently — a check that disagreed here would refuse traffic the
		// host meant to permit.
		await expect(doFetch("https://API.example:443/x")).resolves.toBeDefined();
	});

	it("a declared origin does NOT carry its siblings", async () => {
		const { fn } = fakeFetch(() => new Response("ok"));
		const doFetch = governedFetch({
			allow: ["https://api.example"],
			fetch: fn,
			lookup: publicLookup,
		});
		// No wildcards: a subdomain is a different host, and on a multi-tenant family it is somebody
		// else's data.
		await expect(doFetch("https://evil.api.example/")).rejects.toThrow(
			/not a declared destination/,
		);
		// Scheme is part of the origin too.
		await expect(doFetch("http://api.example/")).rejects.toThrow(
			/not a declared destination/,
		);
	});
});
