// The audit MECHANISM: the append-only, hash-chained sink + the chain verifier + the audit
// after-gate. The record schema and AuditSink/anchor contracts live in @euroclaw/contracts.
// See docs/architecture/07-approval-and-audit.md.

import {
	type AfterGate,
	type AnchorProof,
	type AuditChainProblem,
	type AuditChainVerification,
	type AuditEntry,
	type AuditHead,
	type AuditSink,
	anchorProof,
	APPROVED_BY_CONTEXT_KEY,
	auditInput,
	type BoundaryCall,
	type JsonObject,
	type JsonValue,
	PRINCIPAL_CONTEXT_KEY,
	type StampedFacts,
	stampedFacts,
} from "@euroclaw/contracts";
import { validationError } from "@euroclaw/errors";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

/**
 * SHA-256 over each chain link, via @noble/hashes — cryptographic, synchronous, and
 * runtime-agnostic (Node, Bun, Deno, Workers, browser run the same pure-JS code).
 * Deliberately NOT configurable: sha256 is the universal standard for a tamper-evident
 * chain and nobody swaps it, and the `AuditSink` is already the swap point — if you need
 * different hashing or storage, implement your own sink.
 */
const hashEntry = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));

// A fixed sentinel for the first link's prevHash.
const GENESIS = "genesis";

function cloneJson<T extends JsonValue>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}

export function createMemoryAudit(): AuditSink {
	const log: AuditEntry[] = [];
	return {
		append(input) {
			const valid = auditInput(input);
			if (valid instanceof type.errors) {
				throw validationError("invalid audit input", valid.summary);
			}
			const prev = log.at(-1);
			const prevHash = prev ? prev.hash : GENESIS;
			const seq = log.length;
			const snapshot = {
				...valid,
				payload: cloneJson(valid.payload),
				seq,
				prevHash,
			};
			const entry: AuditEntry = deepFreeze({
				...snapshot,
				hash: hashEntry(JSON.stringify(snapshot)),
			});
			log.push(entry);
			return entry;
		},
		entries() {
			return [...log];
		},
	};
}

/** The current tip of a log — what you hand an anchor to pin. `null` for an empty log. */
export function headOf(entries: readonly AuditEntry[]): AuditHead | null {
	const last = entries.at(-1);
	if (!last) return null;
	return { seq: last.seq, hash: last.hash, ts: last.ts, count: entries.length };
}

/**
 * Walk an audit log and verify its hash chain. For each record it checks the LINK (the record's
 * `prevHash` must equal the previous record's `hash` — GENESIS for the first), recomputes the
 * record's SHA-256 from its content and confirms it matches the stored `hash`, and flags any
 * sequence gap. It collects EVERY problem rather than stopping at the first, so an audit can see
 * the full extent of the damage.
 *
 * Without `anchors` this makes the chain's tamper-EVIDENCE operational, but it is not tamper-PROOF:
 * it catches partial tampering (a record edited, deleted, reordered, or inserted — including an
 * attacker who fixes a record's own hash, which snaps the following link) but CANNOT catch a
 * full-store rewrite (the whole log re-chained consistently) or tail truncation.
 *
 * Pass `anchors` — heads previously published to an external witness — to close that gap. Each
 * anchored head must still appear verbatim at its seq: a rewrite makes the chain diverge from
 * published history (`anchor_mismatch`), and truncating below an anchor drops the anchored seq
 * (`anchor_missing`). The engine checks structural agreement only; an anchor adapter separately
 * validates each `proof` against its witness. See docs/architecture/14-audit-tamper-evidence.md.
 */
