// Type tests (vitest typecheck mode). The PAYOFF of moving the app-authz resource binding OFF the old
// central `CORE_API_RESOURCES`/`DYNAMIC_KIND_METHODS` maps ONTO each method's own route def: the binding
// is now TYPE-CHECKED against that method's input. A binding whose `idKey`/`kindKey` is not a key of the
// method's input FAILS TO COMPILE — the whole reason for the refactor. (The old maps typed `idKey` as a
// bare `string`, so a wrong key compiled and only failed CLOSED at runtime.)
import { describe, test } from "vitest";
import type { ClawApiRouteDefinition } from "../src/api";

describe("resource binding — co-located and type-checked against the method input", () => {
	test("a STATIC binding must use an idKey that is a key of the method input", () => {
		// getClaw's input is `{ id: string }` — `idKey: "id"` is valid.
		const good: ClawApiRouteDefinition<"getClaw">["resource"] = {
			kind: "claw",
			idKey: "id",
		};
		void good;
		const bad: ClawApiRouteDefinition<"getClaw">["resource"] = {
			kind: "claw",
			// @ts-expect-error — "clawId" is not a key of getClaw's input ({ id: string })
			idKey: "clawId",
		};
		void bad;
	});

	test("a DYNAMIC binding must use a kindKey/idKey that are keys of the method input", () => {
		// shareResource's input carries `resourceKind` + `resourceId` — both valid.
		const good: ClawApiRouteDefinition<"shareResource">["resource"] = {
			kindKey: "resourceKind",
			idKey: "resourceId",
		};
		void good;
		const bad: ClawApiRouteDefinition<"shareResource">["resource"] = {
			// @ts-expect-error — "notAField" is not a key of shareResource's input
			kindKey: "notAField",
			idKey: "resourceId",
		};
		void bad;
	});
});
