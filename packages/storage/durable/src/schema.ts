// The tables busyclaw's durable stores need, re-exported from @busyclaw/contracts so a host wiring
// storage has one import for them. This module declares none of its own: every durable store here
// backs a CONTRACTS entity, which is where the shapes and their invariants live.
//
// (It used to declare the team tables too. Membership storage left core with them — a boundary is a
// plugin's concept, so the plugin owns the rows. See `principalMemberships` in @busyclaw/runtime.)

export {
	approvalSchema,
	effectSchema,
	piiMappingSchema,
	runCheckpointSchema,
} from "@busyclaw/contracts";
