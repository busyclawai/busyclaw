// What the governance floor will and will not turn into a policy-nameable ACTION.
//
// `busyclaw.execute` is the exclusion, and it regressed once already. The floor builds its model in
// two places — at assembly from the static tools, and per run from the tools a boundary registered —
// and the first version wrote the exclusion out only at the assembly site. The per-run path then put
// `execute` straight back, because the meta-tools are minted from whatever set is DISCOVERABLE: a
// claw with nothing statically discoverable and a registered tool that is mints them per run. The
// invariant held in one configuration and broke in the other.
//
// So this pins the predicate itself rather than only the behaviour that happens to notice.

import { EXECUTE_TOOL_PATH, SEARCH_TOOL_PATH } from "@busyclaw/runtime";
import { describe, expect, it } from "vitest";
import { modelableActions } from "../src/authz-floor";

const descriptor = (path: string) =>
	({ path, governance: {} }) as Parameters<typeof modelableActions>[0][number];

describe("what the floor models", () => {
	it("drops busyclaw.execute and keeps everything else", () => {
		const kept = modelableActions([
			descriptor("host.tool"),
			descriptor(SEARCH_TOOL_PATH),
			descriptor(EXECUTE_TOOL_PATH),
			descriptor("registered.petstore.createPet"),
		]).map((d) => d.path);

		expect(kept).toEqual([
			"host.tool",
			SEARCH_TOOL_PATH,
			"registered.petstore.createPet",
		]);
	});

	it("drops it wherever it appears — the per-run list is not a different rule", () => {
		// The regression in one line: a run whose ONLY discoverable tool arrived per-run still mints
		// the meta-tools, so the per-run descriptor list contains `execute` too.
		expect(
			modelableActions([
				descriptor("hidden"),
				descriptor(SEARCH_TOOL_PATH),
				descriptor(EXECUTE_TOOL_PATH),
			]).map((d) => d.path),
		).not.toContain(EXECUTE_TOOL_PATH);
	});

	it("search IS modeled — the exclusion is one path, not the namespace", () => {
		// Excluding `busyclaw.*` wholesale would deny discovery: an action absent from the model is
		// refused, so search would stop answering and the reason would look like policy.
		expect(
			modelableActions([descriptor(SEARCH_TOOL_PATH)]).map((d) => d.path),
		).toEqual([SEARCH_TOOL_PATH]);
	});
});
