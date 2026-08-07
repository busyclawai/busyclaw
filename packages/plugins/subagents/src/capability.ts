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
import { arrivalOutcome, settleIfMet } from "./join";
import {
	agentJoinId,
	agentWaitId,
	childRunId,
	childThreadId,
	PARENT_ALIAS,
} from "./schema";
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
	/**
	 * Ask a run to stop. OPTIONAL, because the shape is structural and a test double need not have it.
	 *
	 * The intent is LATCHED, not applied: a run with nothing in flight settles synchronously, a running
	 * one stops at its next control point. So `accepted` means "there was something to stop", never
	 * "it has stopped" — the distinction the engine's own result type is careful about.
	 */
	controlRun?: (input: {
		runId: string;
		intent: "suspend" | "stop" | "abort";
		requestedBy?: Principal;
		reason?: string;
	}) => Promise<{ accepted: boolean; settled: boolean }>;
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

/** The transcript reader, narrowed to the one question a join asks: what did this child answer. */
export type SpawnMessages = {
	listForThread: (input: {
		threadId: string;
		runId?: string;
		limit?: number;
	}) => Promise<readonly { role: string; content: unknown }[]>;
};

/** What the stamped tool receives under the name it asked for. */
export type AgentCapability = {
	spawnChild: (input: {
		alias: string;
		prompt: string;
	}) => Promise<{ childRunId: string }>;
	status: () => Promise<readonly AgentChildStatus[]>;
	/**
	 * Wait for children, and park the run if they are not done.
	 *
	 * TWO OUTCOMES, and the caller cannot tell which it will get: `settled` when the results were
	 * already there (the run keeps going, having spent one tool call), `waiting` when it parked. That
	 * asymmetry is deliberate — a model asking "are they done" and a model asking "wait for them" is
	 * the same question, and making it one call means the answer cannot be raced between them.
	 */
	awaitChildren: (input: {
		aliases?: readonly string[];
		mode?: "all" | "any";
	}) => Promise<AgentAwaitResult>;
};

export type AgentAwaitResult =
	| { status: "settled"; results: readonly AgentChildResult[] }
	| { status: "waiting"; waitId: string; pending: readonly string[] };

