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
import { childRunId, PARENT_ALIAS } from "./schema";
import type { SubagentStore } from "./store";

/** The claw surface a spawn needs — structural, so this package never imports the assembly. */
export type SpawnClawLike = {
	api: {
		startRun: (
			input: {
				prompt: string;
				ctx?: JsonObject;
				parentRunId?: string;
				run?: { id?: string };
			},
			caller?: { principal?: Principal },
		) => Promise<{ runId: string }>;
		getRun: (
			input: { id: string },
			caller?: { principal?: Principal },
		) => Promise<{ status: string; principal?: string } | null>;
	};
};

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
	claw: SpawnClawLike;
	store: SubagentStore;
	limits: SpawnLimits;
	now: () => string;
}): AgentCapability {
	const { ctx, claw, store, limits } = input;
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
			// THE CHILD'S OWN CONTAINER (D10). Not the parent's: a placeholder minted for one subtree
			// must not resolve in another, and the child is a run, so `("run", childRunId)` is the
			// boundary that already exists for a run with no claw.
			const container = { containerKind: "run", containerId: id } as const;

			// EDGE FIRST. See the header — this ordering is the whole recoverability argument.
			try {
				await store.createEdge({
					id,
					parentRunId,
					rootRunId,
					depth,
					alias,
					principal,
					containerKind: container.containerKind,
					containerId: container.containerId,
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

			// TRANSLATED, not handed over. The prompt was tokenized in the parent's container, so a
			// placeholder in it means nothing to the child: it would reach the child's tools as the
			// literal `{{pii:…}}` text, with nothing thrown. This re-mints it in the child's container.
			const childPrompt = await ctx.translate(prompt, { runId: id });

			// PINNED, so this is idempotent: a retry that already wrote the edge re-runs exactly this and
			// the run row's unique id turns the second attempt away.
			try {
				await claw.api.startRun(
					{
						prompt: childPrompt,
						// THE CLAW FOLLOWS THE TREE (D7). The door copies it off this parent — verified
						// server-side — so the child reaches policy with the `clawId` fact PRESENT.
						// Absent, an unguarded `forbid` written against it base-errors and is SKIPPED,
						// which fails open on exactly the runs nobody is watching.
						parentRunId,
						// Lineage for gates, as `ctx` — convenience, not the record. The tables are the
						// truth; nothing added to the run row, because `createRun` enumerates its fields
						// and silently drops the rest.
						ctx: { agentParentRunId: parentRunId, agentAlias: alias },
						run: { id },
					},
					// The parent's authority, COPIED. Never a parameter.
					{ principal },
				);
			} catch (error) {
				// The run already exists — this spawn's own retry, verified above by the edge check that
				// let us get here. Starting it twice is what the pinned id makes impossible.
				if (!isConflict(error)) throw error;
			}
			return { childRunId: id };
		},

		async status() {
			const { runId: parentRunId } = requireRun();
			const edges = await store.children(parentRunId);
			const out: AgentChildStatus[] = [];
			for (const edge of edges) {
				const run = await claw.api.getRun({ id: edge.id });
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
