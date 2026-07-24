// Type tests (vitest typecheck mode — run by `pnpm test`). Prove the `output` pin on endpoints():
// declaring an output schema constrains the handler's return TYPE to the schema's inferred type
// (sync or promised), so the documented shape and the implementation cannot drift; without `output`
// the handler return stays free. Compile-time only — the schema is never run against results.
import { type } from "arktype";
import { describe, expectTypeOf, test } from "vitest";
import { endpoints } from "../src/index";

const echoInput = type({ value: "string" });
const echoOutput = type({ echoed: "string" });

describe("endpoints() — output pins the handler return type", () => {
	test("a conforming handler compiles, sync or promised", () => {
		const ns = endpoints({
			set: {
				input: echoInput,
				output: echoOutput,
				handler: () => ({ echoed: "ok" }),
			},
			setAsync: {
				input: echoInput,
				output: echoOutput,
				handler: async () => ({ echoed: "ok" }),
			},
		});
		// The namespace still exposes the handler's OWN type (identity, not the schema's).
		expectTypeOf(ns.set).returns.toEqualTypeOf<{ echoed: string }>();
		expectTypeOf(ns.setAsync).returns.toEqualTypeOf<
			Promise<{ echoed: string }>
		>();
	});

	test("a drifted return shape fails to compile", () => {
		endpoints({
			bad: {
				input: echoInput,
				output: echoOutput,
				// @ts-expect-error — the declared output pins the return; `echoed: number` drifts
				handler: () => ({ echoed: 42 }),
			},
		});
	});

	test("the pin reaches definitions nested in groups", () => {
		endpoints({
			packages: {
				create: {
					input: echoInput,
					output: echoOutput,
					// @ts-expect-error — group members are pinned exactly like top-level definitions
					handler: async () => ({ echoed: 42 }),
				},
			},
		});
	});

	test("without output the handler return stays free", () => {
		const ns = endpoints({
			free: { input: echoInput, handler: () => 42 },
		});
		expectTypeOf(ns.free).returns.toEqualTypeOf<number>();
	});
});

// The app-authz `resource` binding is the plugin-extensible analog of the base api's co-located route
// binding: declared on the endpoints() def, TYPE-CHECKED against the handler's INPUT keys. A binding
// whose idKey/kindKey is not a handler-input field FAILS TO COMPILE (the whole point of co-location).
const widgetInput = type({ widgetKind: "string", widgetId: "string" });

describe("endpoints() — resource pins idKey/kindKey to the handler input keys", () => {
	test("a STATIC binding using a real input key compiles; a wrong key fails", () => {
		endpoints({
			good: {
				input: widgetInput,
				handler: (input: { widgetId: string }) => input.widgetId,
				resource: { kind: "widget", idKey: "widgetId" },
			},
			bad: {
				input: widgetInput,
				handler: (input: { widgetId: string }) => input.widgetId,
				// @ts-expect-error — "nope" is not a key of the handler input ({ widgetId: string })
				resource: { kind: "widget", idKey: "nope" },
			},
		});
	});

	test("a DYNAMIC binding pins both kindKey and idKey to input keys", () => {
		endpoints({
			good: {
				input: widgetInput,
				handler: (input: { widgetKind: string; widgetId: string }) =>
					input.widgetId,
				resource: { kindKey: "widgetKind", idKey: "widgetId" },
			},
			bad: {
				input: widgetInput,
				handler: (input: { widgetKind: string; widgetId: string }) =>
					input.widgetId,
				// @ts-expect-error — "missing" is not a key of the handler input
				resource: { kindKey: "missing", idKey: "widgetId" },
			},
		});
	});

	test("the pin reaches definitions nested in groups", () => {
		endpoints({
			widgets: {
				fetch: {
					input: widgetInput,
					handler: (input: { widgetId: string }) => input.widgetId,
					// @ts-expect-error — group members are pinned exactly like top-level definitions
					resource: { kind: "widget", idKey: "nope" },
				},
			},
		});
	});
});
