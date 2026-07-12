// createTeamStore — invite-based team membership over the @euroclaw/storage-core Adapter. The sibling
// of createApprovalStore: `invite` opens a pending invite, `accept` consumes it (single-use, via the
// atomic consumeOne primitive) and creates a member. `roleOf` is what a claw's
// `roleMembership({ roleOf })` calls to resolve the actor's role on a team → which authz then reads.

import type { Adapter } from "@euroclaw/contracts";
import { type EntityWhere, entityDb } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import {
	teamInviteEntity,
	type teamInviteRecord,
	teamMemberEntity,
	type teamMemberRecord,
} from "./schema";

// The row shapes ARE the team entities' own arktype records — one source of truth shared with the
// schema/migration declarations. Reads are untrusted boundary data (rows from any adapter back this
// store) and feed authz role resolution, so every row the entity layer returns has been PARSED
// through these, never cast.
export type TeamMember = typeof teamMemberRecord.infer;
export type TeamInvite = typeof teamInviteRecord.infer;

export type TeamStore = {
	/** Open a pending invite to a team, with a role. */
	invite: (input: {
		team: string;
		email: string;
		role: string;
	}) => Promise<TeamInvite>;
	/** Accept an invite (single-use) → become a member. Returns the membership, or null if it's gone. */
	accept: (inviteId: string, userId: string) => Promise<TeamMember | null>;
	/** List a team's members. */
	members: (team: string) => Promise<TeamMember[]>;
	/** The actor's role on a team, or null if not a member — what `roleMembership({ roleOf })` calls. */
	roleOf: (team: string, userId: string) => Promise<string | null>;
	/** Revoke a member's access to a team. */
	remove: (team: string, userId: string) => Promise<void>;
};

export type TeamStoreOptions = { now?: () => string };

const newId = (): string => bytesToHex(randomBytes(16));

type MemberWhere = EntityWhere<(typeof teamMemberEntity)["fields"]>;

export function createTeamStore(
	adapter: Adapter,
	options: TeamStoreOptions = {},
): TeamStore {
	const now = options.now ?? (() => new Date().toISOString());
	// Persist through the entity-validating adapter like every sibling store — logical names, decode
	// normalization (SQL NULL → absent), immutable enforcement, rows parsed on every read.
	const db = entityDb(adapter, {
		team_member: teamMemberEntity,
		team_invite: teamInviteEntity,
	});
	const memberWhere = (team: string, userId: string): MemberWhere[] => [
		{ field: "team", value: team },
		{ field: "userId", value: userId, connector: "AND" },
	];

	return {
		async invite({ team, email, role }) {
			const invite: TeamInvite = {
				id: newId(),
				team,
				email,
				role,
				createdAt: now(),
			};
			await db.create({ model: "team_invite", data: invite });
			return invite;
		},

		async accept(inviteId, userId) {
			// Single-use: atomically consume the invite, then create the membership.
			const invite = await db.consumeOne({
				model: "team_invite",
				where: [{ field: "id", value: inviteId }],
			});
			if (!invite) return null;
			const member: TeamMember = {
				id: newId(),
				team: invite.team,
				userId,
				role: invite.role,
				joinedAt: now(),
			};
			await db.create({ model: "team_member", data: member });
			return member;
		},

		async members(team) {
			return db.findMany({
				model: "team_member",
				where: [{ field: "team", value: team }],
			});
		},

		async roleOf(team, userId) {
			const row = await db.findOne({
				model: "team_member",
				where: memberWhere(team, userId),
			});
			return row ? row.role : null;
		},

		async remove(team, userId) {
			await db.delete({
				model: "team_member",
				where: memberWhere(team, userId),
			});
		},
	};
}
