// The five tables' reads and writes, behind one port — so the capability never holds an adapter and
// the tests can drive the same shape the plugin wires.
//
// Two of the writes here are COMPARE-AND-SWAP, and they are the only reason a barrier is safe:
// `settleJoin` elects the one caller that gets to wake a parked parent, and `fireWait` spends the park
// so a second waker cannot re-resume a run that already moved on. Both rest on `Adapter.update`
// returning the updated row or `null` when the `where` matched nothing.

import type { Adapter, Principal } from "@busyclaw/contracts";
import { isConflict, stateError } from "@busyclaw/contracts";
import { entityView } from "@busyclaw/storage-core";
import {
	agentArrivalId,
	agentEdgeFields,
	agentJoinArrivalFields,
	agentJoinFields,
	agentLinkFields,
	agentLinkId,
	agentWaitFields,
	PARENT_ALIAS,
} from "./schema";

export type AgentEdge = {
	id: string;
	parentRunId: string;
	rootRunId: string;
	depth: number;
	alias: string;
	principal: string;
};

export type SubagentStore = {
	/** The edge whose PK is this run — i.e. "is this run somebody's child, and whose". */
	edge: (childRunId: string) => Promise<AgentEdge | null>;
	children: (parentRunId: string) => Promise<readonly AgentEdge[]>;
	countChildren: (parentRunId: string) => Promise<number>;
	/** Throws a conflict when the id is taken — the insert IS the fence. */
	createEdge: (input: {
		id: string;
		parentRunId: string;
		rootRunId: string;
		depth: number;
		alias: string;
		principal: Principal;
		containerKind: string;
		containerId: string;
		createdAt: string;
		updatedAt: string;
	}) => Promise<void>;
	/** Both directions of one introduction, written together. */
	linkPair: (input: {
		parentRunId: string;
		childRunId: string;
		alias: string;
		rootRunId: string;
		createdBy: Principal;
		createdAt: string;
	}) => Promise<void>;
	/** Every edge under one root — the subtree, in one indexed query rather than a recursive walk. */
	tree: (rootRunId: string) => Promise<readonly AgentEdge[]>;
	/** Resolve an alias the OWNER was introduced under. `null` ⇒ this run may not name that peer. */
	resolve: (
		ownerRunId: string,
		alias: string,
	) => Promise<{ peerRunId: string; relation: string } | null>;
	/**
	 * The alias the OWNER knows this peer by — the reverse of `resolve`.
	 *
	 * A message has to arrive attributed in the RECEIVER's vocabulary. The two runs do not share one:
	 * a parent calls its child `researcher` while that child calls it `parent`, and the engine cannot
	 * bridge them because it records a `sender` PRINCIPAL and a child's authority is copied from its
	 * parent — so the two are literally the same string there.
	 */
	linkTo: (ownerRunId: string, peerRunId: string) => Promise<string | null>;

	// ── the barrier ───────────────────────────────────────────────────────────────────────────────
	/** Open a barrier, or find the one this arm already opened. Idempotent on the derived id. */
	openJoin: (input: {
		id: string;
		ownerRunId: string;
		waitId: string;
		expected: number;
		threshold: number;
		deadlineAt: string;
		now: string;
	}) => Promise<AgentJoin>;
	join: (joinId: string) => Promise<AgentJoin | null>;
	/** Every barrier still open — what the reconciler walks. */
	openJoins: (limit: number) => Promise<readonly AgentJoin[]>;
	/** The open barriers of ONE parent — what the sink asks when a child of theirs ends. Indexed on
	 *  `ownerRunId`, because the sink fires per completed run and scanning every open barrier to filter
	 *  in memory would make a busy claw's cheapest event its most expensive. */
	openJoinsForOwner: (ownerRunId: string) => Promise<readonly AgentJoin[]>;
	/** How many barriers are open in total. The reconciler's backlog, which a page of results cannot
	 *  report: fetching `limit + 1` rows only ever answers "at least one more". */
	countOpenJoins: () => Promise<number>;
	/**
	 * Record that a child landed. `false` ⇒ it was already recorded, by the other path.
	 *
	 * Both the event sink and the reconciler write arrivals, and they routinely write the same one.
	 * The primary key arbitrates; this reports which of them got there first so a caller can skip the
	 * count when there is provably nothing new to count.
	 */
	recordArrival: (input: {
		joinId: string;
		childRunId: string;
		outcome: AgentArrivalOutcome;
		now: string;
	}) => Promise<boolean>;
	countArrivals: (joinId: string) => Promise<number>;
	arrivals: (joinId: string) => Promise<readonly AgentArrival[]>;
	/**
	 * THE SINGLE-WAKER ELECTION. CAS the barrier out of `waiting`; the row means "you won", `null`
	 * means somebody else did.
	 *
	 * Rests on `Adapter.update` returning the updated row or `null` when the `where` matched nothing —
	 * see the port, where slice 4 wrote that contract down. Without it two children landing together
	 * both resume the parent from one checkpoint.
	 */
	settleJoin: (input: {
		joinId: string;
		to: "fired" | "timed_out" | "cancelled";
		now: string;
	}) => Promise<AgentJoin | null>;

	// ── the park ──────────────────────────────────────────────────────────────────────────────────
	/** Write the park row. Idempotent: a re-called `await` in the same step derives the same wait. */
	openWait: (input: {
		id: string;
		runId: string;
		reason: "children" | "inbox" | "paused";
		joinId: string;
		deadlineAt: string;
		now: string;
	}) => Promise<AgentWait>;
	wait: (waitId: string) => Promise<AgentWait | null>;
	waitForJoin: (joinId: string) => Promise<AgentWait | null>;
	/** The park a run is currently sitting in — what an inbox wake has to find, since a message names
	 *  a RUN and the wake needs the checkpoint that run parked against. `armed` only: a wait still
	 *  `arming` has no checkpoint to resume from. */
	waitForRun: (runId: string) => Promise<AgentWait | null>;
	/** The `arming → armed` transition, stamping the checkpoint the tool could not know. */
	armWait: (input: {
		waitId: string;
		checkpointId: string;
		now: string;
	}) => Promise<AgentWait | null>;
	/** Mark the park spent, so a second waker does not re-resume a run that already moved on. */
	fireWait: (input: {
		waitId: string;
		now: string;
	}) => Promise<AgentWait | null>;
};

