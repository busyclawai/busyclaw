// The approval CONTRACTS: the ApprovalStore port + the approval record schema for durable,
// single-use human approvals. NO storage import (the port is behaviour-only; the SQL-backed impl is
// @euroclaw/storage-durable). The approval after-gate that persists needs-approval outcomes lives in
// @euroclaw/core. See docs/architecture/07-approval-and-audit.md.

import { type } from "arktype";
import type { JsonObject as JsonObjectType } from "../common";
import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";
import type { HandleResult, ToolCall, TurnContext } from "./boundary";
import type { Principal } from "./principal";

const approvalStatusValues = [
	"pending",
	"approved",
	"denied",
	"consumed",
] as const;

export const approvalStatus = type(
	"'pending' | 'approved' | 'denied' | 'consumed'",
);
export type ApprovalStatus = (typeof approvalStatusValues)[number];

export const approvalFields = {
	// The request being decided (gate, tool, args, context, expiry) is fixed at create; only the
	// decision fields (status, decidedBy, reason) change.
	id: field.string({ required: true, unique: true, immutable: true }),
	status: field.enum(approvalStatusValues, { required: true }),
	gateId: field.string({ required: true, immutable: true }),
	toolName: field.string({ required: true, index: true, immutable: true }),
	args: field.jsonObject({ required: true, pii: "redacted", immutable: true }),
	reasonCode: field.string({ index: true, immutable: true }),
	principal: field.principal({ index: true, immutable: true }),
	reason: field.string(),
	metadata: field.jsonObject(),
	decidedBy: field.string(),
	createdAt: field.string({ required: true, immutable: true }),
	expiresAt: field.string({ index: true, immutable: true }),
} as const;

export const approvalEntity = entity("approval", approvalFields);
export const approvalRecord = approvalEntity.record;
export type ApprovalRecord = EntityRecord<typeof approvalFields>;

export const newApproval = approvalEntity.schema({
	omit: ["id", "status", "decidedBy"],
});
export type NewApproval = EntityInput<
	typeof approvalFields,
	"id" | "status" | "decidedBy"
>;

/** The storage schema backing the ApprovalStore. */
export const approvalSchema = approvalEntity.storage;

export type ApprovalMetadataResolver = (
	call: ToolCall,
	ctx: TurnContext,
	outcome: Extract<HandleResult, { status: "needs-approval" }>,
) => JsonObjectType | undefined;

/**
 * Durable home for human approvals. The single-use guarantee is `consume`: under concurrent
 * resumes of the same approval, exactly one caller gets the record, the rest get null.
 */
export type ApprovalStore = {
	/** Open a pending approval. Returns the stored record (with its assigned `id`). */
	create: (input: NewApproval) => Promise<ApprovalRecord>;
	/** Read an approval without consuming it. */
	get: (id: string) => Promise<ApprovalRecord | null>;
	/** Mark a pending approval approved. Returns the updated record, or null if it wasn't pending. */
	grant: (id: string, by: string) => Promise<ApprovalRecord | null>;
	/** Mark a pending approval denied. Returns the updated record, or null if it wasn't pending. */
	deny: (
		id: string,
		by: string,
		reason?: string,
	) => Promise<ApprovalRecord | null>;
	/**
	 * Atomically take the single-use APPROVED record by id (race-safe). Returns null if it's absent,
	 * not approved, expired, or already consumed. This is what makes resume run exactly once.
	 */
	consume: (id: string) => Promise<ApprovalRecord | null>;
	/** List approvals, optionally filtered — the human-review queue reads `{ status: "pending" }`. */
	list: (filter?: {
		status?: ApprovalStatus;
		principal?: Principal;
	}) => Promise<ApprovalRecord[]>;
};
