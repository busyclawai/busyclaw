// The audit CONTRACTS: the append-only, hash-chained record schema, the AuditSink port, and the
// external-anchor shapes. The chain MECHANISM (hashing, createMemoryAudit, verifyAuditChain, the
// audit after-gate) lives in @euroclaw/core. See docs/architecture/07-approval-and-audit.md.

import { type } from "arktype";
import { jsonObject } from "../common";
import { principal } from "./principal";

const OptionalString = type("string | undefined");
const OptionalRunMode = type("'interactive' | 'autonomous' | undefined");

const AuditInputShape = {
	ts: "string",
	/** Which boundary produced this record — one log covers all three: governed tool calls,
	 *  model egress, and the privacy lifecycle (re-identifying reads, per-subject erasure). */
	boundary: "'tool' | 'model' | 'privacy'",
	/** The tool name, "model" for an LLM call, or the privacy event name
	 *  ("pii.reidentification" | "pii.erasure"). */
	name: "string",
	status: "'ok' | 'denied' | 'needs-approval' | 'error'",
	"gateId?": OptionalString,
	"reason?": OptionalString,
	/** The stable machine-readable governance reason code, when the deciding gate set one. */
	"reasonCode?": OptionalString,
	/** The accountable operator (the `principal`), when an IdentityResolver stamped one. Validated as a
	 *  well-formed principal (the same narrow behind `field.principal`) — an untagged value can't enter
	 *  the log. It stays a plain `string` in the inferred record (the narrow doesn't brand). */
	"principal?": principal.or("undefined"),
	/** The claw that produced this action, when it came from a claw run — the ACTOR-KIND fact. Present ⇒
	 *  agent-produced; absent ⇒ human/direct. `principal` answers *on whose authority* (borrowed); this
	 *  answers *which agent physically acted*. Stamped spoof-proof by the runtime (`euroclaw__clawId`). */
	"clawId?": OptionalString,
	/** How the run was triggered — `interactive` (a human present to confirm) | `autonomous` (none), or
	 *  absent for a non-run entry (a direct privacy event). The supervision axis of the actor-kind; stamped
	 *  from mechanical fact (`euroclaw__runMode`). The schema accepts the read fact whether set or not. */
	"runMode?": OptionalRunMode,
	/** The approver, on an action executed after a `needs-approval` was granted — the run's principal is
	 *  the borrowed authority (*who it acted as*), this is *who approved it*. Stamped forge-proof by the
	 *  runtime from the ApprovalRecord's `decidedBy` on resume (`euroclaw__approvedBy`). */
	"decidedBy?": principal.or("undefined"),
	/** The REDACTED details (tool args, or { messages }) — tokens only, never raw PII. */
	payload: jsonObject,
} as const;

export const auditInput = type(AuditInputShape);
export type AuditInput = typeof auditInput.infer;

export const auditEntry = type({
	...AuditInputShape,
	seq: "number",
	prevHash: "string",
	hash: "string",
});
export type AuditEntry = typeof auditEntry.infer;

/**
 * The actor-kind of an audit entry — DERIVED, not stored (persist-raw-derive): the log records the raw
 * facts (`runMode`/`clawId`/`decidedBy`) and this reads them, so the chain stays honest (facts, never an
 * interpretation baked in at write time). `agent` iff a RUN produced the action: a run ALWAYS stamps
 * `runMode`, so its presence is the reliable "an agent loop did this" signal (`clawId` only refines WHICH
 * claw, and is absent for a claw-less ad-hoc run). `human` for a direct operator action with no run (e.g.
 * a privacy event from a `forgetSubject` api call). The claw is never its own principal — this
 * distinguishes agent-vs-human WITHOUT an `agent:` principal kind (docs/plans/approvals-authz.md).
 */
export function auditActorKind(entry: { runMode?: string }): "agent" | "human" {
	return entry.runMode !== undefined ? "agent" : "human";
}

/**
 * The supervision state of an agent-produced entry — DERIVED. `approved` when a human granted a parked
 * `needs-approval` (a `decidedBy` is present) — that WINS over `runMode`, since the action ran only
 * because a human confirmed it; otherwise the run's `runMode` (`interactive` = a human was present,
 * `autonomous` = none). `undefined` for a human/direct entry with no run mode. So "claw drafted
 * (autonomous), recruiter approved" reads as `agent` + `approved` + `decidedBy`.
 */
export function auditSupervision(entry: {
	runMode?: "interactive" | "autonomous";
	decidedBy?: string;
}): "interactive" | "autonomous" | "approved" | undefined {
	if (entry.decidedBy !== undefined && entry.decidedBy.trim() !== "") {
		return "approved";
	}
	return entry.runMode;
}

export type AuditSink = {
	append: (input: AuditInput) => AuditEntry | Promise<AuditEntry>;
	entries: () => readonly AuditEntry[];
};

/**
 * A snapshot of a log's tip: the seq/hash an external witness pins. This is the ~tiny thing you
 * publish (RFC-3161, Rekor, a replica) — not the whole log. Validated on the way back in (an
 * anchor row is read from durable storage at verify time). See docs/architecture/14.
 */
export const auditHead = type({
	seq: "number",
	hash: "string",
	ts: "string",
	count: "number",
});
export type AuditHead = typeof auditHead.infer;

/**
 * A receipt that a head was published to an external witness. `kind`/`proof` are the witness's;
 * the engine treats `proof` as opaque — cryptographically validating it against the witness is the
 * anchor adapter's job (`@euroclaw/anchor-rfc3161` etc.). Validated as untrusted input (it is read
 * back from the `audit_anchor` store at verify time).
 */
export const anchorProof = type({
	head: auditHead,
	kind: "'rfc3161' | 'rekor' | 'replica' | 'kms'",
	proof: "string",
	signedAt: "string",
});
export type AnchorProof = typeof anchorProof.infer;

/** One integrity problem found while walking the chain. */
export type AuditChainProblem =
	| {
			kind: "broken_link";
			seq: number;
			expectedPrevHash: string;
			actualPrevHash: string;
	  }
	| {
			kind: "hash_mismatch";
			seq: number;
			expected: string;
			actual: string;
	  }
	| {
			kind: "seq_gap";
			seq: number;
			expected: number;
			actual: number;
	  }
	// The chain diverges from what was externally published — catches a full-store rewrite.
	| {
			kind: "anchor_mismatch";
			seq: number;
			expected: string;
			actual: string;
	  }
	// An anchored seq is gone from the log — catches tail truncation below an anchor.
	| {
			kind: "anchor_missing";
			seq: number;
			anchoredHash: string;
	  }
	// An anchor row failed validation — a malformed/corrupt anchor is a problem, not a silent pass.
	| {
			kind: "anchor_invalid";
			reason: string;
	  };

/** The result of walking an audit log: an intact chain, or every problem found. */
export type AuditChainVerification =
	| { ok: true; entries: number }
	| { ok: false; entries: number; problems: readonly AuditChainProblem[] };
