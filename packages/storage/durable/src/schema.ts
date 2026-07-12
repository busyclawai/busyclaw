// The table euroclaw's durable stores need, in the declarative SchemaDeclaration format the
// `generate` CLI turns into migrations. Bare, snake_case, singular names (better-auth's
// convention — no global prefix); override a physical name per-table via `modelName` if it
// collides with a host-app table. `id` is the unique required key consumeOne deletes by.

import type { SchemaDeclaration } from "@euroclaw/contracts";
import {
	approvalSchema,
	effectSchema,
	entity,
	field,
	piiMappingSchema,
	runCheckpointSchema,
} from "@euroclaw/contracts";

export const teamMemberEntity = entity("team_member", {
	id: field.string({ required: true, unique: true }),
	team: field.string({ required: true, index: true }),
	userId: field.string({ required: true, index: true }),
	role: field.string({ required: true }),
	joinedAt: field.string({ required: true }),
} as const);

export const teamInviteEntity = entity("team_invite", {
	id: field.string({ required: true, unique: true }),
	team: field.string({ required: true, index: true }),
	email: field.string({ required: true, pii: "possible" }),
	role: field.string({ required: true }),
	createdAt: field.string({ required: true }),
} as const);

/** The team row validators — the single source createTeamStore parses every read through. */
export const teamMemberRecord = teamMemberEntity.record;
export const teamInviteRecord = teamInviteEntity.record;

/** The tables backing the native team store (createTeamStore): members + pending invites. */
export const teamSchema = {
	...teamMemberEntity.storage,
	...teamInviteEntity.storage,
} satisfies SchemaDeclaration;

export { approvalSchema, effectSchema, piiMappingSchema, runCheckpointSchema };
