// The two tables' reads and writes, behind one port — so the capability never holds an adapter and
// the tests can drive the same shape the plugin wires.

import type { Adapter, Principal } from "@busyclaw/contracts";
import { isConflict } from "@busyclaw/contracts";
import { entityView } from "@busyclaw/storage-core";
import {
	agentEdgeFields,
	agentLinkFields,
	agentLinkId,
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
	/** Resolve an alias the OWNER was introduced under. `null` ⇒ this run may not name that peer. */
	resolve: (
		ownerRunId: string,
		alias: string,
	) => Promise<{ peerRunId: string; relation: string } | null>;
};

export function createSubagentStore(adapter: Adapter): SubagentStore {
	const db = entityView(adapter, {
		agent_edge: { fields: agentEdgeFields },
		agent_link: { fields: agentLinkFields },
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
	};
}
