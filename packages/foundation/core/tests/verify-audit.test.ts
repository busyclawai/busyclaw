import type { AnchorProof, AuditEntry } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryAudit, headOf, verifyAuditChain } from "../src/index";

function anchorAt(entries: readonly AuditEntry[], seq: number): AnchorProof {
	const entry = entries.find((e) => e.seq === seq);
	if (!entry) throw new Error(`no entry at seq ${seq}`);
	return {
		head: { seq: entry.seq, hash: entry.hash, ts: entry.ts, count: seq + 1 },
		kind: "rfc3161",
		proof: "opaque-witness-receipt",
		signedAt: "t-anchor",
	};
}

function makeChain(count: number, tag = "send_email"): AuditEntry[] {
	const sink = createMemoryAudit();
	for (let i = 0; i < count; i++) {
		sink.append({
			ts: `t${i}`,
			boundary: "tool",
			name: tag,
			status: "ok",
			payload: { i },
		});
	}
	return [...sink.entries()];
}

describe("verifyAuditChain", () => {
	it("accepts an intact chain", () => {
		expect(verifyAuditChain(makeChain(3))).toEqual({ ok: true, entries: 3 });
	});

	it("accepts an empty chain", () => {
		expect(verifyAuditChain([])).toEqual({ ok: true, entries: 0 });
	});

	it("still verifies after a JSON round-trip (the durable-sink path)", () => {
		const roundTripped = JSON.parse(
			JSON.stringify(makeChain(4)),
		) as AuditEntry[];
		expect(verifyAuditChain(roundTripped).ok).toBe(true);
	});

	it("detects a tampered payload (hash mismatch)", () => {
		const tampered = makeChain(3).map((entry, i) =>
			i === 1 ? { ...entry, payload: { tampered: true } } : entry,
		);
		const result = verifyAuditChain(tampered);
		expect(result.ok).toBe(false);
		expect(
			result.ok === false &&
				result.problems.some((p) => p.kind === "hash_mismatch" && p.seq === 1),
		).toBe(true);
	});

	it("detects a forged hash field (and the broken link it causes downstream)", () => {
		const tampered = makeChain(3).map((entry, i) =>
			i === 1 ? { ...entry, hash: "0".repeat(64) } : entry,
		);
		const result = verifyAuditChain(tampered);
		expect(result.ok).toBe(false);
		expect(
			result.ok === false &&
				result.problems.some((p) => p.kind === "hash_mismatch" && p.seq === 1),
		).toBe(true);
	});

	it("detects a deleted middle record (broken link + seq gap)", () => {
		const deleted = makeChain(4).filter((_, i) => i !== 1);
		const result = verifyAuditChain(deleted);
		expect(result.ok).toBe(false);
		expect(
			result.ok === false &&
				result.problems.some((p) => p.kind === "broken_link"),
		).toBe(true);
	});

	it("detects reordered records", () => {
		const reordered = makeChain(3).map((entry) => ({ ...entry }));
		const a = reordered.at(1);
		const b = reordered.at(2);
		if (a && b) {
			reordered[1] = b;
			reordered[2] = a;
		}
		expect(verifyAuditChain(reordered).ok).toBe(false);
	});

	it("collects every problem, not just the first", () => {
		const tampered = makeChain(4).map((entry, i) => {
			if (i === 0) return { ...entry, payload: { x: 1 } };
			if (i === 2) return { ...entry, payload: { x: 2 } };
			return entry;
		});
		const result = verifyAuditChain(tampered);
		expect(result.ok).toBe(false);
		expect(
			result.ok === false
				? result.problems.filter((p) => p.kind === "hash_mismatch").length
				: 0,
		).toBe(2);
	});

	it("does NOT detect tail truncation without an anchor (the documented limit)", () => {
		const truncated = makeChain(4).slice(0, 3);
		// Nothing references the tail, so a shorter chain still verifies intact. This is the
		// known hash-chain blind spot; an external anchor (a witness hash outside the blast
		// radius) is what closes it — see docs/architecture/14-audit-tamper-evidence.md.
		expect(verifyAuditChain(truncated).ok).toBe(true);
	});
});

describe("verifyAuditChain — external anchors", () => {
	it("accepts an intact chain that agrees with its anchors", () => {
		const chain = makeChain(5);
		const anchors = [anchorAt(chain, 1), anchorAt(chain, 3)];
		expect(verifyAuditChain(chain, anchors)).toEqual({ ok: true, entries: 5 });
	});

	it("headOf reports the tip, and null for an empty log", () => {
		const chain = makeChain(3);
		expect(headOf(chain)).toMatchObject({ seq: 2, count: 3 });
		expect(headOf([])).toBeNull();
	});

	it("flags a malformed anchor row as a problem (anchor_invalid), not a silent pass", () => {
		const chain = makeChain(3);
		// A corrupt anchor read back from storage — missing the head's hash.
		const corrupt = {
			head: { seq: 1, ts: "t-anchor", count: 2 },
			kind: "rfc3161",
			proof: "x",
			signedAt: "t-anchor",
		} as unknown as AnchorProof;
		const result = verifyAuditChain(chain, [corrupt]);
		expect(result.ok).toBe(false);
		expect(
			result.ok === false &&
				result.problems.some((p) => p.kind === "anchor_invalid"),
		).toBe(true);
	});

	it("detects a full-store rewrite that re-chains consistently (anchor_mismatch)", () => {
		// Anchor the genuine head at seq 2 BEFORE the attack.
		const anchor = anchorAt(makeChain(4), 2);

		// A full-store attacker rebuilds a completely valid chain with different content — here a
		// second genuine chain (different tool name → different hashes). It passes plain
		// verification; only the external anchor catches the divergence.
		const rewritten = makeChain(4, "exfiltrate");
		expect(verifyAuditChain(rewritten).ok).toBe(true);

		const result = verifyAuditChain(rewritten, [anchor]);
		expect(result.ok).toBe(false);
		expect(
			result.ok === false &&
				result.problems.some(
					(p) => p.kind === "anchor_mismatch" && p.seq === 2,
				),
		).toBe(true);
	});

	it("detects tail truncation below an anchor (anchor_missing)", () => {
		const chain = makeChain(5);
		const anchor = anchorAt(chain, 4); // anchor the genuine tip
		const truncated = chain.slice(0, 3); // attacker drops seq 3 and 4

		// Without the anchor, truncation is invisible (passes).
		expect(verifyAuditChain(truncated).ok).toBe(true);
		// With it, the anchored seq-4 is gone → caught.
		const result = verifyAuditChain(truncated, [anchor]);
		expect(result.ok).toBe(false);
		expect(
			result.ok === false &&
				result.problems.some((p) => p.kind === "anchor_missing" && p.seq === 4),
		).toBe(true);
	});
});
