// Type tests (vitest typecheck mode — run by `pnpm test`). The ArkEnv augmentation in
// governance/doc.ts makes `.configure({ euroclaw: { doc } })` plain TYPED authoring — zero casts —
// and enforces the key's shape rather than merely tolerating an unknown key; `docOf` reads any
// arktype Type structurally.

import { type } from "arktype";
import { describe, expectTypeOf, test } from "vitest";
import { docOf } from "../src/index";

describe("the euroclaw doc channel is typed", () => {
	test("configure accepts the namespaced key with zero casts", () => {
		const t = type("string").configure({ euroclaw: { doc: "x" } });
		expectTypeOf(t.meta.euroclaw).toEqualTypeOf<{ doc?: string } | undefined>();
	});

	test("the key's shape is enforced, not merely tolerated", () => {
		// @ts-expect-error — doc is a string
		type("string").configure({ euroclaw: { doc: 42 } });
		// @ts-expect-error — euroclaw is the namespaced object, never bare prose
		type("string").configure({ euroclaw: "x" });
	});

	test("docOf accepts an arktype Type directly and returns string | undefined", () => {
		const t = type({ name: "string" }).configure({ euroclaw: { doc: "x" } });
		expectTypeOf(docOf(t)).toEqualTypeOf<string | undefined>();
	});
});