export function verifyAuditChain(
	entries: readonly AuditEntry[],
	anchors: readonly AnchorProof[] = [],
): AuditChainVerification {
	const problems: AuditChainProblem[] = [];
	const hashBySeq = new Map<number, string>();
	let expectedPrevHash = GENESIS;
	let index = 0;
	for (const entry of entries) {
		if (entry.prevHash !== expectedPrevHash) {
			problems.push({
				kind: "broken_link",
				seq: entry.seq,
				expectedPrevHash,
				actualPrevHash: entry.prevHash,
			});
		}
		// Recompute over the record minus its `hash` field — the same snapshot shape + key
		// order the writer used, so any edit after the fact changes the recomputed hash.
		const { hash, ...snapshot } = entry;
		const recomputed = hashEntry(JSON.stringify(snapshot));
		if (recomputed !== hash) {
			problems.push({
				kind: "hash_mismatch",
				seq: entry.seq,
				expected: recomputed,
				actual: hash,
			});
		}
		if (entry.seq !== index) {
			problems.push({
				kind: "seq_gap",
				seq: entry.seq,
				expected: index,
				actual: entry.seq,
			});
		}
		hashBySeq.set(entry.seq, hash);
		// The next record committed to THIS record's stored hash (not the recomputed one), so
		// "tamper content + fix own hash" still snaps the following link.
		expectedPrevHash = hash;
		index++;
	}
	// Anchors pin seq→hash in un-retractable external history. The local chain must still agree.
	// They are read back from durable storage, so validate the shape before trusting it — a
	// corrupt anchor row must surface as a problem, never pass silently.
	for (const anchor of anchors) {
		const valid = anchorProof(anchor);
		if (valid instanceof type.errors) {
			problems.push({ kind: "anchor_invalid", reason: valid.summary });
			continue;
		}
		const { seq, hash } = valid.head;
		const present = hashBySeq.get(seq);
		if (present === undefined) {
			problems.push({ kind: "anchor_missing", seq, anchoredHash: hash });
		} else if (present !== hash) {
			problems.push({
				kind: "anchor_mismatch",
				seq,
				expected: hash,
				actual: present,
			});
		}
	}
	return problems.length === 0
		? { ok: true, entries: entries.length }
		: { ok: false, entries: entries.length, problems };
}

function auditPayload(call: BoundaryCall): JsonObject {
	return call.payload;
}

/**
 * The audit after-gate: turns every finished call into a record on the AuditSink port.
 * It is a plain after-gate, not a privileged governance step — swap the sink to change
 * storage, seal it (via a plugin) to make the record non-removable.
 */
export function auditGate(sink: AuditSink, now: () => string): AfterGate {
	return {
		id: "audit",
		matcher: () => true,
		handler: async (call, ctx, outcome) => {
			// The actor-kind facts (clawId + runMode), read through the ONE typed contracts reader — never
			// a raw typeof-probe of the reserved namespace. They are runtime-seeded and spoof-proof, so a
			// malformed stamp is a host bug; unlike the cedar DECISION gate (which fails loud), this
			// after-gate degrades to no actor-kind rather than throw — a robust audit records what it can.
			const stamped = stampedFacts(ctx);
			const facts: StampedFacts = stamped instanceof type.errors ? {} : stamped;
			// `approvedBy` (the resumed approval's decider) isn't a policy fact — a plain reserved read
			// beside `principal`, the audit's other lone principal.
			const approvedBy = ctx[APPROVED_BY_CONTEXT_KEY];
			await sink.append({
				ts: now(),
				boundary: call.boundary,
				name: call.name,
				status: outcome.status,
				gateId: "gateId" in outcome ? outcome.gateId : undefined,
				reason: "reason" in outcome ? outcome.reason : undefined,
				reasonCode: "reasonCode" in outcome ? outcome.reasonCode : undefined,
				principal:
					typeof ctx[PRINCIPAL_CONTEXT_KEY] === "string"
						? ctx[PRINCIPAL_CONTEXT_KEY]
						: undefined,
				// The actor-kind facts — passed as read (a non-run entry has no runMode/clawId, only a
				// resumed-approval action carries an approver); the `auditInput` schema accepts the absent case.
				clawId: facts.clawId,
				runMode: facts.runMode,
				decidedBy: typeof approvedBy === "string" ? approvedBy : undefined,
				payload: auditPayload(call), // REDACTED payload — no PII in the log
			});
		},
	};
}
