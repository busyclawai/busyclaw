// Type tests (vitest typecheck mode — run by `pnpm test`): the field doc pair —
// `description`/`doc` — typechecks on EVERY field kind and is const-captured on the descriptor
// like the storage flags, so derivation reads it as a literal.

import { type } from "arktype";
import { describe, expectTypeOf, test } from "vitest";
import { field } from "../src/index";

describe("field.* doc options", () => {
	test("description/doc are accepted by every field kind", () => {
		field.string({ description: "d", doc: "D" });
		field.number({ description: "d", doc: "D" });
		field.boolean({ description: "d", doc: "D" });
		field.jsonObject({ description: "d", doc: "D" });
		field.jsonValue({ description: "d", doc: "D" });
		field.json(type({ x: "number" }), { description: "d", doc: "D" });
		field.enum(["a", "b"], { description: "d", doc: "D" });
		field.principal({ description: "d", doc: "D" });
	});

	test("docs are const-captured on the descriptor like the flags", () => {
		const described = field.string({
			required: true,
			description: "d",
			doc: "D",
		});
		expectTypeOf(described.description).toEqualTypeOf<"d">();
		expectTypeOf(described.doc).toEqualTypeOf<"D">();
	});

	test("the doc pair is strings, never prose-shaped objects", () => {
		// @ts-expect-error — description is a string
		field.string({ description: 42 });
		// @ts-expect-error — doc is a string
		field.enum(["a"], { doc: { text: "no" } });
	});
});
