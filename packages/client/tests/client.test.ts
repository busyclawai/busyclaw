// The vanilla client over an injected fetch stub — no server, no msw: the stub IS the transport
// seam the client is built around. Covers the table-driven base calls, the `?input=` GET
// convention, the convention proxy (incl. nesting + the thenable guard), pathMethods overrides,
// the `{ data, error }` contract, signal-toggle refetches, and the fail-loud construction checks.

import type { ApprovalRecord } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import type {
	ClawClientFetch,
	ClawFetchLike,
	ClawQueryState,
	ClawResult,
} from "../src/index";
import { createClawClient, createQueryAtom } from "../src/index";
import { approvalsClient } from "../src/plugins/index";

function envelopeResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "content-type": "application/json" },
	});
}

type RecordedCall = { url: string; init: RequestInit | undefined };

function recordingFetch(
	respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: RecordedCall[]; fetch: ClawFetchLike } {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			calls.push({ init, url: String(input) });
			return respond(String(input), init);
		},
	};
}

async function until(check: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("condition not reached in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function decodedInput(url: string): unknown {
	const parsed = new URL(url, "http://euroclaw.local");
	const encoded = parsed.searchParams.get("input");
	if (encoded === null) throw new Error(`no ?input= on ${url}`);
	return JSON.parse(encoded);
}

describe("base api calls (table-driven off CLAW_API_METHOD_NAMES)", () => {
	it("routes a mutation as POST /<kebab(name)> with a JSON body and parses { data }", async () => {
		const { calls, fetch } = recordingFetch(() =>
			envelopeResponse({ data: { id: "claw-1" }, ok: true }),
		);
		const client = createClawClient({ fetch });

		const result = await client.createClaw({ createdBy: "user:alice" });

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe("/api/euroclaw/create-claw");
		expect(call?.init?.method).toBe("POST");
		expect(new Headers(call?.init?.headers).get("content-type")).toBe(
			"application/json",
		);
		expect(JSON.parse(String(call?.init?.body))).toEqual({
			createdBy: "user:alice",
		});
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ id: "claw-1" });
	});

	it("routes a get*/list* read as GET with the ?input= JSON convention", async () => {
		const { calls, fetch } = recordingFetch(() =>
			envelopeResponse({ data: [], ok: true }),
		);
		const client = createClawClient({
			baseUrl: "https://app.test/api/euroclaw",
			fetch,
		});

		await client.listMessages({ afterSequence: 2, limit: 5, threadId: "t-1" });

		const call = calls[0];
		expect(call?.init?.method).toBe("GET");
		expect(call?.init?.body).toBeUndefined();
		expect(call?.url).toContain("https://app.test/api/euroclaw/list-messages?");
		expect(decodedInput(call?.url ?? "")).toEqual({
			afterSequence: 2,
			limit: 5,
			threadId: "t-1",
		});
	});

	it("resolves headers per call, including an async producer", async () => {
		let token = "tok-1";
		const { calls, fetch } = recordingFetch(() =>
			envelopeResponse({ data: null, ok: true }),
		);
		const client = createClawClient({
			fetch,
			headers: async () => ({ authorization: `Bearer ${token}` }),
		});

		await client.getClaw({ id: "c-1" });
		token = "tok-2";
		await client.getClaw({ id: "c-1" });

		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
			"Bearer tok-1",
		);
		expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe(
			"Bearer tok-2",
		);
	});
});

describe("the { data, error } contract — never throws", () => {
	it("surfaces an envelope failure with status, message, and code", async () => {
		const { fetch } = recordingFetch(() =>
			envelopeResponse(
				{
					error: { code: "EUROCLAW_STATE_INVALID", message: "claw not found" },
					ok: false,
				},
				{ status: 500 },
			),
		);
		const client = createClawClient({ fetch });

		const result = await client.getClaw({ id: "nope" });

		expect(result.data).toBeNull();
		expect(result.error).toEqual({
			code: "EUROCLAW_STATE_INVALID",
			message: "claw not found",
			status: 500,
		});
	});

	it("honours ok:false even on an HTTP 200", async () => {
		const { fetch } = recordingFetch(() =>
			envelopeResponse({ error: { message: "soft failure" }, ok: false }),
		);
		const client = createClawClient({ fetch });

		const result = await client.getClaw({ id: "c-1" });

		expect(result.error).toEqual({ message: "soft failure", status: 200 });
	});

	it("falls back to a status-driven message for a non-envelope body", async () => {
		const { fetch } = recordingFetch(
			() => new Response("<html>bad gateway</html>", { status: 502 }),
		);
		const client = createClawClient({ fetch });

		const result = await client.getClaw({ id: "c-1" });

		expect(result.error).toEqual({
			message: "euroclaw request failed with status 502",
			status: 502,
		});
	});

	it("wraps a transport-level throw as status 0 instead of throwing", async () => {
		const client = createClawClient({
			fetch: () => {
				throw new Error("network down");
			},
		});

		const result = await client.getClaw({ id: "c-1" });

		expect(result.data).toBeNull();
		expect(result.error).toEqual({ message: "network down", status: 0 });
	});
});

