// The three durable ports a runtime needs, built over one adapter.
//
// The runtime used to do this itself from a `database` config field, which is what made
// @busyclaw/runtime depend on a storage IMPLEMENTATION instead of on the ports in contracts. It takes
// the ports now, and the assembly (packages/busyclaw/src/index.ts) does the wiring for real hosts.
// These suites are the other caller, so they get the same wiring in one place rather than three
// constructors repeated at thirty-one sites.
//
// `now` is threaded on purpose: the checkpoint store stamps its own rows, so a suite driving a fake
// clock must hand the SAME clock to both halves or its checkpoints carry wall-clock timestamps while
// its run carries frozen ones — a drift that would surface as an unrelated assertion failure.

import type { Adapter } from "@busyclaw/contracts";
import {
	createApprovalStore,
	createEffectStore,
	createRunCheckpointStore,
} from "@busyclaw/storage-durable";

export function durableStores(
	adapter: Adapter,
	options?: { now?: () => string },
) {
	return {
		approvalStore: createApprovalStore(adapter),
		effectStore: createEffectStore(adapter),
		checkpoints: createRunCheckpointStore(
			adapter,
			options?.now ? { now: options.now } : undefined,
		),
	};
}