export type AgentChildResult = {
	alias: string;
	childRunId: string;
	/** How the run ended, as recorded at arrival — the run row may be gone by now. */
	outcome: string;
	/** The child's last words, read from its own thread. Absent for a child that never got to speak
	 *  (a crash, a denial) — which is exactly when `outcome` is the part that matters. */
	text?: string;
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
	messages?: SpawnMessages;
	store: SubagentStore;
	limits: SpawnLimits;
	/** How long a parent may wait before the reconciler gives up on it and wakes it with what landed.
	 *  Required by the schema, so there is no shape in which a parent waits forever. */
	joinTimeoutMs: number;
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

		async awaitChildren({ aliases, mode }) {
			const { runId: parentRunId } = requireRun();
			// Named aliases, or every child this run has. `children` rather than `agent_link`, because a
			// link is an introduction and an edge is parenthood: a run may be introduced to a sibling it
			// has no business waiting on, and "wait for everyone I know" is not what `await` means.
			const edges = await store.children(parentRunId);
			const chosen =
				aliases === undefined || aliases.length === 0
					? edges
					: edges.filter((edge) => aliases.includes(edge.alias));
			if (chosen.length === 0) {
				throw stateError("there is nothing to wait for", {
					reason:
						aliases === undefined || aliases.length === 0
							? "this run has no children"
							: `no child of this run is called ${aliases.join(", ")}`,
				});
			}
			// REFUSED WITHOUT A LOOP TO PARK. A capability that armed a wait it could not park would
			// leave a durable row nobody will ever answer, and the run would carry on as if it had asked
			// for nothing — the worst of both.
			if (ctx.requestAwait === undefined || ctx.step === undefined) {
				throw stateError("this run cannot wait", {
					reason:
						"waiting means parking, and this invocation has no loop to park (an ad-hoc generate)",
				});
			}

			const waitId = agentWaitId({ runId: parentRunId, step: ctx.step });
			const joinId = agentJoinId(parentRunId, waitId);
			const stamp = input.now();
			const threshold = mode === "any" ? 1 : chosen.length;

			// THE JOIN FIRST, because an arrival names one — and it is derived, so a retry of this exact
			// step re-opens the join it already had rather than a second one beside it.
			const join = await store.openJoin({
				id: joinId,
				ownerRunId: parentRunId,
				waitId,
				expected: chosen.length,
				threshold,
				// The schema will not hold a row without one. A parent that could wait forever is this
				// architecture's default failure, not an edge case.
				deadlineAt: new Date(
					Date.parse(stamp) + input.joinTimeoutMs,
				).toISOString(),
				now: stamp,
			});

			// ALREADY SETTLED, and this is the path a resumed parent takes. It re-enters the step its
			// checkpoint named and calls `await` again; the id is derived from (run, step), so it finds
			// the barrier that WOKE it. Parking on that is the waiter-nobody-wakes case in its most
			// ordinary form — the thing that would have sent the wake already sent it.
			//
			// Checked before anything else touches the barrier, because everything below assumes it is
			// still open: recording arrivals into a fired join is noise, and `settleIfMet` correctly
			// refuses to settle it twice — which is exactly what read as "not ready, park again".
			if (join.status !== "waiting") {
				return { status: "settled", results: await results(joinId, edges) };
			}

			// WHAT HAS ALREADY LANDED. Children finish while the parent is thinking, and a run that
			// parked for results it already had would wait for a wake nobody is going to send: the sink
			// fires on the transition, and these already happened.
			for (const edge of chosen) {
				const run = await engine.runs?.get(edge.id);
				const outcome =
					run === null || run === undefined
						? // No run behind the edge. Either it was pruned or the spawn crashed between the
							// edge and `startRun` — and both mean nothing is ever going to complete it, so
							// counting it as failed is what stops the parent hanging on a child that does not
							// exist.
							("failed" as const)
						: arrivalOutcome(run.status);
				if (outcome === null) continue;
				await store.recordArrival({
					joinId,
					childRunId: edge.id,
					outcome,
					now: stamp,
				});
			}

			// SETTLE BEFORE PARKING, which is the synchronous return: if the threshold is already met,
			// this fires the join and there is nothing to wait for. `woke` is false — there is no park
			// yet — and that is the point.
			const settled = await settleIfMet({
				store,
				engine,
				joinId,
				now: stamp,
			});
			if (settled.settled) {
				return { status: "settled", results: await results(joinId, edges) };
			}

			// PARK. The wait row goes down BEFORE the request, so a crash between them leaves a durable
			// row the reconciler can find rather than a parked run nothing knows about.
			await store.openWait({
				id: waitId,
				runId: parentRunId,
				reason: "children",
				joinId,
				deadlineAt: new Date(
					Date.parse(stamp) + input.joinTimeoutMs,
				).toISOString(),
				now: stamp,
			});
			ctx.requestAwait(waitId);

			const arrived = new Set(
				(await store.arrivals(joinId)).map((a) => a.childRunId),
			);
			return {
				status: "waiting",
				waitId,
				pending: chosen
					.filter((edge) => !arrived.has(edge.id))
					.map((edge) => edge.alias),
			};
		},
	};

	/** What each arrived child said, read from its own thread rather than copied at arrival. */
	async function results(
		joinId: string,
		edges: readonly { id: string; alias: string }[],
	): Promise<readonly AgentChildResult[]> {
		const byRun = new Map(edges.map((edge) => [edge.id, edge.alias]));
		const out: AgentChildResult[] = [];
		for (const arrival of await store.arrivals(joinId)) {
			const text = await lastAssistantText(arrival.childRunId);
			out.push({
				alias: byRun.get(arrival.childRunId) ?? arrival.childRunId,
				childRunId: arrival.childRunId,
				outcome: arrival.outcome,
				...(text !== undefined ? { text } : {}),
			});
		}
		return out;
	}

	/**
	 * The child's last words.
	 *
	 * From the child's THREAD, not from the arrival row and not from the run's events. The thread is a
	 * door that already audits and `view`-gates; copying the text onto the arrival would put tokenized
	 * content in a second table with no `pii` annotation, and the run's `run.completed` payload is
	 * allowlisted precisely so it does not serve content.
	 */
	async function lastAssistantText(
		childRunId: string,
	): Promise<string | undefined> {
		const rows = await input.messages?.listForThread({
			threadId: childThreadId(childRunId),
			runId: childRunId,
		});
		if (rows === undefined) return undefined;
		for (let i = rows.length - 1; i >= 0; i -= 1) {
			const row = rows[i];
			if (row?.role !== "assistant") continue;
			return typeof row.content === "string"
				? row.content
				: JSON.stringify(row.content);
		}
		return undefined;
	}
}