// A phantom claw shape exercising the proxy conventions AND the InferClientApi mapping over
// nested namespaces — types only, nothing server-side exists here.
type ProxyClaw = {
	api: {
		secrets: {
			set: (input: {
				name: string;
				value: string;
			}) => Promise<{ name: string }>;
			search: (input: { query: string }) => Promise<string[]>;
		};
		skills: {
			packages: {
				create: (input: { name: string }) => Promise<{ id: string }>;
			};
		};
		channels: {
			registrations: {
				getByKey: (input: { key: string }) => Promise<{ key: string }>;
			};
		};
	};
};

describe("plugin namespaces (the recursive function proxy)", () => {
	it("routes camelCase methods to /<ns>/<kebab(method)> with the name→verb rule", async () => {
		const { calls, fetch } = recordingFetch(() =>
			envelopeResponse({ data: { ok: true }, ok: true }),
		);
		const client = createClawClient<ProxyClaw>({ fetch });

		await client.secrets.set({ name: "NOTION", value: "tok" });
		await client.channels.registrations.getByKey({ key: "main" });

		expect(calls[0]?.url).toBe("/api/euroclaw/secrets/set");
		expect(calls[0]?.init?.method).toBe("POST");
		// getByKey reads: GET by the shared get*/list* rule on the LAST camel segment.
		expect(calls[1]?.init?.method).toBe("GET");
		expect(calls[1]?.url).toContain(
			"/api/euroclaw/channels/registrations/get-by-key?",
		);
		expect(decodedInput(calls[1]?.url ?? "")).toEqual({ key: "main" });
	});

	it("deepens the path through nested groups", async () => {
		const { calls, fetch } = recordingFetch(() =>
			envelopeResponse({ data: { id: "pkg-1" }, ok: true }),
		);
		const client = createClawClient<ProxyClaw>({ fetch });

		const result = await client.skills.packages.create({ name: "notion" });

		expect(calls[0]?.url).toBe("/api/euroclaw/skills/packages/create");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(result.data).toEqual({ id: "pkg-1" });
	});

	it("returns undefined for then/catch/finally so awaiting a namespace cannot hang", async () => {
		const { fetch } = recordingFetch(() =>
			envelopeResponse({ data: null, ok: true }),
		);
		const client = createClawClient<ProxyClaw>({ fetch });

		const namespace = client.secrets as unknown as Record<string, unknown>;
		expect(namespace.then).toBeUndefined();
		expect(namespace.catch).toBeUndefined();
		expect(namespace.finally).toBeUndefined();
		// `await` on a non-thenable resolves to the value itself — the guard is what makes that true.
		const awaited = await (client.secrets as unknown as Promise<unknown>);
		expect(typeof awaited).toBe("function");
	});

	it("returns every KNOWN value verbatim — $store is the concrete registry, not a node", () => {
		const client = createClawClient({ plugins: [approvalsClient()] });

		// Identity-stable and enumerable: framework bindings iterate $store.atoms to build hooks.
		expect(client.$store).toBe(client.$store);
		expect(Object.keys(client.$store.atoms).sort()).toEqual([
			"$pendingApprovalsSignal",
			"pendingApprovals",
		]);
	});

	it("lets a plugin pathMethods entry override the derived verb", async () => {
		const { calls, fetch } = recordingFetch(() =>
			envelopeResponse({ data: [], ok: true }),
		);
		const client = createClawClient<ProxyClaw>({
			fetch,
			plugins: [
				{ id: "secrets-verbs", pathMethods: { "/secrets/search": "GET" } },
			],
		});

		await client.secrets.search({ query: "tok" });

		// "search" would derive POST; the override declares the read.
		expect(calls[0]?.init?.method).toBe("GET");
		expect(decodedInput(calls[0]?.url ?? "")).toEqual({ query: "tok" });
	});
});

