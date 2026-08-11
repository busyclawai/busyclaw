/**
 * The shared where/sort conformance suite, run against the MEMORY adapter.
 *
 * This is the run that matters most, and not because the memory adapter is the most deployed one —
 * it is the least. It matters because sixty-four test files in this repo build their world on it.
 * A divergence here is not confined to the memory adapter: it is a claim the rest of the suite has
 * been quietly relying on and never checked.
 */

import { memoryAdapter } from "../src/index";
import { describeWhereConformance } from "./kit/where-conformance";

const adapter = memoryAdapter();

describeWhereConformance("memory", {
	adapter: () => adapter,
	backend: "memory",
	reset: async () => {
		await adapter.deleteMany({ model: "approval", where: [] });
		await adapter.deleteMany({ model: "audit", where: [] });
	},
});
