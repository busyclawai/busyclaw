import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	EgressCapability,
	EgressPlan,
	EgressTransport,
	GovernedOutbound,
	GovernedSocket,
	OutboundRequest,
	OutboundResponse,
	SandboxEgressAdapter,
	UnenforcedNote,
} from "../src/index";

// The egress port must be reachable from the contracts BARREL — both @busyclaw/runtime (the compiler)
// and the @busyclaw/sandboxes plugin (the adapters) import it from here, and plugins import
// foundation-only. These are plain, DOM-free types: this suite constructs a value of each shape as
// ordinary data / functions with no runtime dependency, proving nothing runtime-only leaked into the
// port (the "tier check" from the brief).

describe("egress enforcement port — plain types from the contracts barrel", () => {
	it("expresses all three capability tiers through one union", () => {
		const blocked: EgressCapability = { posture: "blocked" };
		const allowlist: EgressCapability = { posture: "allowlist" };
		const interceptorFetch: EgressCapability = {
			posture: "interceptor",
			transport: "fetch",
		};
		const interceptorSocket: EgressCapability = {
			posture: "interceptor",
			transport: "fetch+connect",
		};

		expect(blocked.posture).toBe("blocked");
		expect(allowlist.posture).toBe("allowlist");
		expect(interceptorFetch).toMatchObject({
			posture: "interceptor",
			transport: "fetch",
		});
		expect(interceptorSocket.transport).toBe("fetch+connect");
		expectTypeOf<EgressTransport>().toEqualTypeOf<"fetch" | "fetch+connect">();
	});

	it("models outbound requests at connection granularity (fetch + connect)", () => {
		const fetchReq: OutboundRequest = {
			kind: "fetch",
			url: "https://api.example.com/v1/things",
			method: "GET",
			headers: { accept: "application/json" },
		};
		const connectReq: OutboundRequest = {
			kind: "connect",
			host: "db.example.com",
			port: 5432,
		};
		expect(fetchReq.kind).toBe("fetch");
		expect(connectReq).toMatchObject({ kind: "connect", port: 5432 });
	});

	it("types a governed outbound with fetch required and connect optional", async () => {
		const response: OutboundResponse = { status: 200, headers: {}, body: "ok" };
		const outbound: GovernedOutbound = { fetch: async () => response };

		expect(outbound.connect).toBeUndefined();
		await expect(
			outbound.fetch({
				kind: "fetch",
				url: "https://x.example",
				method: "GET",
				headers: {},
			}),
		).resolves.toMatchObject({ status: 200 });

		// `connect` is expressible (typed now) for a socket-capable backend, even though unimplemented
		// in this slice — proving the union carries the fetch+connect tier without retrofit.
		expectTypeOf<GovernedOutbound["connect"]>().toEqualTypeOf<
			| ((
					target: Extract<OutboundRequest, { kind: "connect" }>,
			  ) => Promise<GovernedSocket>)
			| undefined
		>();
	});

	it("expresses every plan mode and an unenforced note as plain data", () => {
		const blocked: EgressPlan = { mode: "blocked" };
		const allow: EgressPlan = { mode: "allowlist", allow: ["*.example.com"] };
		const intercept: EgressPlan = {
			mode: "interceptor",
			outbound: { fetch: async () => ({ status: 204, headers: {} }) },
		};
		const note: UnenforcedNote = {
			dimension: "credential-isolation",
			detail: "guest holds its own credentials on this tier",
		};

		expect(blocked.mode).toBe("blocked");
		expect(allow).toMatchObject({
			mode: "allowlist",
			allow: ["*.example.com"],
		});
		expect(intercept.mode).toBe("interceptor");
		expect(note.dimension).toBe("credential-isolation");
	});

	it("types a plugin-side adapter: a capability plus a generic apply()", async () => {
		const adapter: SandboxEgressAdapter<{ applied: EgressPlan["mode"] }> = {
			capability: { posture: "allowlist" },
			apply: async (plan) => ({ applied: plan.mode }),
		};

		expect(adapter.capability.posture).toBe("allowlist");
		await expect(adapter.apply({ mode: "blocked" })).resolves.toEqual({
			applied: "blocked",
		});
	});
});