describe("reactivity — signal toggles and query atoms", () => {
	function approvalsFetch() {
		let pending: unknown[] = [{ id: "appr-1", status: "pending" }];
		const recorded = recordingFetch((url) => {
			if (url.includes("/list-approvals")) {
				return envelopeResponse({ data: pending, ok: true });
			}
			if (url.includes("/grant-approval")) {
				pending = [];
				return envelopeResponse({
					data: { id: "appr-1", status: "granted" },
					ok: true,
				});
			}
			return envelopeResponse({ data: { id: "other" }, ok: true });
		});
		const listCalls = () =>
			recorded.calls.filter((call) => call.url.includes("/list-approvals"))
				.length;
		return { ...recorded, listCalls };
	}

	it("refetches the pendingApprovals atom after a matching mutation succeeds", async () => {
		const { fetch, listCalls } = approvalsFetch();
		const client = createClawClient({ fetch, plugins: [approvalsClient()] });

		const states: ClawQueryState<ApprovalRecord[]>[] = [];
		const unbind = client.pendingApprovals.subscribe((state) => {
			states.push(state);
		});
		// Lazy onMount: the first subscriber triggers the initial fetch.
		await until(() => listCalls() === 1 && states.at(-1)?.data !== null);
		expect(states.at(-1)?.data).toEqual([{ id: "appr-1", status: "pending" }]);

		const granted = await client.grantApproval({
			approvalId: "appr-1",
			by: "user:reviewer",
		});
		expect(granted.error).toBeNull();

		// The matching listener toggles the signal (10ms deferred) → the query refetches.
		await until(() => listCalls() === 2);
		await until(() => states.at(-1)?.data?.length === 0);
		unbind();
	});

	it("does not refetch on non-matching calls or on reads", async () => {
		const { fetch, listCalls } = approvalsFetch();
		const client = createClawClient({ fetch, plugins: [approvalsClient()] });

		const unbind = client.pendingApprovals.subscribe(() => {});
		await until(() => listCalls() === 1);

		await client.createThread({ clawId: "c-1" });
		await client.listThreads({ clawId: "c-1" });
		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(listCalls()).toBe(1);
		unbind();
	});

	it("keeps stale data on non-401 errors and clears it on 401", async () => {
		const results: ClawResult<string[]>[] = [
			{ data: ["first"], error: null },
			{ data: null, error: { message: "boom", status: 500 } },
			{ data: null, error: { message: "session gone", status: 401 } },
		];
		let call = 0;
		const $fetch = (async () => {
			const next = results[Math.min(call, results.length - 1)] ?? {
				data: null,
				error: { message: "script exhausted", status: 500 },
			};
			call += 1;
			return next;
		}) as ClawClientFetch;
		const query = createQueryAtom<string[]>({ $fetch, path: "/list-things" });

		const unbind = query.subscribe(() => {});
		await until(() => query.get().data !== null);
		expect(query.get().data).toEqual(["first"]);

		await query.get().refetch();
		expect(query.get().data).toEqual(["first"]); // stale data survives the 500
		expect(query.get().error?.status).toBe(500);

		await query.get().refetch();
		expect(query.get().data).toBeNull(); // a 401 clears — the session is gone
		expect(query.get().error?.status).toBe(401);
		unbind();
	});

	it("discards an aborted in-flight fetch instead of clobbering the newer result", async () => {
		let resolveFirst: ((result: ClawResult<string[]>) => void) | undefined;
		let call = 0;
		const $fetch = ((_path: string, options?: { signal?: AbortSignal }) => {
			call += 1;
			if (call === 1) {
				const signal = options?.signal;
				return new Promise<ClawResult<string[]>>((resolve) => {
					resolveFirst = (result) =>
						resolve(
							signal?.aborted
								? { data: null, error: { message: "aborted", status: 0 } }
								: result,
						);
				});
			}
			return Promise.resolve({ data: ["second"], error: null });
		}) as ClawClientFetch;
		const query = createQueryAtom<string[]>({ $fetch, path: "/list-things" });

		const unbind = query.subscribe(() => {});
		await until(() => call === 1);
		const second = query.get().refetch(); // aborts the in-flight first fetch
		await second;
		expect(query.get().data).toEqual(["second"]);

		resolveFirst?.({ data: ["first"], error: null });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(query.get().data).toEqual(["second"]); // the aborted fetch wrote nothing
		unbind();
	});
});

describe("fail-loud construction (deviations from better-auth's silent merges)", () => {
	it("rejects an atomListener referencing a signal no plugin contributed", () => {
		expect(() =>
			createClawClient({
				plugins: [
					{
						atomListeners: [{ matcher: () => true, signal: "$missing" }],
						id: "broken",
					},
				],
			}),
		).toThrow(/signal/);
	});

	it("rejects getActions key collisions across plugins", () => {
		expect(() =>
			createClawClient({
				plugins: [
					{ getActions: () => ({ report: () => "a" }), id: "a" },
					{ getActions: () => ({ report: () => "b" }), id: "b" },
				],
			}),
		).toThrow(/duplicate euroclaw client key/);
	});

	it("rejects an action shadowing a base api method or a reserved key", () => {
		expect(() =>
			createClawClient({
				plugins: [{ getActions: () => ({ getClaw: () => null }), id: "a" }],
			}),
		).toThrow(/duplicate euroclaw client key/);
		expect(() =>
			createClawClient({
				plugins: [{ getActions: () => ({ $fetch: () => null }), id: "a" }],
			}),
		).toThrow(/duplicate euroclaw client key/);
	});

	it("rejects duplicate pathMethods entries across plugins", () => {
		expect(() =>
			createClawClient({
				plugins: [
					{ id: "a", pathMethods: { "/x/search": "GET" } },
					{ id: "b", pathMethods: { "/x/search": "POST" } },
				],
			}),
		).toThrow(/duplicate euroclaw client pathMethods/);
	});

	it("fails loud on $store.notify with an unknown signal", () => {
		const client = createClawClient({});
		expect(() => client.$store.notify("$missing")).toThrow(/signal/);
	});
});
