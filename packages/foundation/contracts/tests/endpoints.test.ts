// endpoints() — the declared plugin api namespace: the returned object IS the plain callable api
// (handlers exposed as-is, the unchanged in-process path) while the flattened route table rides
// non-enumerably under ENDPOINTS_METADATA. Path/verb derivation is the ONE shared source
// (toKebabCase + endpointHttpMethod) the base api routes also use.

import { type } from "arktype";
import { describe, expect, it } from "vitest";
import {
	ENDPOINTS_METADATA,
	EuroclawError,
	endpointHttpMethod,
	endpointRoutesOf,
	endpoints,
	route,
	toKebabCase,
} from "../src/index";

const echoInput = type({ value: "string" });

describe("toKebabCase — the one splitter", () => {
	it("splits camelCase on uppercase boundaries", () => {
		expect(toKebabCase("listMessages")).toBe("list-messages");
		expect(toKebabCase("getByKey")).toBe("get-by-key");
		expect(toKebabCase("getToolCallByProviderId")).toBe(
			"get-tool-call-by-provider-id",
		);
	});

	it("leaves already-lowercase names alone", () => {
		expect(toKebabCase("set")).toBe("set");
		expect(toKebabCase("registrations")).toBe("registrations");
	});
});

describe("endpointHttpMethod — the one name→verb rule", () => {
	it("routes get*/list* reads to GET and everything else to POST", () => {
		expect(endpointHttpMethod("getClaw")).toBe("GET");
		expect(endpointHttpMethod("listMessages")).toBe("GET");
		expect(endpointHttpMethod("set")).toBe("POST");
		expect(endpointHttpMethod("createThread")).toBe("POST");
		expect(endpointHttpMethod("read")).toBe("POST");
	});
});

// Every route needs an authz declaration to be buildable at all; these fixtures are exercising the
// collector, not the gate, so they take the caller-only escape with a reason that says as much.
const FIXTURE =
	"a collector fixture — the gate itself is pinned in route-gate.test-d.ts";
const stub = <T>(handler: (input: { value: string }) => T) =>
	route.input(echoInput).authz(null, FIXTURE).handler(handler);

