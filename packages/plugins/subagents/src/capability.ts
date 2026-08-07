// Spawning a child, and the four things that make it safe.
//
// 1. THE ID IS DERIVED, from state that survives a replay — so a resumed parent re-calling the spawn
//    tool asks for the child it already has, rather than a second one.
// 2. THE EDGE IS WRITTEN FIRST. `startRun` commits the run row and its task in one transaction with
//    `dueAt` defaulting to now, so the child is claimable the instant that lands. The edge is a
//    separate write to a different table and cannot join it. Ordered the other way, a crash between
//    them leaves a child already executing with no edge: invisible to every subtree query,
//    unattributable, uncancellable. Ordered this way it leaves an edge with no run — which is
//    visible, and finishable, precisely because the id is pinned and `startRun` is idempotent.
// 3. A COLLISION IS REFUSED, NEVER ADOPTED. The derivation is exactly-once but unauthenticated: the
//    hash is unsalted over guessable values and `startRun` is caller-only, so any authenticated
//    principal may pin a run id. Adopting whatever is already there would let a peer pre-create a run
//    the parent then treats as its own child.
// 4. AUTHORITY IS COPIED, NEVER NAMED. There is no principal parameter at any layer. A model can ask
//    for a child; it can never ask WHO the child is.

import type {
	CapabilityContext,
	JsonObject,
	Principal,
} from "@busyclaw/contracts";
import {
	conflictError,
	isConflict,
	stateError,
	validationError,
} from "@busyclaw/contracts";
import { childRunId, childThreadId, PARENT_ALIAS } from "./schema";
import type { SubagentStore } from "./store";

/**
 * The engine surface a spawn needs — structural, so this package never imports an engine package.
 *
 * `startRun` and a run reader is the whole dependency. Any engine implementing the contract
 * satisfies it, which is the point: nothing here knows it is talking to `engine-sql`.
 */
export type SpawnEngine = {
	startRun: (input: {
		prompt: string;
		ctx?: JsonObject;
		clawId?: string;
		run?: { id?: string; principal?: Principal };
	}) => Promise<{ id: string }>;
	runs?: {
		get: (id: string) => Promise<{
			status: string;
			principal?: string;
			clawId?: string;
			threadId?: string;
		} | null>;
	};
};

/** The thread store, narrowed to what a spawn needs. */
export type SpawnThreads = {
	create: (input: {
		id?: string;
		clawId: string;
		title?: string;
	}) => Promise<{ id: string }>;
	get: (id: string) => Promise<{ id: string } | null>;
};

/**
 * Open the child's thread, or find the one a retry already opened.
 *
 * DERIVED ID, so this is idempotent for the same reason the run id is: a spawn that crashed between
 * the thread and the run re-runs both, and a second thread would leave the first orphaned in the
 * claw with nobody able to say which one the child writes to.
 */
async function openChildThread(input: {
	threads: SpawnThreads;
	clawId: string;
	alias: string;
	childRunId: string;
	now: string;
}): Promise<{ clawId: string; threadId: string }> {
	const threadId = childThreadId(input.childRunId);
	const existing = await input.threads.get(threadId);
	if (existing === null) {
		try {
			await input.threads.create({
				id: threadId,
				clawId: input.clawId,
				// The alias, because this is what a person scanning the claw's threads will read.
				// The alias, because this is what a person scanning a subtree will read. The thread's
				// ORIGIN keeps it out of the claw's default list; nothing here has to know that.
				title: input.alias,
			});
		} catch (error) {
			// Lost the race to a concurrent retry — which wanted the same row, so it is done.
			if (!isConflict(error)) throw error;
		}
	}
	return { clawId: input.clawId, threadId };
}

/** What the stamped tool receives under the name it asked for. */
export type AgentCapability = {
	spawnChild: (input: {
		alias: string;
		prompt: string;
	}) => Promise<{ childRunId: string }>;
	status: () => Promise<readonly AgentChildStatus[]>;
};

export type AgentChildStatus = {
	alias: string;
	childRunId: string;
	depth: number;
	/** The CHILD RUN's status, read from the run rather than mirrored onto the edge — one writer for
	 *  one fact. An edge whose run has been pruned reads `unknown` rather than inventing a state. */
	status: string;
};

