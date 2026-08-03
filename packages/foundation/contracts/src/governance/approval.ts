// The approval CONTRACTS: the ApprovalStore port + the approval record schema for durable,
// single-use human approvals. NO storage import (the port is behaviour-only; the SQL-backed impl is
// @busyclaw/storage-durable). The approval after-gate that persists needs-approval outcomes lives in
// @busyclaw/core. See docs/architecture/07-approval-and-audit.md.

import { type } from "arktype";
import type { JsonObject as JsonObjectType } from "../common";
import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";
import type { HandleResult, ToolCall, TurnContext } from "./boundary";
import { type GateDemand, gateDemand } from "./boundary";
import type { Principal } from "./principal";

// The lifecycle of a granted approval, as a state machine rather than a flag.
//
// `consumed` used to be the whole story after `approved`, and it conflated two states that behave
// oppositely: "somebody is running this right now" and "this is finished". Resume accepted a consumed
// record and re-entered the model loop, so a granted approval was replayable without limit — each
// replay minting new tool-call ids and new effects. Splitting the two makes the difference expressible:
// `executing` holds a LEASE (one runner at a time, recoverable only once it lapses) and `completed`
// holds the terminal RESULT (served back, never re-run).
const approvalStatusValues = [
	"pending",
	"approved",
	"denied",
	"executing",
	"completed",
] as const;

export const approvalStatus = type(
	"'pending' | 'approved' | 'denied' | 'executing' | 'completed'",
);
export type ApprovalStatus = (typeof approvalStatusValues)[number];

