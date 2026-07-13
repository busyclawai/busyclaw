// The audit CONTRACTS: the append-only, hash-chained record schema, the AuditSink port, and the
// external-anchor shapes. The chain MECHANISM (hashing, createMemoryAudit, verifyAuditChain, the
// audit after-gate) lives in @euroclaw/core. See docs/architecture/07-approval-and-audit.md.

import { type } from "arktype";
import { jsonObject } from "../common";
import { principal } from "./principal";

const OptionalString = type("string | undefined");

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
