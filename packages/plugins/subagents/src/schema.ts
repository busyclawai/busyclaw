// The plugin's five tables, and the ids that fence them. Two are written by a spawn (the edge and the
// address book); three by a parent that stops to wait (the barrier, its arrivals, and the park).
//
// EVERY UNIQUENESS FENCE HERE IS A HASHED NUL-JOINED NATURAL KEY IN `id`, never a `uniques: [[…]]`
// declaration. A plugin model's `uniques` never reach a generator, so declaring one is worse than
// omitting it: it reads as enforcement that will not exist, and a race writes two rows for one alias
// while the schema says that cannot happen. An id, by contrast, is a primary key the database
// arbitrates.
//
// The NUL join and its escape follow the channels inbox, and for the same reason: a `deliveryId` or
// an alias is somebody else's string and may hold whatever separator looked safe. Under a printable
// one, `("a b", "c")` and `("a", "b c")` hash alike — two different children sharing a row. Written
// as the escape rather than a literal NUL because a source file carrying a raw NUL is BINARY to git,
// and every diff of it reads "Binary files differ".

import { type EntityField, entity, field } from "@busyclaw/contracts";
import { bytesToHex, sha256, utf8ToBytes } from "./hash";

/**
 * One row per child. The primary key IS the child's run id.
 *
 * That is the whole containment argument: one row per child means exactly one parent, so a second
 * parent and a cycle are UNREPRESENTABLE rather than validated against. `rootRunId` is denormalized
 * onto every edge so "cancel the subtree" and "forget the subtree" are one indexed query instead of
 * a recursive walk over a tree whose depth nothing bounds at read time.
 */
