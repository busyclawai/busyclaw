// Type tests (vitest typecheck mode — run by `pnpm test`). Prove the model-extension spine: host
// `additionalFields` and plugin `schema` flow through a const-captured config into the derived record +
// create-input types, the base config stays unchanged, undeclared fields never appear, and a schema
// that redefines a core column is rejected at `createClaw` — the compile-time mirror of the
// getEuroclawTables runtime guard.
import {
	type EuroclawPlugin,
	field,
	type Principal,
} from "@euroclaw/contracts";
import { describe, expectTypeOf, test } from "vitest";
import { createClaw } from "../src/index";
import type { ClawRecordOf, CreateClawInputOf } from "../src/models";
import { textModel } from "./fixtures";

// A const-capturing stand-in for createClaw<const Config> — isolates the type functions from the full
// assembly, so a derivation regression stays distinguishable from an assembly one.
declare function makeClaw<const Config>(config: Config): {
	getClaw: () => ClawRecordOf<Config> | null;
	createClaw: (input: CreateClawInputOf<Config>) => void;
};

describe("model extension — derived types", () => {
	test("host additionalFields land on the record and the create input", () => {
		const a = makeClaw({
			schema: { claw: { additionalFields: { priority: field.number() } } },
			plugins: [],
		});
		type ClawA = NonNullable<ReturnType<typeof a.getClaw>>;
		type CreateA = Parameters<typeof a.createClaw>[0];
		expectTypeOf<ClawA["priority"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<ClawA["id"]>().toEqualTypeOf<string>(); // base field still present
		expectTypeOf<CreateA["priority"]>().toEqualTypeOf<number | undefined>();
		// createdBy / scope / scopeId are SERVER-STAMPED (docs/plans/stamped-fields.md, #5): they are NOT
		// on the caller-facing create input — a body value is a COMPILE ERROR — yet they remain on the
		// RECORD (createdBy a required branded Principal, scope a required string defaulted at create).
		expectTypeOf<ClawA["createdBy"]>().toEqualTypeOf<Principal>();
		expectTypeOf<ClawA["scope"]>().toEqualTypeOf<string>();
		expectTypeOf<CreateA>().not.toHaveProperty("createdBy");
		expectTypeOf<CreateA>().not.toHaveProperty("scope");
		expectTypeOf<CreateA>().not.toHaveProperty("scopeId");
		expectTypeOf<ClawA>().not.toHaveProperty("nope"); // undeclared field never appears
	});

	test("a plugin's schema flows through the tuple fold", () => {
		const taggingPlugin = {
			id: "tagging",
			schema: { claw: { fields: { tag: field.string() } } },
		} satisfies EuroclawPlugin;
		const b = makeClaw({ plugins: [taggingPlugin] });
		type ClawB = NonNullable<ReturnType<typeof b.getClaw>>;
		expectTypeOf<ClawB["tag"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<ClawB["id"]>().toEqualTypeOf<string>();
	});

	test("base config stays today's ClawRecord — no extras leak on", () => {
		const c = makeClaw({ plugins: [] });
		type ClawC = NonNullable<ReturnType<typeof c.getClaw>>;
		expectTypeOf<ClawC["id"]>().toEqualTypeOf<string>();
		expectTypeOf<ClawC>().not.toHaveProperty("priority");
	});

	test("the real createClaw api surface is config-shaped end to end", () => {
		const realClaw = createClaw({
			model: textModel("done"),
			schema: {
				claw: {
					additionalFields: { priority: field.number({ required: true }) },
				},
			},
			plugins: [],
		});
		type RealClaw = NonNullable<
			Awaited<ReturnType<typeof realClaw.api.getClaw>>
		>;
		type RealCreateInput = Parameters<typeof realClaw.api.createClaw>[0];
		expectTypeOf<RealClaw["priority"]>().toEqualTypeOf<number>();
		expectTypeOf<RealCreateInput["priority"]>().toEqualTypeOf<number>();
		expectTypeOf<RealClaw>().not.toHaveProperty("nope");
	});
});

describe("model extension — core-column collision guard", () => {
	test("a plugin schema redefining a core claw column is rejected at createClaw", () => {
		const clawStatusPlugin = {
			id: "evil",
			schema: { claw: { fields: { status: field.string() } } },
		} satisfies EuroclawPlugin;
		// @ts-expect-error — a plugin schema may not redefine the core `status` column
		createClaw({ model: textModel("done"), plugins: [clawStatusPlugin] });
	});

	test("host additionalFields redefining a core claw column is rejected at createClaw", () => {
		// @ts-expect-error — host additionalFields may not redefine the core `status` column
		createClaw({
			model: textModel("done"),
			schema: { claw: { additionalFields: { status: field.number() } } },
			plugins: [],
		});
	});

	test("valid registrations are not false-flagged — a plugin-owned model may reuse a core name", () => {
		const notesPlugin = {
			id: "notes",
			// `note.status` is fine: `status` only collides on `claw`, not on a plugin-owned model.
			schema: { note: { fields: { status: field.string() } } },
		} satisfies EuroclawPlugin;
		const taggingPlugin = {
			id: "tagging",
			schema: { claw: { fields: { tag: field.string() } } },
		} satisfies EuroclawPlugin;
		createClaw({
			model: textModel("done"),
			plugins: [notesPlugin, taggingPlugin],
		});
	});
});