export type SpawnLimits = {
	maxDepth: number;
	maxChildren: number;
};

/**
 * Build the capability for ONE call, from what the runtime pinned about that call.
 *
 * `ctx.principal` is the parent's resolved authority. `ctx.runId` and `ctx.step` are the run and the
 * step — replay-stable, which is what the derived id needs. Nothing here is readable from tool
 * arguments, which is what makes the copy-never-name property structural rather than a discipline.
 */
export function createAgentCapability(input: {
	ctx: CapabilityContext;
	engine: SpawnEngine;
	threads: SpawnThreads;
	store: SubagentStore;
	limits: SpawnLimits;
	now: () => string;
}): AgentCapability {
	const { ctx, engine, store, limits } = input;
	const requireRun = (): { runId: string; principal: Principal } => {
		// An ad-hoc `generate` has no run id and therefore no durable identity for a child to point at.
		// Refused rather than invented: a child whose parent cannot be named is unreachable by every
		// subtree operation the moment this process ends.
		if (ctx.runId === undefined) {
			throw stateError("a subagent can only be spawned from a durable run", {
				reason: "this invocation has no run id to parent the child to",
			});
		}
		// The floor fails closed on an absent identity, so a child started without one could execute
		// nothing at all — and would look like a policy bug rather than a missing authority.
		if (ctx.principal === undefined) {
			throw stateError("a subagent can only be spawned by a known principal", {
				runId: ctx.runId,
			});
		}
		return { runId: ctx.runId, principal: ctx.principal };
	};

	return {
		async spawnChild({ alias, prompt }) {
			const { runId: parentRunId, principal } = requireRun();
			if (alias === "") {
				throw validationError("spawn input invalid", "alias must not be empty");
			}
			// RESERVED. Every child knows its parent under this name, so a sibling claiming it would
			// overwrite the row a child uses to answer upward.
			if (alias === PARENT_ALIAS) {
				throw validationError(
					"spawn input invalid",
					`"${PARENT_ALIAS}" is the reserved alias every child knows its parent by`,
				);
			}

			const parentEdge = await store.edge(parentRunId);
			// The root of a top-level run is itself; below that it is inherited, so a subtree query is
			// one indexed read at any depth.
			const depth = (parentEdge?.depth ?? 0) + 1;
			const rootRunId = parentEdge?.rootRunId ?? parentRunId;
			if (depth > limits.maxDepth) {
				throw stateError("subagent depth limit reached", {
					depth,
					maxDepth: limits.maxDepth,
					// Legible to the model, which is the point of refusing here rather than only in policy:
					// the refusal it reads should say what it hit.
					reason: `this run is already ${depth - 1} levels deep; the limit is ${limits.maxDepth}`,
				});
			}
			// COUNTED IN THE DATABASE, not in a JS integer: the ceiling has to hold across processes and
			// pods, and a parent resumed in a different worker has no memory of what it spawned before.
			const existing = await store.countChildren(parentRunId);
			if (existing >= limits.maxChildren) {
				throw stateError("subagent fan-out limit reached", {
					children: existing,
					maxChildren: limits.maxChildren,
					reason: `this run already has ${existing} children; the limit is ${limits.maxChildren}`,
				});
			}

			const id = childRunId({ parentRunId, alias });
			const stamp = input.now();
			// THE CHILD SHARES THE PARENT'S CONTAINER, which reverses D10 and is the point.
			//
			// A subagent talks about the things its parent mentioned, and it has to be able to name
			// them the same way. Under separate containers the parent says `{{pii:email:swift-otter}}`
			// and the child, given the same person, mints `{{pii:email:brave-fox}}` — so when it
			// reports back, nothing in the tree can tell the two refer to one person. Token coherence
			// across a subtree is what makes the subtree's conversation legible.
			//
			// It follows from the recording rather than being chosen: a recorded run's container IS
			// its claw (`runContainer`), and the child is recorded so its answer is readable. The two
			// decisions are the same decision.
			//
			// What this gives up is per-subtree erasure granularity. That is the right trade: one
			// container per claw is what a data-subject request actually means, and a child is the
			// same principal in the same claw with the same tools — not a lower-trust thing to wall
			// off from its parent.

			// The parent's claw decides both the child's thread and its container, so it is resolved
			// before the edge — which records where the child's PII will live.
			const parent = await engine.runs?.get(parentRunId);
			const childContainer =
				parent?.clawId !== undefined
					? { containerKind: "claw", containerId: parent.clawId }
					: // No claw ⇒ no thread ⇒ no recording, and the child's own run is the honest
						// boundary. Its answer is unreadable in that shape, which is the same thing that
						// is true of any claw-less run.
						{ containerKind: "run", containerId: id };

			// EDGE FIRST. See the header — this ordering is the whole recoverability argument.
			try {
				await store.createEdge({
					id,
					parentRunId,
					rootRunId,
					depth,
					alias,
					principal,
					containerKind: childContainer.containerKind,
					containerId: childContainer.containerId,
					createdAt: stamp,
					updatedAt: stamp,
				});
			} catch (error) {
				if (!isConflict(error)) throw error;
				// A row already exists for this id. It is this spawn's retry only if it says so: same
				// parent, same alias, same authority. Anything else is somebody who guessed the hash.
				const claimed = await store.edge(id);
				if (
					claimed === null ||
					claimed.parentRunId !== parentRunId ||
					claimed.alias !== alias ||
					claimed.principal !== principal
				) {
					throw conflictError("a different subagent already holds this id", {
						childRunId: id,
						alias,
					});
				}
			}

			// The links are the address book, and a retry re-derives the same two ids — so a conflict
			// here is the same retry arriving again and is not an error.
			await store.linkPair({
				parentRunId,
				childRunId: id,
				alias,
				rootRunId,
				createdBy: principal,
				createdAt: stamp,
			});

			// PINNED, so this is idempotent: a retry that already wrote the edge re-runs exactly this and
			// the run row's unique id turns the second attempt away.
			// ITS OWN THREAD, in the parent's claw. A child used to write no transcript at all, which
			// left its answer readable through NO door: `getRun` does not serve content, and the
			// `run.completed` event payload is allowlisted. A thread gives the answer a home that
			// `listMessages` already gates, audits and `view`-guards — rather than inventing a
			// content door for subagents alone.
			//
			// Its own, not the parent's: a child's steps are its own work, and folding them into the
			// conversation a human is reading would make the parent's thread unreadable.
			const recording =
				parent?.clawId !== undefined
					? await openChildThread({
							threads: input.threads,
							clawId: parent.clawId,
							alias,
							childRunId: id,
							now: stamp,
						})
					: undefined;
			try {
				await engine.startRun({
					prompt,
					// Lineage for gates, as `ctx` — convenience, not the record. The tables are the
					// truth; nothing added to the run row, because `createRun` enumerates its fields
					// and silently drops the rest.
					ctx: { agentParentRunId: parentRunId, agentAlias: alias },
					// The recording carries clawId AND threadId, which is what makes the run RECORDED —
					// so the `clawId` policy fact comes from there rather than from the bare column.
					...(recording !== undefined ? { recording } : {}),
					// PINNED, so this is idempotent: a retry that already wrote the edge re-runs
					// exactly this and the run row's unique id turns the second attempt away.
					//
					// The principal is the parent's authority, COPIED. Never a parameter — the
					// capability has no way to be told one, which is what makes this not an escalation
					// primitive even though the engine would accept any principal it was handed.
					run: { id, principal },
				});
			} catch (error) {
				// The run already exists — this spawn's own retry, verified above by the edge check
				// that let us get here. Starting it twice is what the pinned id makes impossible.
				if (!isConflict(error)) throw error;
			}
			return { childRunId: id };
		},

		async status() {
			const { runId: parentRunId } = requireRun();
			const edges = await store.children(parentRunId);
			const out: AgentChildStatus[] = [];
			for (const edge of edges) {
				const run = await engine.runs?.get(edge.id);
				out.push({
					alias: edge.alias,
					childRunId: edge.id,
					depth: edge.depth,
					// ONE WRITER FOR ONE FACT. Mirroring the run's status onto the edge would make the
					// edge a second place it lives, and the two would disagree exactly when it mattered —
					// a child that died between the run write and the mirror.
					status: run?.status ?? "unknown",
				});
			}
			return out;
		},
	};
}