export const agentEdgeFields = {
	/** = childRunId. Derived, so the edge knows its own primary key before `startRun` is called — which
	 *  is what makes the edge-first write order possible. */
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	parentRunId: field.string({ required: true, index: true, immutable: true }),
	rootRunId: field.string({ required: true, index: true, immutable: true }),
	depth: field.number({ required: true, immutable: true }),
	/** The parent's local name for this child. Model-facing surfaces address by alias, never by run
	 *  id — a run may only speak to peers it was introduced to. */
	alias: field.string({ required: true, immutable: true }),
	/**
	 * COPIED from the parent's resolved authority, never named by anyone (D7).
	 *
	 * The child's `run.principal` is what the tool floor reads, so a spawn that could name it would be
	 * a privilege-escalation primitive. Recorded here as well as on the run because the conflict
	 * branch of a derived-id collision has to ask "is this genuinely my retry, or somebody squatting
	 * on an id they guessed" — and the answer needs both this and the `(parentRunId, alias)` pair.
	 */
	principal: field.string({ required: true, index: true, immutable: true }),
	/** The parent's config scope — the tenancy anchor the `run` row has no column for. Recorded, not
	 *  yet enforced: the configScope-drift refusal is slice 7. */
	scope: field.string({ index: true, immutable: true }),
	scopeId: field.string({ index: true, immutable: true }),
	/** WHERE the child's placeholders live, recorded so erasure can find a container that belongs to a
	 *  run nobody is holding a reference to any more. */
	containerKind: field.string({ required: true, immutable: true }),
	containerId: field.string({ required: true, immutable: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const agentEdgeEntity = entity("agent_edge", agentEdgeFields);

/**
 * The address book: who a run is allowed to name, and under what alias.
 *
 * A spawn writes two rows — parent→child under the caller's chosen alias, and child→parent under the
 * reserved alias `parent`. A run may address only peers it was introduced to, which makes lateral
 * child↔child traffic something somebody decided rather than a consequence of sharing a tree.
 */
export const agentLinkFields = {
	/** = sha256(ownerRunId ‖ NUL ‖ alias). The fence: one alias per owner, arbitrated by the database. */
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	ownerRunId: field.string({ required: true, index: true, immutable: true }),
	alias: field.string({ required: true, immutable: true }),
	peerRunId: field.string({ required: true, index: true, immutable: true }),
	relation: field.enum(["child", "parent", "peer"] as const, {
		required: true,
		immutable: true,
	}),
	rootRunId: field.string({ required: true, index: true, immutable: true }),
	createdBy: field.string({ required: true, immutable: true }),
	createdAt: field.string({ required: true, immutable: true }),
} as const;

export const agentLinkEntity = entity("agent_link", agentLinkFields);

/**
 * The barrier: how many children a parent is waiting for, and whether that number has arrived.
 *
 * `threshold` rather than "wait for all", because `all`, `any` and `k-of-n` are the same question
 * asked with different numbers, and a boolean would have to grow a second column the first time
 * somebody wanted `any`.
 */
export const agentJoinFields = {
	/** = sha256(ownerRunId ‖ NUL ‖ waitId). Derived so an arm that crashed halfway re-derives its own
	 *  join instead of opening a second one beside it. */
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	ownerRunId: field.string({ required: true, index: true, immutable: true }),
	/** The token the parked run carries out. What a waker presents, and the only name the runtime
	 *  knows this barrier by. */
	waitId: field.string({ required: true, index: true, immutable: true }),
	/** How many children this join names. Recorded so the reconciler knows what it is looking for
	 *  without re-deriving the parent's intent from the arrivals it happens to find. */
	expected: field.number({ required: true, immutable: true }),
	/** How many must arrive: all ⇒ expected, any ⇒ 1, k ⇒ k. */
	threshold: field.number({ required: true, immutable: true }),
	status: field.enum(
		["waiting", "fired", "timed_out", "cancelled"] as const,
		{ required: true, index: true },
	),
	/**
	 * REQUIRED, and the schema is where that gets enforced rather than the caller.
	 *
	 * `maxAttempts` defaults to 1, so a child whose process dies dead-letters, never retries, and
	 * writes no arrival. A parent that could wait forever is the default failure of this whole
	 * architecture — not an edge case — so the row must not be able to express one.
	 */
	deadlineAt: field.string({ required: true, index: true, immutable: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const agentJoinEntity = entity("agent_join", agentJoinFields);

/**
 * One child landed. The row IS the counter.
 *
 * A counter column would need `$inc`, which the update patch has no arithmetic for and Mongo's
 * `assertUpdateKeys` blocks outright. CAS-on-the-counter is expressible but costs two round trips per
 * attempt and O(N) retries under simultaneous completion — worse in exactly the regime that provokes
 * it. Counting rows is exact and portable, and the primary key makes redelivery free.
 */
export const agentJoinArrivalFields = {
	/** = sha256(joinId ‖ NUL ‖ childRunId). THE IDEMPOTENCE FENCE: the fast path and the reconciler
	 *  both record arrivals, and they routinely record the same one. */
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	joinId: field.string({ required: true, index: true, immutable: true }),
	childRunId: field.string({ required: true, index: true, immutable: true }),
	/**
	 * How the child ended. Recorded because the parent has to be able to tell "it answered" from "it
	 * died", and by the time the parent reads this the run row may have been pruned.
	 *
	 * The child's TEXT is deliberately not copied here. It lives in the child's thread, behind
	 * `listMessages` — a door that already audits and `view`-gates. A copy would be a second home for
	 * tokenized content in a table with no `pii` annotation on it.
	 */
	outcome: field.enum(
		["completed", "failed", "cancelled", "timed_out"] as const,
		{ required: true, immutable: true },
	),
	arrivedAt: field.string({ required: true, immutable: true }),
} as const;

export const agentJoinArrivalEntity = entity(
	"agent_join_arrival",
	agentJoinArrivalFields,
);

/**
 * The park itself — one row per parked run, and the thing that knows how to wake it.
 *
 * `arming → armed` is what stamps `checkpointId`, because the tool that requests the wait cannot know
 * it: the loop persists the checkpoint AFTER the tool returns. The plugin's event sink learns it from
 * `run.awaiting` and completes the arm. A wait still `arming` when its join fires is not lost — the
 * reconciler resolves a checkpoint from the run itself.
 */
export const agentWaitFields = {
	/** = waitId. The token the run carries out of the loop, so the row is addressable by exactly what
	 *  a waker holds. */
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	runId: field.string({ required: true, index: true, immutable: true }),
	reason: field.enum(["children", "inbox", "paused"] as const, {
		required: true,
		immutable: true,
	}),
	joinId: field.string({ index: true, immutable: true }),
	/** Stamped by the arm, absent until then. Not `required`: the row is written by the tool, and the
	 *  checkpoint does not exist yet at that moment. */
	checkpointId: field.string({ index: true }),
	status: field.enum(["arming", "armed", "fired", "cancelled"] as const, {
		required: true,
		index: true,
	}),
	deadlineAt: field.string({ required: true, index: true, immutable: true }),
	armedAt: field.string({}),
	firedAt: field.string({}),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const agentWaitEntity = entity("agent_wait", agentWaitFields);

/** The models the plugin contributes via `plugin.schema`. */
export const subagentModels: Record<
	string,
	{ fields: Record<string, EntityField> }
> = {
	[agentEdgeEntity.name]: { fields: agentEdgeEntity.fields },
	[agentLinkEntity.name]: { fields: agentLinkEntity.fields },
	[agentJoinEntity.name]: { fields: agentJoinEntity.fields },
	[agentJoinArrivalEntity.name]: { fields: agentJoinArrivalEntity.fields },
	[agentWaitEntity.name]: { fields: agentWaitEntity.fields },
};

/**
 * The child's run id: `sha256(parentRunId ‖ NUL ‖ alias)`.
 *
 * KEYED ON THE ALIAS, and on nothing that moves. Not the spawn tool's `toolCallId` — the provider
 * assigns that, and the durable replay this derivation exists to survive is `resumeRun`, which
 * reloads the checkpoint and re-calls the tool with a NEW call id. Deriving from it would mint a
 * second child on every retry, which is the exact double-spend being prevented.
 *
 * And not the step or an ordinal within it either, though that is what this was first written as.
 * The alias already separates siblings — `agent_link` fences one alias per owner — so those two
 * added no distinctions, and the ordinal actively broke the property they were there to provide: it
 * counts per capability instance, and a capability is built per call, so a replay of the SECOND
 * spawn in a step restarts at zero and derives the FIRST child's id. A key made of things that
 * survive a replay cannot contain a counter that does not.
 *
 * So one alias is one child, per parent, for good. Re-spawning an alias derives the same id and is
 * therefore the same child — which is what makes a retry idempotent instead of a second run.
 *
 * Exactly-once, and NOT authenticated: the hash is unsalted over values a peer can often guess, and
 * `startRun` lets any authenticated principal pin a run id. So a collision is never adopted — see
 * `spawnChild`, which loads the existing row and refuses unless it is genuinely this spawn's retry.
 */
export function childRunId(input: {
	parentRunId: string;
	alias: string;
}): string {
	return bytesToHex(
		sha256(utf8ToBytes(`${input.parentRunId}\u0000${input.alias}`)),
	);
}

/**
 * The child's THREAD id, derived from its run.
 *
 * Idempotent for the same reason the run id is: a spawn that crashed between opening the thread and
 * starting the run re-runs both, and a second thread would leave the first orphaned in the claw with
 * nothing able to say which one the child writes to.
 */
export function childThreadId(childRunId: string): string {
	return bytesToHex(sha256(utf8ToBytes(`thread\u0000${childRunId}`)));
}

/** The address-book row id — one alias per owner. */
export function agentLinkId(ownerRunId: string, alias: string): string {
	return bytesToHex(sha256(utf8ToBytes(`${ownerRunId}\u0000${alias}`)));
}

/**
 * The wait token a parked run carries out: `sha256(runId ‖ NUL ‖ step)`.
 *
 * KEYED ON THE STEP, which is replay-stable — a resumed run re-enters the loop at the step its
 * checkpoint named, so an `await` re-called in that step derives the wait it already armed rather
 * than a second one. A random token would mint a fresh wait per attempt and leave the first armed,
 * parked against a checkpoint nothing is going to resume.
 */
export function agentWaitId(input: { runId: string; step: number }): string {
	return bytesToHex(
		sha256(utf8ToBytes(`wait\u0000${input.runId}\u0000${input.step}`)),
	);
}

/** The barrier's id — one join per wait, derived so a half-written arm re-derives its own. */
export function agentJoinId(ownerRunId: string, waitId: string): string {
	return bytesToHex(sha256(utf8ToBytes(`${ownerRunId}\u0000${waitId}`)));
}

/** The arrival fence — one row per (join, child), whichever path records it. */
export function agentArrivalId(joinId: string, childRunId: string): string {
	return bytesToHex(sha256(utf8ToBytes(`${joinId}\u0000${childRunId}`)));
}

/** The alias a child always knows its parent by. Reserved: a spawn may not claim it. */
export const PARENT_ALIAS = "parent";