describe("endpoints() — callable namespace + route metadata", () => {
	it("exposes each handler AS the namespace method (identity, no wrapper)", async () => {
		const set = async (input: { value: string }) => `set:${input.value}`;
		const ns = endpoints({ set: stub(set) });

		expect(ns.set).toBe(set);
		await expect(ns.set({ value: "x" })).resolves.toBe("set:x");
	});

	it("derives kebab paths and verbs from method names; a method override wins", () => {
		const ns = endpoints({
			set: stub(() => "set"),
			listRows: stub(() => []),
			getByKey: stub(() => null),
			catalog: route
				.input(echoInput)
				.method("GET")
				.authz(null, FIXTURE)
				.handler(() => []),
		});

		expect(endpointRoutesOf(ns)).toEqual([
			expect.objectContaining({ name: "set", path: "/set", method: "POST" }),
			expect.objectContaining({
				name: "listRows",
				path: "/list-rows",
				method: "GET",
			}),
			expect.objectContaining({
				name: "getByKey",
				path: "/get-by-key",
				method: "GET",
			}),
			expect.objectContaining({
				name: "catalog",
				path: "/catalog",
				method: "GET",
			}),
		]);
	});

	it("flattens nested groups into multi-segment paths and navigable objects", async () => {
		const ns = endpoints({
			install: stub(() => "installed"),
			packages: {
				create: stub(async () => "created"),
				getByDigest: stub(() => null),
			},
		});

		await expect(ns.packages.create({ value: "v" } as never)).resolves.toBe(
			"created",
		);
		const routes = endpointRoutesOf(ns);
		expect(
			routes?.map((route) => [route.name, route.path, route.method]),
		).toEqual([
			["install", "/install", "POST"],
			["packages.create", "/packages/create", "POST"],
			["packages.getByDigest", "/packages/get-by-digest", "GET"],
		]);
	});

	it("carries the input schema and description in metadata for the boundary/OpenAPI slices", () => {
		const ns = endpoints({
			set: route
				.input(echoInput)
				.description("Upsert a value")
				.authz(null, FIXTURE)
				.handler(() => "ok"),
		});

		const routes = endpointRoutesOf(ns);
		expect(routes?.[0]?.description).toBe("Upsert a value");
		expect(routes?.[0]?.input({ value: "x" })).toEqual({ value: "x" });
		expect(routes?.[0]?.input({ value: 42 })).toBeInstanceOf(type.errors);
	});

	it("carries the declared output schema in metadata AS-IS, and only when declared", () => {
		const echoOutput = type({ echoed: "string" });
		const ns = endpoints({
			set: route
				.input(echoInput)
				.output(echoOutput)
				.authz(null, FIXTURE)
				.handler(() => ({ echoed: "ok" })),
			delete: stub(() => undefined),
		});

		const routes = endpointRoutesOf(ns);
		// Identity, not a copy: the OpenAPI generator reads the very schema the plugin declared. It is
		// NEVER run against handler results — outputs are trusted server code (arktype at boundaries).
		expect(routes?.[0]?.output).toBe(echoOutput);
		expect(routes?.[1]?.output).toBeUndefined();
	});

	it("keeps the metadata non-enumerable: the namespace shape is api-identical and a spread drops it", () => {
		const ns = endpoints({ set: stub(() => "ok") });

		expect(Object.keys(ns)).toEqual(["set"]);
		const descriptor = Object.getOwnPropertyDescriptor(ns, ENDPOINTS_METADATA);
		expect(descriptor?.enumerable).toBe(false);
		// The spread trap this design accepts: compose DEFS records, never built namespaces.
		expect(endpointRoutesOf({ ...ns })).toBeUndefined();
	});

	it("returns undefined routes for plain (non-endpoints) api objects", () => {
		expect(endpointRoutesOf({ marker: "plain" })).toBeUndefined();
		expect(endpointRoutesOf(null)).toBeUndefined();
		expect(endpointRoutesOf("secrets")).toBeUndefined();
	});

	it("fails loud at declaration when a definition has no input schema", () => {
		const noInput = { handler: () => "ok", authz: { mode: "caller" } };
		expect(() => endpoints({ set: noInput } as never)).toThrow(EuroclawError);
		expect(() => endpoints({ set: noInput } as never)).toThrow(
			/no input schema/,
		);
	});

	// The builder cannot produce an unauthorized route — `.handler()` is unreachable until `.authz()`
	// runs. A hand-rolled object literal can still reach the collector, though, and that is exactly the
	// state the whole mechanism exists to make impossible, so it must not be collected as "no check".
	it("fails loud at declaration when a definition declares no authz", () => {
		const noAuthz = { input: echoInput, handler: () => "ok" };
		expect(() => endpoints({ set: noAuthz } as never)).toThrow(EuroclawError);
		expect(() => endpoints({ set: noAuthz } as never)).toThrow(
			/declares no authz/,
		);
	});

	// The reason a caller-only route gave is not decoration: it rides into the route table so the boot
	// coverage walk can enumerate every route authorizing against nothing shared, with its stated why.
	it("carries each route's authz declaration into the metadata", () => {
		const ns = endpoints({
			mine: stub(() => "ok"),
			theirs: route
				.input(echoInput)
				.authz("read", (i) => ({ kind: "widget", id: i.value }))
				.handler(() => "ok"),
		});

		const routes = endpointRoutesOf(ns);
		expect(routes?.[0]?.authz).toEqual({ mode: "caller", reason: FIXTURE });
		expect(routes?.[1]?.authz).toMatchObject({
			mode: "resource",
			level: "read",
		});
	});
});
