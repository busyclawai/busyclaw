// Type tests (vitest typecheck mode — run by `pnpm test`). The ArkEnv augmentation in
// governance/doc.ts makes `.configure({ busyclaw: { doc } })` plain TYPED authoring — zero casts —
// and enforces the key's shape rather than merely tolerating an unknown key; `docOf` reads any
// arktype Type structurally.

import { type } from "arktype";
import { describe, expectTypeOf, test } from "vitest";
import { docOf } from "../src/index";

describe("the busyclaw doc channel is typed", () => {
	test("configure accepts the namespaced key with zero casts", () => {
		const t = type("string").configure({ busyclaw: { doc: "x" } });
		expectTypeOf(t.meta.busyclaw).toEqualTypeOf<{ doc?: string } | undefined>();
	});

	test("the key's shape is enforced, not merely tolerated", () => {
		// @ts-expect-error — doc is a string
		type("string").configure({ busyclaw: { doc: 42 } });
		// @ts-expect-error — busyclaw is the namespaced object, never bare prose
		type("string").configure({ busyclaw: "x" });
	});

	test("docOf accepts an arktype Type directly and returns string | undefined", () => {
		const t = type({ name: "string" }).configure({ busyclaw: { doc: "x" } });
		expectTypeOf(docOf(t)).toEqualTypeOf<string | undefined>();
	});
});
