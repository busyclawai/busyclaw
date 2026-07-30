// Claim-check: the credential is resolved and placed at egress, per call, and the caller never holds
// it. Slice 3b of docs/plans/sandbox-egress-credential-model.md.
//
// The property under test is negative and therefore easy to fake: "the guest never sees the secret"
// passes trivially if nothing is injected at all. So every case here checks BOTH halves — what
// reached the wire, and what the caller was able to influence.

import type { SecretMaterial, Secrets } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { fetchTool } from "../src/fetch-tool";

const ORIGIN = "https://93.184.216.34";
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

/** A one-door reader over a fixed map. `require` throws for an unknown name, like the real one. */
function secretsOf(map: Record<string, SecretMaterial>): Secrets {
	const reader = {
		get: async (name: string) => map[name] ?? null,
		has: async (name: string) => map[name] !== undefined,
		require: async (name: string) => {
			const found = map[name];
			if (!found) throw new Error(`no secret named ${name}`);
			return found;
		},
		with: () => reader,
	};
	return reader as unknown as Secrets;
}

/** Run one call through the tool and report what the transport actually saw. */
async function call(
	options: Parameters<typeof fetchTool>[0],
	args: Record<string, unknown>,
) {
	let seen: { url: string; headers: Record<string, string> } | undefined;
	const tool = fetchTool({
		...options,
		lookup,
		transport: async (input, init) => {
			const headers = (init as RequestInit | undefined)?.headers;
			seen = {
				url: String(input),
				headers: (headers ?? {}) as Record<string, string>,
			};
			return new Response("ok");
		},
	});
	const execute = tool.invocation.execute as (
		a: unknown,
		o: unknown,
	) => Promise<unknown>;
	await execute(args, {});
	return seen;
}

describe("claim-check credential injection", () => {
	const bearer = {
		allow: [ORIGIN],
		credentials: {
			bindings: [
				{
					origin: ORIGIN,
					secret: "petstore",
					placement: { kind: "bearer" as const },
				},
			],
			secrets: secretsOf({ petstore: { kind: "token", value: "s3cret" } }),
		},
	};

	it("places the credential at egress — the caller never supplied it", async () => {
		const seen = await call(bearer, { url: `${ORIGIN}/pets` });
		expect(seen?.headers.authorization).toBe("Bearer s3cret");
	});

	// The end state, for the spelling where PLACEMENT alone would have got there: writing
	// `authorization` overwrites a caller's `authorization`. Kept because it is the outcome that
	// matters, and marked because it does NOT prove the strip — it passes with the strip disabled.
	// The next test is the one that proves it.
	it("a caller-supplied credential in the managed slot does not survive", async () => {
		const seen = await call(bearer, {
			url: `${ORIGIN}/pets`,
			headers: { authorization: "Bearer attacker-token" },
		});
		expect(seen?.headers.authorization).toBe("Bearer s3cret");
	});

	// THE integrity property, and the only case that actually exercises the strip. Header names are
	// case-insensitive on the wire, so a guest writes `Authorization`, placement writes
	// `authorization`, and BOTH go out — at the destination a smuggled credential in the managed
	// header is indistinguishable from one the deployment authorized. Verified by mutation: disabling
	// the strip kills this test and nothing else.
	it("strips the managed slot whatever its CASE", async () => {
		const seen = await call(bearer, {
			url: `${ORIGIN}/pets`,
			headers: { Authorization: "Bearer attacker-token" },
		});
		const values = Object.entries(seen?.headers ?? {})
			.filter(([name]) => name.toLowerCase() === "authorization")
			.map(([, value]) => value);
		expect(values).toEqual(["Bearer s3cret"]);
	});

	it("leaves headers it does NOT manage alone", async () => {
		const seen = await call(bearer, {
			url: `${ORIGIN}/pets`,
			headers: { "x-trace": "abc" },
		});
		expect(seen?.headers["x-trace"]).toBe("abc");
		expect(seen?.headers.authorization).toBe("Bearer s3cret");
	});

	it("an unbound destination goes UNAUTHENTICATED, not refused", async () => {
		const other = "https://93.184.216.35";
		const seen = await call(
			{ ...bearer, allow: [ORIGIN, other] },
			{ url: `${other}/thing` },
		);
		// Still floored and still policy-governed upstream — just carrying no credential.
		expect(seen?.headers.authorization).toBeUndefined();
		expect(seen?.url).toBe(`${other}/thing`);
	});

	it("a bound destination whose secret does not resolve FAILS LOUD", async () => {
		// The alternative is sending it unauthenticated, which dresses a configuration error up as a
		// public endpoint and hands the failure to whoever reads the 401 an hour later.
		await expect(
			call(
				{
					allow: [ORIGIN],
					credentials: {
						bindings: [
							{
								origin: ORIGIN,
								secret: "missing",
								placement: { kind: "bearer" as const },
							},
						],
						secrets: secretsOf({}),
					},
				},
				{ url: `${ORIGIN}/pets` },
			),
		).rejects.toThrow(/no secret named missing/);
	});

	it("matches on normalized ORIGIN, so a spelling difference does not lose the binding", async () => {
		const seen = await call(
			{
				allow: [ORIGIN],
				credentials: {
					bindings: [
						{
							// Written with an explicit default port; the request uses neither.
							origin: `${ORIGIN}:443`,
							secret: "petstore",
							placement: { kind: "bearer" as const },
						},
					],
					secrets: secretsOf({ petstore: { kind: "token", value: "s3cret" } }),
				},
			},
			{ url: `${ORIGIN}/pets` },
		);
		expect(seen?.headers.authorization).toBe("Bearer s3cret");
	});

	it("places an apiKey header, and a query credential onto the URL", async () => {
		const header = await call(
			{
				allow: [ORIGIN],
				credentials: {
					bindings: [
						{
							origin: ORIGIN,
							secret: "k",
							placement: { kind: "header" as const, name: "X-API-Key" },
						},
					],
					secrets: secretsOf({ k: { kind: "token", value: "abc" } }),
				},
			},
			{ url: `${ORIGIN}/pets` },
		);
		expect(header?.headers["X-API-Key"]).toBe("abc");

		const query = await call(
			{
				allow: [ORIGIN],
				credentials: {
					bindings: [
						{
							origin: ORIGIN,
							secret: "k",
							placement: { kind: "query" as const, name: "api_key" },
						},
					],
					secrets: secretsOf({ k: { kind: "token", value: "a b" } }),
				},
			},
			{ url: `${ORIGIN}/pets?page=2` },
		);
		// Appended to the existing query, and percent-encoded.
		expect(query?.url).toBe(`${ORIGIN}/pets?page=2&api_key=a%20b`);
	});

	it("refuses material of the wrong shape rather than sending it malformed", async () => {
		await expect(
			call(
				{
					allow: [ORIGIN],
					credentials: {
						bindings: [
							{
								origin: ORIGIN,
								secret: "k",
								placement: { kind: "bearer" as const },
							},
						],
						secrets: secretsOf({
							k: { kind: "basic", username: "u", password: "p" },
						}),
					},
				},
				{ url: `${ORIGIN}/pets` },
			),
		).rejects.toThrow(/needs token material/);
	});
});