export const approvalFields = {
	// The request being decided (gate, tool, args, context, expiry) is fixed at create; only the
	// decision fields (status, decidedBy, reason) change.
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	status: field.enum(approvalStatusValues, { required: true }),
	/** The gate whose demand is listed first — kept for display and indexing. The authoritative set is
	 *  `demands`; this is its head, not a second source of truth. */
	gateId: field.string({ required: true, immutable: true }),
	/**
	 * EVERY demand this approval answers. A call commonly attracts more than one — the policy engine's
	 * confirmation probe and a tool's own gate are both before-gates — and a human who is shown one of
	 * them is being asked to decide with the question half-stated. Immutable: what was granted is what
	 * was shown.
	 *
	 * Also the resume's matching set. A gate is no longer skipped by id (which made its deny branch
	 * unreachable); every gate re-runs and a demand in this set counts as met, so the same gate asking
	 * a DIFFERENT question is a new question.
	 */
	demands: field.json(gateDemand.array(), {
		required: true,
		immutable: true,
		doc: "Every gate demand this approval answers, as shown to the approver — and the set a resume matches against.",
	}),
	toolName: field.string({ required: true, index: true, immutable: true }),
	args: field.jsonObject({ required: true, pii: "redacted", immutable: true }),
	reasonCode: field.string({ index: true, immutable: true }),
	/** The REQUESTER — whoever the parked run was executing as. `system:` for an autonomous run, which
	 *  is why it cannot be the only thing an approval is authorized against: anchoring on it alone made
	 *  exactly the approvals that most need a human unapprovable by one. */
	principal: field.principal({ index: true, immutable: true }),
	/** The claw whose run parked this — the approval's ACCESS ANCHOR, and the reason an autonomous
	 *  run's approval is reviewable at all. Whoever may manage the claw may review what it parked, so
	 *  the decision reuses the same owner ∪ scope ∪ grant rule every other resource gets rather than
	 *  inventing an approval-shaped one.
	 *
	 *  IMMUTABLE, and absent only for an ad-hoc `generate` that belongs to no claw — those fall back to
	 *  the boundary below. Stamped by the approval gate from the runtime's recording context, never
	 *  from anything a model or a request body reaches. */
	clawId: field.string({ index: true, immutable: true }),
	/** The TENANT the parked run was executing in — the second anchor, and the one that answers "who
	 *  may approve this?" when there is no claw.
	 *
	 *  A cron-triggered one-off has no claw and a `system:` requester, so neither owns it. It is still
	 *  a tenant's work, and members of that tenant are exactly the humans entitled to decide it —
	 *  which is also why "any authenticated human" is not an option: in a multi-tenant deployment that
	 *  is every OTHER tenant's humans too.
	 *
	 *  Immutable, and stamped from the run's resolved authority — which always HAS a boundary now: a
	 *  deployment that resolves no tenant carries `UNSCOPED`, a reserved label nobody can be a member
	 *  of, so such an approval still has no parent and is still denied. Required, because "the tenant
	 *  this belongs to" was the one question a resume had to answer and a nullable column let it
	 *  answer "I don't know" — which read as agreement with whatever the resume resolved. */
	scope: field.string({ required: true, index: true, immutable: true }),
	scopeId: field.string({ required: true, index: true, immutable: true }),
	reason: field.string(),
	metadata: field.jsonObject(),
	decidedBy: field.principal(),
	createdAt: field.string({ required: true, immutable: true }),
	expiresAt: field.string({ index: true, immutable: true }),
	// ── the execution lease ──────────────────────────────────────────────────────────────────────
	// Written when a resume TAKES the approval, cleared when it finishes. Two columns rather than one
	// timestamp because recovery has to answer two different questions: "has the runner gone away?"
	// (the expiry) and "am I still the runner?" (the id). A resume that lost its lease to a recovery
	// must not be able to complete over the top of the one that took it.
	leaseId: field.string({
		doc: "Identifies the execution attempt holding this approval. A completion is accepted only from the lease that is current — a runner whose lease lapsed and was re-taken cannot finish over its successor.",
	}),
	leaseExpiresAt: field.string({
		index: true,
		doc: "When the current execution lease lapses. Until then the approval is being run and a second resume is refused; after it, exactly one recovery may re-take it. Indexed so a sweeper can find abandoned executions.",
	}),
	// The terminal result, stored once at completion and served to every later resume. This is what
	// makes a finished approval idempotent rather than replayable: the second caller gets the first
	// caller's answer instead of a second execution with new tool-call ids and new effects.
	//
	// Format-opaque here on purpose (the runtime owns the result shape, and contracts does not import
	// runtime); `redacted` because it carries model output.
	result: field.jsonObject({
		pii: "redacted",
		doc: "The run result this approval produced, recorded at completion and returned verbatim to any later resume — a completed approval is answered, never re-executed.",
	}),
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
	/** Mark a pending approval approved. Returns the updated record, or null if it wasn't pending.
	 *  `by` is the deciding {@link Principal} — the host constructs it (`userPrincipal(id)`) at the
	 *  decide boundary, so the `decidedBy` stamp is authorizable by construction. */
	grant: (id: string, by: Principal) => Promise<ApprovalRecord | null>;
	/** Mark a pending approval denied. Returns the updated record, or null if it wasn't pending. */
	deny: (
		id: string,
		by: Principal,
		reason?: string,
	) => Promise<ApprovalRecord | null>;
	/**
	 * Atomically TAKE the approval for execution — the single-continuation primitive. Moves
	 * `approved → executing`, stamping a fresh `leaseId` and a `leaseExpiresAt` at `now + leaseMs`.
	 *
	 * Returns null when the approval cannot be taken: absent, not granted, expired, already
	 * `completed`, or `executing` under a lease that has NOT yet lapsed (somebody is running it).
	 *
	 * A lapsed lease may be re-taken exactly once more, which is the entire recovery story: a resume
	 * that crashed between taking and finishing leaves a lease nobody will ever clear, and this is how
	 * the work becomes reachable again. It is bounded by the clock rather than open to anyone who asks
	 * — the old shape accepted an already-taken approval unconditionally, so "recovery" and "replay it
	 * as many times as you like" were the same call.
	 */
	claim: (
		id: string,
		leaseMs: number,
	) => Promise<{ record: ApprovalRecord; leaseId: string } | null>;
	/**
	 * Finish a taken approval: `executing → completed`, storing the terminal result.
	 *
	 * Accepted ONLY from the lease that is still current. A runner whose lease lapsed and was re-taken
	 * by a recovery has lost the right to finish — otherwise the slow runner and its replacement would
	 * both write a terminal result, and the second would overwrite the answer already returned to a
	 * caller. Returns null when the lease is not current.
	 */
	complete: (
		id: string,
		leaseId: string,
		result: JsonObjectType,
	) => Promise<ApprovalRecord | null>;
	/**
	 * Extend a live lease, or report that it is gone. `null` means this runner no longer owns the
	 * approval — a recovery reclaimed it — and the caller must stop.
	 *
	 * Without this a resume got ONE fixed lease and no way to say "still here". A slow tool or model
	 * tail outlived it and a second runner took over work that was never stuck, which is the race
	 * `complete` can only detect after the fact. Same ownership check `complete` makes, for the same
	 * reason: only the current lease may act. R-H08.
	 */
	heartbeat: (
		id: string,
		leaseId: string,
		leaseMs: number,
	) => Promise<ApprovalRecord | null>;
	/**
	 * List approvals, optionally filtered — the human-review queue reads `{ status: "pending" }`.
	 *
	 * `limit` is a CEILING, not a page size, and the implementation applies its own maximum when the
	 * caller names none. R-M12: this returned every matching row, so on a busy tenant the cost of one
	 * request was set by how many approvals already existed rather than by anything the caller sent.
	 * Cursor pagination is a separate, larger change; this is the bound that stops the unbounded case.
	 */
	list: (filter?: {
		status?: ApprovalStatus;
		principal?: Principal;
		limit?: number;
	}) => Promise<ApprovalRecord[]>;
};
