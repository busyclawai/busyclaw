import type { ResolveContext, SecretMaterial, Secrets } from "@euroclaw/contracts";
import { EuroclawError } from "@euroclaw/contracts";
import { buildSecrets } from "@euroclaw/secrets";
import { describe, expect, it } from "vitest";
import {
	applyCredentials,
	type CredentialContext,
} from "../src/tools/invoke/credentials";
import type { HttpRequestPlan } from "../src/tools/invoke/request-plan";
import type { OpenApiBinding } from "../src/tools/sources/openapi";

const CTX: CredentialContext = { organizationId: "org-a", source: "petstore" };

const authSchemes: NonNullable<OpenApiBinding["authSchemes"]> = {
	apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
	apiKeyQuery: { type: "apiKey", in: "query", name: "api_key" },
	bearerAuth: { type: "http", scheme: "bearer" },
	basicAuth: { type: "http", scheme: "basic" },
	oauth: { type: "oauth2" },
};

function plan(): HttpRequestPlan {
	return {
		method: "GET",
		url: "https://api.example/v1/pets",
		origin: "https://api.example",
		headers: {},
	};
}

function binding(security: OpenApiBinding["security"]): OpenApiBinding {
	return {
		method: "get",
		path: "/pets",
		server: "https://api.example/v1",
		parameters: [],
		authSchemes,
		...(security !== undefined ? { security } : {}),
	};
}

/** A fake one-door reader keyed by the registration SOURCE name (one credential per registration —
 *  the invoker resolves `secrets.get(source, ctx)`, never per scheme). Records the (ref, ctx) it was
 *  asked for; the sentinel "throw" is an infra failure the reader must surface, never swallow. */
function sourceSecrets(table: Record<string, SecretMaterial | "throw">): {
	secrets: Secrets;
	seen: Array<{ ref: string; ctx: ResolveContext }>;
} {
	const seen: Array<{ ref: string; ctx: ResolveContext }> = [];
	const secrets = buildSecrets([
		{
			name: "test",
			capability: { manage: false },
			get: async (ref, ctx) => {
				seen.push({ ref, ctx });
				const entry = table[ref];
				if (entry === "throw") throw new Error("vault unreachable");
				return entry ?? null;
			},
		},
	]);
	return { secrets, seen };
}

describe("applyCredentials — placement per scheme (source-keyed material)", () => {
	it("apiKey in header", async () => {
		const { secrets } = sourceSecrets({
			petstore: { kind: "token", value: "sk-123" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ apiKeyHeader: [] }]),
			secrets,
			CTX,
		);
		expect(out.headers["X-API-Key"]).toBe("sk-123");
	});

	it("apiKey in query (appended, encoded)", async () => {
		const { secrets } = sourceSecrets({
			petstore: { kind: "token", value: "a b+c" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ apiKeyQuery: [] }]),
			secrets,
			CTX,
		);
		expect(out.url).toBe("https://api.example/v1/pets?api_key=a%20b%2Bc");
	});

	it("http bearer → Authorization: Bearer", async () => {
		const { secrets } = sourceSecrets({
			petstore: { kind: "token", value: "tok" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ bearerAuth: [] }]),
			secrets,
			CTX,
		);
		expect(out.headers.authorization).toBe("Bearer tok");
	});

	it("http basic → Authorization: Basic base64(user:pass)", async () => {
		const { secrets } = sourceSecrets({
			petstore: { kind: "basic", username: "alice", password: "s3cret" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ basicAuth: [] }]),
			secrets,
			CTX,
		);
		expect(out.headers.authorization).toBe(
			`Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
		);
	});

	it("oauth2 material is placed as a bearer token", async () => {
		const { secrets } = sourceSecrets({
			petstore: { kind: "token", value: "oauth-tok" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ oauth: ["pets:read"] }]),
			secrets,
			CTX,
		);
		expect(out.headers.authorization).toBe("Bearer oauth-tok");
	});
});

describe("applyCredentials — AND / OR alternatives", () => {
	it("AND: the ONE source credential is placed in every scheme's slot", async () => {
		// One credential per registration: both AND-ed schemes resolve the SAME source material and
		// apply it in their own placement (X-API-Key and Authorization both carry it).
		const { secrets } = sourceSecrets({
			petstore: { kind: "token", value: "cred" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ apiKeyHeader: [], bearerAuth: [] }]),
			secrets,
			CTX,
		);
		expect(out.headers["X-API-Key"]).toBe("cred");
		expect(out.headers.authorization).toBe("Bearer cred");
	});

	it("OR: the first alternative whose schemes are all SUPPORTED wins", async () => {
		// Source-keyed resolution ⇒ a source resolves for every scheme or none, so the OR differentiator
		// is scheme SUPPORT: the first alternative references an undefined scheme → skipped; the second wins.
		const { secrets } = sourceSecrets({
			petstore: { kind: "token", value: "cred" },
		});
		const out = await applyCredentials(
			plan(),
			binding([{ undefinedScheme: [] }, { apiKeyHeader: [] }]),
			secrets,
			CTX,
		);
		expect(out.headers.authorization).toBeUndefined();
		expect(out.headers["X-API-Key"]).toBe("cred");
	});

	it("threads the source name and the turn's org + actor into the reader — never model args", async () => {
		const { secrets, seen } = sourceSecrets({
			petstore: { kind: "token", value: "t" },
		});
		await applyCredentials(
			plan(),
			binding([{ oauth: ["pets:read", "pets:write"] }]),
			secrets,
			{ organizationId: "org-a", source: "petstore", actor: "alice" },
		);
		// Resolution is source-keyed: the reader sees the registration source + the turn's org/actor.
		// The scheme + scopes are NOT part of the name — they drive APPLICATION (from the securityScheme).
		expect(seen[0]).toEqual({
			ref: "petstore",
			ctx: { organizationId: "org-a", actor: "alice" },
		});
	});
});

describe("applyCredentials — failure modes stay distinguishable", () => {
	it("a required-but-unconfigured scheme fails loud, naming source + scheme", async () => {
		const { secrets } = sourceSecrets({});
		await expect(
			applyCredentials(plan(), binding([{ apiKeyHeader: [] }]), secrets, CTX),
		).rejects.toMatchObject({
			code: "EUROCLAW_CONFIGURATION_ERROR",
			details: {
				source: "petstore",
				unsatisfied: ["apiKeyHeader (not configured)"],
			},
		});
	});

	it("a reader THROW propagates as infra failure, NOT missing-credential", async () => {
		const { secrets } = sourceSecrets({ petstore: "throw" });
		const error = await applyCredentials(
			plan(),
			binding([{ bearerAuth: [] }]),
			secrets,
			CTX,
		).catch((e) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(EuroclawError); // distinct from the config error above
		expect((error as Error).message).toBe("vault unreachable");
	});

	it("public: undefined and [] security send nothing", async () => {
		const { secrets, seen } = sourceSecrets({});
		const undef = await applyCredentials(plan(), binding(undefined), secrets, CTX);
		const empty = await applyCredentials(plan(), binding([]), secrets, CTX);
		expect(undef.headers).toEqual({});
		expect(empty.headers).toEqual({});
		expect(seen).toHaveLength(0); // the reader was never consulted
	});

	it("a `{}` alternative is explicitly public and short-circuits", async () => {
		const { secrets, seen } = sourceSecrets({});
		const out = await applyCredentials(
			plan(),
			binding([{}, { apiKeyHeader: [] }]),
			secrets,
			CTX,
		);
		expect(out.headers).toEqual({});
		expect(seen).toHaveLength(0);
	});
});