export type AgentArrivalOutcome =
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out";

export type AgentJoin = {
	id: string;
	ownerRunId: string;
	waitId: string;
	expected: number;
	threshold: number;
	status: "waiting" | "fired" | "timed_out" | "cancelled";
	deadlineAt: string;
};

export type AgentArrival = {
	childRunId: string;
	outcome: AgentArrivalOutcome;
	arrivedAt: string;
};

export type AgentWait = {
	id: string;
	runId: string;
	joinId?: string;
	checkpointId?: string;
	status: "arming" | "armed" | "fired" | "cancelled";
	deadlineAt: string;
};

export function createSubagentStore(adapter: Adapter): SubagentStore {
	const db = entityView(adapter, {
		agent_edge: { fields: agentEdgeFields },
		agent_link: { fields: agentLinkFields },
		agent_join: { fields: agentJoinFields },
		agent_join_arrival: { fields: agentJoinArrivalFields },
		agent_wait: { fields: agentWaitFields },
	});

	const asEdge = (row: {
		id: string;
		parentRunId: string;
		rootRunId: string;
		depth: number;
		alias: string;
		principal: string;
	}): AgentEdge => ({
		id: row.id,
		parentRunId: row.parentRunId,
		rootRunId: row.rootRunId,
		depth: row.depth,
		alias: row.alias,
		principal: row.principal,
	});

	const asJoin = (row: {
		id: string;
		ownerRunId: string;
		waitId: string;
		expected: number;
		threshold: number;
		status: string;
		deadlineAt: string;
	}): AgentJoin => ({
		id: row.id,
		ownerRunId: row.ownerRunId,
		waitId: row.waitId,
		expected: row.expected,
		threshold: row.threshold,
		status: row.status as AgentJoin["status"],
		deadlineAt: row.deadlineAt,
	});

	const asWait = (row: {
		id: string;
		runId: string;
		joinId?: string;
		checkpointId?: string;
		status: string;
		deadlineAt: string;
	}): AgentWait => ({
		id: row.id,
		runId: row.runId,
		...(row.joinId !== undefined ? { joinId: row.joinId } : {}),
		...(row.checkpointId !== undefined
			? { checkpointId: row.checkpointId }
			: {}),
		status: row.status as AgentWait["status"],
		deadlineAt: row.deadlineAt,
	});

	return {
		async edge(childRunId) {
			const row = await db.findOne({
				model: "agent_edge",
				where: [{ field: "id", value: childRunId }],
			});
			return row === null ? null : asEdge(row);
		},

		async children(parentRunId) {
			const rows = await db.findMany({
				model: "agent_edge",
				where: [{ field: "parentRunId", value: parentRunId }],
				sortBy: { field: "createdAt", direction: "asc" },
			});
			return rows.map(asEdge);
		},

		async tree(rootRunId) {
			// `rootRunId` is denormalized onto every edge at spawn precisely so this is one indexed
			// read at any depth, rather than a walk over a tree whose depth nothing bounds at read
			// time.
			const rows = await db.findMany({
				model: "agent_edge",
				where: [{ field: "rootRunId", value: rootRunId }],
				sortBy: { field: "createdAt", direction: "asc" },
			});
			return rows.map(asEdge);
		},

		async countChildren(parentRunId) {
			// Counted in the DATABASE. A JS integer would be per-process, and a parent resumed in
			// another worker has no memory of what it spawned before the park.
			return db.count({
				model: "agent_edge",
				where: [{ field: "parentRunId", value: parentRunId }],
			});
		},

		async createEdge(input) {
			await db.create({ model: "agent_edge", data: input });
		},

		async linkPair(input) {
			const rows = [
				{
					id: agentLinkId(input.parentRunId, input.alias),
					ownerRunId: input.parentRunId,
					alias: input.alias,
					peerRunId: input.childRunId,
					relation: "child" as const,
					rootRunId: input.rootRunId,
					createdBy: input.createdBy,
					createdAt: input.createdAt,
				},
				{
					id: agentLinkId(input.childRunId, PARENT_ALIAS),
					ownerRunId: input.childRunId,
					alias: PARENT_ALIAS,
					peerRunId: input.parentRunId,
					relation: "parent" as const,
					rootRunId: input.rootRunId,
					createdBy: input.createdBy,
					createdAt: input.createdAt,
				},
			];
			for (const data of rows) {
				try {
					await db.create({ model: "agent_link", data });
				} catch (error) {
					// A retry re-derives the same two ids, so a conflict here IS the retry. Swallowed only
					// for that: the edge check upstream has already established this is the same spawn.
					if (!isConflict(error)) throw error;
				}
			}
		},

		async resolve(ownerRunId, alias) {
			const row = await db.findOne({
				model: "agent_link",
				where: [{ field: "id", value: agentLinkId(ownerRunId, alias) }],
			});
			return row === null
				? null
				: { peerRunId: row.peerRunId, relation: row.relation };
		},

		async linkTo(ownerRunId, peerRunId) {
			const row = await db.findOne({
				model: "agent_link",
				where: [
					{ field: "ownerRunId", value: ownerRunId },
					{ field: "peerRunId", value: peerRunId, connector: "AND" },
				],
			});
			return row === null ? null : row.alias;
		},

		async openJoin(input) {
			try {
				const row = await db.create({
					model: "agent_join",
					data: {
						id: input.id,
						ownerRunId: input.ownerRunId,
						waitId: input.waitId,
						expected: input.expected,
						threshold: input.threshold,
						status: "waiting",
						deadlineAt: input.deadlineAt,
						createdAt: input.now,
						updatedAt: input.now,
					},
				});
				return asJoin(row);
			} catch (error) {
				if (!isConflict(error)) throw error;
				// The id is derived from (owner, wait), so a conflict is this arm arriving twice — a
				// re-called `await` in the same step, or a retry of the one that crashed before parking.
				const existing = await db.findOne({
					model: "agent_join",
					where: [{ field: "id", value: input.id }],
				});
				if (existing === null) {
					throw stateError("join vanished between insert and read", {
						joinId: input.id,
					});
				}
				return asJoin(existing);
			}
		},

		async join(joinId) {
			const row = await db.findOne({
				model: "agent_join",
				where: [{ field: "id", value: joinId }],
			});
			return row === null ? null : asJoin(row);
		},

		async openJoins(limit) {
			const rows = await db.findMany({
				model: "agent_join",
				where: [{ field: "status", value: "waiting" }],
				sortBy: { field: "createdAt", direction: "asc" },
				limit,
			});
			return rows.map(asJoin);
		},

		async openJoinsForOwner(ownerRunId) {
			const rows = await db.findMany({
				model: "agent_join",
				where: [
					{ field: "ownerRunId", value: ownerRunId },
					{ field: "status", value: "waiting", connector: "AND" },
				],
				sortBy: { field: "createdAt", direction: "asc" },
			});
			return rows.map(asJoin);
		},

		async countOpenJoins() {
			return db.count({
				model: "agent_join",
				where: [{ field: "status", value: "waiting" }],
			});
		},

		async recordArrival(input) {
			try {
				await db.create({
					model: "agent_join_arrival",
					data: {
						id: agentArrivalId(input.joinId, input.childRunId),
						joinId: input.joinId,
						childRunId: input.childRunId,
						outcome: input.outcome,
						arrivedAt: input.now,
					},
				});
				return true;
			} catch (error) {
				// ALREADY RECORDED, by whichever path saw the child finish first. The primary key is the
				// fence; this is the fence doing its job, not a failure.
				if (!isConflict(error)) throw error;
				return false;
			}
		},

		async countArrivals(joinId) {
			return db.count({
				model: "agent_join_arrival",
				where: [{ field: "joinId", value: joinId }],
			});
		},

		async arrivals(joinId) {
			const rows = await db.findMany({
				model: "agent_join_arrival",
				where: [{ field: "joinId", value: joinId }],
				sortBy: { field: "arrivedAt", direction: "asc" },
			});
			return rows.map((row) => ({
				childRunId: row.childRunId,
				outcome: row.outcome,
				arrivedAt: row.arrivedAt,
			}));
		},

		async settleJoin(input) {
			// THE CAS. `status: "waiting"` in the WHERE is the whole election — exactly one caller sees a
			// row back, everyone else sees `null` and stops. Two children landing in the same millisecond
			// is the case this exists for, and it is the case a read-then-write would get wrong.
			const row = await db.update({
				model: "agent_join",
				where: [
					{ field: "id", value: input.joinId },
					{ field: "status", value: "waiting", connector: "AND" },
				],
				update: { status: input.to, updatedAt: input.now },
			});
			return row === null ? null : asJoin(row);
		},

		async openWait(input) {
			try {
				const row = await db.create({
					model: "agent_wait",
					data: {
						id: input.id,
						runId: input.runId,
						reason: input.reason,
						joinId: input.joinId,
						status: "arming",
						deadlineAt: input.deadlineAt,
						createdAt: input.now,
						updatedAt: input.now,
					},
				});
				return asWait(row);
			} catch (error) {
				if (!isConflict(error)) throw error;
				const existing = await db.findOne({
					model: "agent_wait",
					where: [{ field: "id", value: input.id }],
				});
				if (existing === null) {
					throw stateError("wait vanished between insert and read", {
						waitId: input.id,
					});
				}
				return asWait(existing);
			}
		},

		async wait(waitId) {
			const row = await db.findOne({
				model: "agent_wait",
				where: [{ field: "id", value: waitId }],
			});
			return row === null ? null : asWait(row);
		},

		async waitForJoin(joinId) {
			const row = await db.findOne({
				model: "agent_wait",
				where: [{ field: "joinId", value: joinId }],
			});
			return row === null ? null : asWait(row);
		},

		async waitForRun(runId) {
			const row = await db.findOne({
				model: "agent_wait",
				where: [
					{ field: "runId", value: runId },
					{ field: "status", value: "armed", connector: "AND" },
				],
			});
			return row === null ? null : asWait(row);
		},

		async armWait(input) {
			// CONDITIONAL on `arming`, so a `run.awaiting` redelivered after the wait already fired cannot
			// walk it backwards and hand a spent park a fresh checkpoint.
			const row = await db.update({
				model: "agent_wait",
				where: [
					{ field: "id", value: input.waitId },
					{ field: "status", value: "arming", connector: "AND" },
				],
				update: {
					status: "armed",
					checkpointId: input.checkpointId,
					armedAt: input.now,
					updatedAt: input.now,
				},
			});
			return row === null ? null : asWait(row);
		},

		async fireWait(input) {
			// Either state is a legal thing to fire from: `armed` is the ordinary case, and `arming` is
			// the race where every child finished before the parent's checkpoint was even written.
			const row = await db.update({
				model: "agent_wait",
				where: [
					{ field: "id", value: input.waitId },
					{
						field: "status",
						value: ["arming", "armed"],
						operator: "in",
						connector: "AND",
					},
				],
				update: { status: "fired", firedAt: input.now, updatedAt: input.now },
			});
			return row === null ? null : asWait(row);
		},
	};
}
