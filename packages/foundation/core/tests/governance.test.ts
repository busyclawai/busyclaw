import {
	type ApprovalRecord,
	type ApprovalStore,
	type Detector,
	type PiiMapping,
	type PiiMappingStore,
	type PiiSpan,
	SCOPE_CONTEXT_KEY,
	SCOPE_ID_CONTEXT_KEY,
	SUBJECT_CONTEXT_KEY,
} from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	createGovernance,
	createMemoryAudit,
	createMemoryPiiMappingStore,
	createMemoryRedactor,
	createStoredRedactor,
} from "../src/index";

/** A full in-memory ApprovalStore for tests (create/grant/deny/consume/list) + a `created` log. */
function recordingStore(): { store: ApprovalStore; created: ApprovalRecord[] } {
	const rows = new Map<string, ApprovalRecord>();
	const created: ApprovalRecord[] = [];
	let n = 0;
	const store: ApprovalStore = {
		create: async (input) => {
			const rec: ApprovalRecord = {
				id: `ap${n++}`,
				status: "pending",
				...input,
			};
			rows.set(rec.id, rec);
			created.push(rec);
			return rec;
		},
		get: async (id) => rows.get(id) ?? null,
		grant: async (id, by) => {
			const r = rows.get(id);
			if (r?.status !== "pending") return null;
			const u: ApprovalRecord = { ...r, status: "approved", decidedBy: by };
			rows.set(id, u);
			return u;
		},
		deny: async (id, by, reason) => {
			const r = rows.get(id);
			if (r?.status !== "pending") return null;
			const u: ApprovalRecord = {
				...r,
				status: "denied",
				decidedBy: by,
				reason,
			};
			rows.set(id, u);
			return u;
		},
		consume: async (id) => {
			const r = rows.get(id);
			if (r?.status !== "approved") return null;
			rows.delete(id); // single-use
			return r;
		},
		list: async (f) =>
			[...rows.values()].filter(
				(r) =>
					(!f?.status || r.status === f.status) &&
					(!f?.principal || r.principal === f.principal),
			),
	};
	return { store, created };
}

// A tiny PII detector for tests — in real use you bring your own (regex, Presidio, NER).
const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const m of text.matchAll(/\S+@\S+/g)) {
		const value = m[0];
		if (value === undefined) continue;
		const start = m.index ?? 0;
		spans.push({
			start,
			end: start + value.length,
			value,
			kind: "email",
			source: "regex",
		});
	}
	return spans;
};

describe("euroclaw governance — the neutral pipeline", () => {
	it("is neutral by default: no redaction, no audit, no gates", async () => {
		let toolSaw: unknown;
		const ec = createGovernance({
			runTool: (call) => {
				toolSaw = call.args.email;
				return "ok";
			},
		});

		const r = await ec.handleToolCall({
			name: "x",
			args: { email: "a@b.com" },
		});
		expect(r.status).toBe("ok");
		expect(toolSaw).toBe("a@b.com"); // raw — NOT tokenized; redaction is opt-in
		expect(ec.audit).toBeUndefined(); // no audit sink unless you provide one
	});

	it("redaction is opt-in (provide a redactor): tokenize at edge, rehydrate inside the tool", async () => {
		let toolSaw = "";
		const audit = createMemoryAudit();
		const ec = createGovernance({
			redactor: createMemoryRedactor(emailDetector),
			audit,
			runTool: async (call, _ctx, { rehydrate }) => {
				// Inside the tool boundary we rehydrate — the only place PII exists.
				const args = (await rehydrate(call.args)) as { to: string };
				toolSaw = args.to;
				return { sent: true };
			},
		});

		const r = await ec.handleToolCall({
			name: "send_invoice",
			args: { to: "alice@personal.com", amount: 500 },
		});

		expect(r).toEqual({ status: "ok", output: { sent: true } });
		expect(toolSaw).toBe("alice@personal.com"); // the tool saw the REAL email

		// the audit log saw only a TOKEN — PII never crossed into persistence
		const entries = audit.entries();
		expect(entries).toHaveLength(1);
		expect(entries.at(0)?.payload.to).toMatch(/^\{\{pii:[a-z]+:[a-z0-9]+\}\}$/);
		expect(JSON.stringify(entries)).not.toContain("alice@personal.com");
	});

	it("passes trusted container + subject context into redaction", async () => {
		const saved: PiiMapping[] = [];
		const savedSubjects: (readonly string[] | undefined)[] = [];
		const mappings: PiiMappingStore = {
			save: (mapping, subjectIds) => {
				saved.push(mapping);
				savedSubjects.push(subjectIds);
			},
			resolve: (placeholder) =>
				saved.find((mapping) => mapping.placeholder === placeholder)
					?.original ?? null,
			findByHash: () => null,
			deleteForSubject: () => {},
		};
		const ec = createGovernance({
			redactor: createStoredRedactor({ detector: emailDetector, mappings }),
			resolveContext: (ctx) => ({
				...ctx,
				[SCOPE_CONTEXT_KEY]: "claw",
				[SCOPE_ID_CONTEXT_KEY]: "claw-1",
				[SUBJECT_CONTEXT_KEY]: "subject-1",
			}),
		});

		await ec.handleToolCall({ name: "x", args: { email: "a@b.com" } });

		expect(saved[0]).toMatchObject({ scope: "claw", scopeId: "claw-1" });
		expect(savedSubjects[0]).toEqual(["subject-1"]);
	});

	it("scopes placeholders and rehydration by container", async () => {
		const mappings = createMemoryPiiMappingStore();
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings,
		});

		const first = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "a",
		});
		const second = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "b",
		});

		expect(first).toMatch(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/);
		expect(second).toMatch(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/);
		expect(first).not.toBe(second);
		expect(
			await redactor.rehydrateValue(first, { scope: "claw", scopeId: "a" }),
		).toBe("email a@b.com");
		expect(
			await redactor.rehydrateValue(first, { scope: "claw", scopeId: "b" }),
		).toBe(first);
	});

	it("deletes a subject's mappings across containers (multi-subject safe)", async () => {
		const mappings = createMemoryPiiMappingStore();
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings,
		});

		const first = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "a",
			subjectIds: ["subject-1"],
		});
		const second = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "b",
			subjectIds: ["subject-1"],
		});

		await mappings.deleteForSubject("subject-1");

		expect(
			await redactor.rehydrateValue(first, { scope: "claw", scopeId: "a" }),
		).toBe(first);
		expect(
			await redactor.rehydrateValue(second, { scope: "claw", scopeId: "b" }),
		).toBe(second);
	});

	it("a deny gate blocks the tool and the denial is recorded", async () => {
		let ran = false;
		const audit = createMemoryAudit();
		const ec = createGovernance({
			audit,
			runTool: () => {
				ran = true;
				return {};
			},
		});
		ec.registerGate({
			id: "amount-cap",
			matcher: (c) => c.name === "send_invoice",
			handler: (c) => {
				const amount = Number((c.args as { amount: number }).amount);
				return amount > 10_000
					? { decision: "deny", reason: "over cap" }
					: { decision: "permit" };
			},
		});

		const r = await ec.handleToolCall({
			name: "send_invoice",
			args: { amount: 50_000 },
		});
		expect(r).toEqual({
			status: "denied",
			gateId: "amount-cap",
			reason: "over cap",
		});
		expect(ran).toBe(false);
		expect(audit.entries().map((e) => e.status)).toEqual(["denied"]);
	});

	it("needs-approval suspends before the tool runs", async () => {
		let ran = false;
		const ec = createGovernance({
			runTool: () => {
				ran = true;
				return {};
			},
		});
		ec.registerGate({
			id: "approval-over-1000",
			matcher: () => true,
			handler: (c) => {
				const amount = Number((c.args as { amount: number }).amount);
				return amount > 1000
					? { decision: "needs-approval", reason: "high value" }
					: { decision: "permit" };
			},
		});

		const r = await ec.handleToolCall({
			name: "send_invoice",
			args: { amount: 5000 },
		});
		expect(r.status).toBe("needs-approval");
		if (r.status === "needs-approval")
			expect(r.gateId).toBe("approval-over-1000");
		expect(ran).toBe(false);
	});

	it("before-gates run in registration order; the first deny wins", async () => {
		const seen: string[] = [];
		const ec = createGovernance();
		ec.registerGate({
			id: "first",
			matcher: () => true,
			handler: () => {
				seen.push("first");
				return { decision: "deny", reason: "stop here" };
			},
		});
		ec.registerGate({
			id: "second",
			matcher: () => true,
			handler: () => {
				seen.push("second");
				return { decision: "permit" };
			},
		});

		const r = await ec.handleToolCall({ name: "x", args: {} });
		expect(r).toEqual({
			status: "denied",
			gateId: "first",
			reason: "stop here",
		});
		expect(seen).toEqual(["first"]); // "second" never ran
	});

	it("boundary gates run before tool gates and can deny tool calls", async () => {
		let ran = false;
		const seen: string[] = [];
		const ec = createGovernance({
			runTool: () => {
				ran = true;
				return {};
			},
		});
		ec.registerGate({
			id: "tool-gate",
			matcher: () => true,
			handler: () => {
				seen.push("tool");
				return { decision: "permit" };
			},
		});
		ec.registerBoundaryGate({
			id: "boundary-gate",
			matcher: (call) => call.boundary === "tool",
			handler: () => {
				seen.push("boundary");
				return { decision: "deny", reason: "blocked" };
			},
		});

		const result = await ec.handleToolCall({ name: "x", args: {} });

		expect(result).toEqual({
			status: "denied",
			gateId: "boundary-gate",
			reason: "blocked",
		});
		expect(seen).toEqual(["boundary"]);
		expect(ran).toBe(false);
	});

	it("after-gates observe the outcome and run even when a before-gate denies", async () => {
		const seen: string[] = [];
		const audit = createMemoryAudit();
		const ec = createGovernance({ audit });
		ec.registerGate({
			id: "block",
			matcher: () => true,
			handler: () => ({ decision: "deny", reason: "no" }),
		});
		ec.registerAfterGate({
			id: "watch",
			matcher: () => true,
			handler: (_call, _ctx, outcome) => {
				seen.push(outcome.status);
			},
		});

		const r = await ec.handleToolCall({ name: "x", args: {} });
		expect(r.status).toBe("denied");
		expect(seen).toEqual(["denied"]); // the after-gate saw the denial
		expect(audit.entries().map((e) => e.status)).toEqual(["denied"]); // and so did audit
	});

	it("audit storage is a swappable port (not baked into governance)", async () => {
		const stored: string[] = [];
		const ec = createGovernance({
			audit: {
				append: (input) => {
					stored.push(`${input.name}:${input.status}`);
					return { ...input, seq: stored.length - 1, prevHash: "", hash: "" };
				},
				entries: () => [],
			},
		});

		await ec.handleToolCall({ name: "ping", args: {} });
		expect(stored).toEqual(["ping:ok"]); // records landed in MY sink, not the default
	});

	it("awaits async audit sinks before returning", async () => {
		const stored: string[] = [];
		let releaseAudit: () => void = () => {};
		const auditBlocked = new Promise<void>((resolve) => {
			releaseAudit = resolve;
		});
		const ec = createGovernance({
			audit: {
				append: async (input) => {
					await auditBlocked;
					stored.push(`${input.name}:${input.status}`);
					return { ...input, seq: stored.length - 1, prevHash: "", hash: "" };
				},
				entries: () => [],
			},
		});

		let settled = false;
		const pending = ec.handleToolCall({ name: "ping", args: {} }).then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(stored).toEqual([]);
		releaseAudit();
		await pending;
		expect(stored).toEqual(["ping:ok"]);
	});

	it("fails closed when audit append fails", async () => {
		const ec = createGovernance({
			audit: {
				append: async () => {
					throw new Error("audit unavailable");
				},
				entries: () => [],
			},
		});

		await expect(ec.handleToolCall({ name: "ping", args: {} })).rejects.toThrow(
			/audit unavailable/,
		);
	});

	it("a sealed gate cannot be redefined", () => {
		const ec = createGovernance();
		ec.registerGate({
			id: "audit-floor",
			matcher: () => true,
			handler: () => ({ decision: "permit" }),
			sealed: true,
		});
		expect(() =>
			ec.registerGate({
				id: "audit-floor",
				matcher: () => true,
				handler: () => ({ decision: "deny", reason: "hijack" }),
			}),
		).toThrow(/sealed/);
	});

	it("sealed before-gates run before earlier non-sealed gates", async () => {
		const seen: string[] = [];
		const ec = createGovernance();
		ec.registerGate({
			id: "ordinary",
			matcher: () => true,
			handler: () => {
				seen.push("ordinary");
				return { decision: "deny", reason: "stop" };
			},
		});
		ec.registerGate({
			id: "sealed-floor",
			matcher: () => true,
			handler: () => {
				seen.push("sealed");
				return { decision: "permit" };
			},
			sealed: true,
		});

		const result = await ec.handleToolCall({ name: "x", args: {} });

		expect(result.status).toBe("denied");
		expect(seen).toEqual(["sealed", "ordinary"]);
	});

	it("sealed boundary gates run before earlier non-sealed boundary gates", async () => {
		const seen: string[] = [];
		const ec = createGovernance();
		ec.registerBoundaryGate({
			id: "ordinary-boundary",
			matcher: () => true,
			handler: () => {
				seen.push("ordinary");
				return { decision: "deny", reason: "stop" };
			},
		});
		ec.registerBoundaryGate({
			id: "sealed-boundary",
			matcher: () => true,
			handler: () => {
				seen.push("sealed");
				return { decision: "permit" };
			},
			sealed: true,
		});

		const result = await ec.handleToolCall({ name: "x", args: {} });

		expect(result.status).toBe("denied");
		expect(seen).toEqual(["sealed", "ordinary"]);
	});

	it("configured audit after-gate cannot be replaced", () => {
		const ec = createGovernance({ audit: createMemoryAudit() });

		expect(() =>
			ec.registerAfterGate({
				id: "audit",
				matcher: () => true,
				handler: () => {},
			}),
		).toThrow(/sealed/);
	});

	it("rejects a malformed tool call at the boundary (the LLM is untrusted)", async () => {
		const ec = createGovernance();
		// @ts-expect-error — deliberately wrong shape; arktype catches it at runtime
		await expect(ec.handleToolCall({ name: 123, args: {} })).rejects.toThrow(
			/invalid tool call/,
		);
	});

	it("rejects nested non-JSON tool args", async () => {
		const ec = createGovernance();

		await expect(
			ec.handleToolCall({
				name: "x",
				args: { nested: { fn: () => "nope" } } as never,
			}),
		).rejects.toThrow(/invalid tool call/);
		await expect(
			ec.handleToolCall({
				name: "x",
				args: { amount: Number.NaN },
			}),
		).rejects.toThrow(/invalid tool call/);
		await expect(
			ec.handleToolCall({
				name: "x",
				args: { id: 1n } as never,
			}),
		).rejects.toThrow(/invalid tool call/);
	});

	it("rejects cyclic tool args without recursing forever", async () => {
		const ec = createGovernance();
		const args: Record<string, unknown> = { value: "x" };
		args.self = args;

		await expect(
			ec.handleToolCall({ name: "x", args: args as never }),
		).rejects.toThrow(/invalid tool call/);
	});

	it("accepts nested JSON tool args", async () => {
		let saw: unknown;
		const ec = createGovernance({
			runTool: (call) => {
				saw = call.args;
				return {};
			},
		});

		await ec.handleToolCall({
			name: "x",
			args: { nested: { values: ["a", 1, true, null] } },
		});

		expect(saw).toEqual({ nested: { values: ["a", 1, true, null] } });
	});

	it("rejects a gate that returns a malformed decision (plugins are third-party)", async () => {
		const ec = createGovernance();
		ec.registerGate({
			id: "broken",
			matcher: () => true,
			handler: () => ({ decision: "maybe" }) as never,
		});
		await expect(ec.handleToolCall({ name: "x", args: {} })).rejects.toThrow(
			/invalid decision/,
		);
	});

	it("rejects malformed detector spans before redacting", async () => {
		const ec = createGovernance({
			redactor: createMemoryRedactor(() => [
				{ start: 0, end: 1, value: "x", kind: "ssn" } as never,
			]),
		});

		await expect(
			ec.handleToolCall({ name: "x", args: { value: "x" } }),
		).rejects.toThrow(/detector returned invalid PII spans/);
	});

	it("rejects malformed audit entries before hash-chaining", () => {
		const audit = createMemoryAudit();

		expect(() =>
			audit.append({
				ts: "2026-01-01T00:00:00Z",
				boundary: "tool",
				name: "x",
				status: "maybe",
				payload: {},
			} as never),
		).toThrow(/invalid audit input/);
		expect(() =>
			audit.append({
				ts: "2026-01-01T00:00:00Z",
				boundary: "tool",
				name: "x",
				status: "ok",
				payload: { nested: { fn: () => "nope" } } as never,
			}),
		).toThrow(/invalid audit input/);
		expect(audit.entries()).toHaveLength(0);
	});

	it("the audit log is hash-chained", async () => {
		const audit = createMemoryAudit();
		const ec = createGovernance({ audit });
		await ec.handleToolCall({ name: "a", args: {} });
		await ec.handleToolCall({ name: "b", args: {} });

		const entries = audit.entries();
		expect(entries).toHaveLength(2);
		const [first, second] = entries;
		expect(second?.prevHash).toBe(first?.hash);
		expect(first?.hash).toMatch(/^[0-9a-f]{64}$/); // sha256, zero config, not configurable
	});

	it("audit entries clone and freeze nested payloads before hashing", async () => {
		const audit = createMemoryAudit();
		const source = { nested: { amount: 100 }, list: [{ ok: true }] };

		const entry = await audit.append({
			ts: "2026-01-01T00:00:00Z",
			boundary: "tool",
			name: "invoice",
			status: "ok",
			payload: source,
		});
		const hash = entry.hash;
		source.nested.amount = 999;
		source.list[0] = { ok: false };

		const [stored] = audit.entries();
		if (!stored) throw new Error("missing audit entry");
		const payload = stored.payload as {
			nested: { amount: number };
			list: { ok: boolean }[];
		};

		expect(stored.hash).toBe(hash);
		expect(payload).toEqual({ nested: { amount: 100 }, list: [{ ok: true }] });
		expect(Object.isFrozen(stored)).toBe(true);
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload.nested)).toBe(true);
		expect(Object.isFrozen(payload.list)).toBe(true);
		expect(Object.isFrozen(payload.list[0])).toBe(true);
		expect(Reflect.set(payload.nested, "amount", 123)).toBe(false);
		expect(payload.nested.amount).toBe(100);
	});
});

describe("euroclaw governance — the approval after-gate (opt-in, mirrors audit)", () => {
	it("persists a needs-approval via the after-gate when a store is configured", async () => {
		const { store, created } = recordingStore();
		const ec = createGovernance({ approvalStore: store }).registerGate({
			id: "danger",
			matcher: (c) => c.name === "delete_user",
			handler: () => ({
				decision: "needs-approval",
				reason: "human must confirm",
			}),
		});

		const r = await ec.handleToolCall({
			name: "delete_user",
			args: { id: "u1" },
		});

		expect(r.status).toBe("needs-approval");
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({
			gateId: "danger",
			toolName: "delete_user",
			reason: "human must confirm",
		});
		// the REDACTED call is stored verbatim, so resume can replay it
		expect(created[0]?.args).toEqual({ id: "u1" });
		expect(ec.approvals).toBe(store); // exposed, like ec.audit
	});

	it("needs-approval still works with no store — in-flight only, nothing persisted", async () => {
		const ec = createGovernance().registerGate({
			id: "danger",
			matcher: () => true,
			handler: () => ({ decision: "needs-approval", reason: "confirm" }),
		});
		const r = await ec.handleToolCall({ name: "x", args: {} });
		expect(r.status).toBe("needs-approval");
		expect(ec.approvals).toBeUndefined();
	});
});

describe("euroclaw governance — durable approval continuation", () => {
	it("resumes a granted approval: re-runs the stored call, bypassing the gate that demanded it", async () => {
		const { store } = recordingStore();
		let toolRan: { name: string; args: Record<string, unknown> } | undefined;
		const ec = createGovernance({
			approvalStore: store,
			runTool: (call) => {
				toolRan = { name: call.name, args: call.args };
				return { sent: true };
			},
		}).registerGate({
			id: "oversight",
			matcher: (c) => c.name === "send_rejection",
			handler: () => ({
				decision: "needs-approval",
				reasonCode: "OVERSIGHT_REQUIRED",
			}),
		});

		// 1. first call → needs-approval; the tool did NOT run, an approval was persisted
		const r1 = await ec.handleToolCall({
			name: "send_rejection",
			args: { to: "cand-7" },
		});
		expect(r1.status).toBe("needs-approval");
		expect(toolRan).toBeUndefined();
		const [pending] = await store.list({ status: "pending" });
		if (!pending) throw new Error("no pending approval");
		expect(pending.toolName).toBe("send_rejection");

		// 2. a human grants it
		expect((await store.grant(pending.id, "alice"))?.status).toBe("approved");

		// 3. resume → the exact call runs, the oversight gate bypassed
		const r2 = await ec.continueRun(pending.id);
		expect(r2?.status).toBe("ok");
		expect(toolRan).toEqual({ name: "send_rejection", args: { to: "cand-7" } });

		// 4. single-use: a second resume finds nothing
		expect(await ec.continueRun(pending.id)).toBeNull();
	});

	it("continueRun returns null when no store is configured", async () => {
		const ec = createGovernance().registerGate({
			id: "oversight",
			matcher: () => true,
			handler: () => ({ decision: "needs-approval", reason: "confirm" }),
		});
		expect(await ec.continueRun("nope")).toBeNull();
	});
});

describe("euroclaw governance — governance reason codes (plugin-supplied; governance fills the reason)", () => {
	it("a gate denies with just a reason code; governance fills the reason from $REASON_CODES and audits the reason code", async () => {
		const ec = createGovernance({
			audit: createMemoryAudit(),
			plugins: [
				{
					id: "p",
					$REASON_CODES: {
						OVERSIGHT_REQUIRED: {
							code: "OVERSIGHT_REQUIRED",
							message: "Human oversight required",
							toString: () => "OVERSIGHT_REQUIRED",
						},
					},
				},
			],
		}).registerGate({
			id: "floor",
			matcher: () => true,
			handler: () => ({
				decision: "deny",
				reasonCode: "OVERSIGHT_REQUIRED",
			}),
		});

		const r = await ec.handleToolCall({ name: "delete_user", args: {} });
		expect(r.status).toBe("denied");
		if (r.status === "denied") {
			expect(r.reasonCode).toBe("OVERSIGHT_REQUIRED");
			expect(r.reason).toBe("Human oversight required"); // filled from the catalog, not hardcoded in the gate
		}
		// the stable reason code lands in the audit log — queryable, unlike a free-text reason
		expect(ec.audit?.entries().at(-1)).toMatchObject({
			status: "denied",
			reasonCode: "OVERSIGHT_REQUIRED",
			reason: "Human oversight required",
		});
	});

	it("an explicit gate reason wins over the catalog message", async () => {
		const ec = createGovernance({
			plugins: [
				{
					id: "p",
					$REASON_CODES: {
						OVERSIGHT_REQUIRED: {
							code: "OVERSIGHT_REQUIRED",
							message: "Human oversight required",
							toString: () => "OVERSIGHT_REQUIRED",
						},
					},
				},
			],
		}).registerGate({
			id: "floor",
			matcher: () => true,
			handler: () => ({
				decision: "deny",
				reasonCode: "OVERSIGHT_REQUIRED",
				reason: "needs a recruiter on this one",
			}),
		});
		const r = await ec.handleToolCall({ name: "x", args: {} });
		if (r.status === "denied") {
			expect(r.reasonCode).toBe("OVERSIGHT_REQUIRED");
			expect(r.reason).toBe("needs a recruiter on this one");
		}
	});

	it("a reason code with no catalog entry falls back to the bare reason code — never an empty reason", async () => {
		const ec = createGovernance().registerGate({
			id: "floor",
			matcher: () => true,
			handler: () => ({ decision: "deny", reasonCode: "UNREGISTERED" }),
		});
		const r = await ec.handleToolCall({ name: "x", args: {} });
		if (r.status === "denied") {
			expect(r.reasonCode).toBe("UNREGISTERED");
			expect(r.reason).toBe("UNREGISTERED");
		}
	});

	it("needs-approval carries a reason code too", async () => {
		const ec = createGovernance({
			plugins: [
				{
					id: "p",
					$REASON_CODES: {
						NEEDS_RECRUITER: {
							code: "NEEDS_RECRUITER",
							message: "A recruiter must approve",
							toString: () => "NEEDS_RECRUITER",
						},
					},
				},
			],
		}).registerGate({
			id: "floor",
			matcher: () => true,
			handler: () => ({
				decision: "needs-approval",
				reasonCode: "NEEDS_RECRUITER",
			}),
		});
		const r = await ec.handleToolCall({ name: "x", args: {} });
		expect(r.status).toBe("needs-approval");
		if (r.status === "needs-approval") {
			expect(r.reasonCode).toBe("NEEDS_RECRUITER");
			expect(r.reason).toBe("A recruiter must approve");
		}
	});
});

describe("euroclaw governance — the resolveContext hook (neutral; the claw composes identity/membership in)", () => {
	const needsApproval = {
		id: "g",
		matcher: () => true,
		handler: () => ({ decision: "needs-approval" as const }),
	};

	it("a resolveContext hook stamps the principal → recorded on audit + approvals", async () => {
		const { store } = recordingStore();
		const ec = createGovernance({
			resolveContext: (ctx) => ({ ...ctx, euroclaw__principal: "alice" }),
			audit: createMemoryAudit(),
			approvalStore: store,
		}).registerGate(needsApproval);

		await ec.handleToolCall({ name: "reject", args: {} });

		expect((await store.list())[0]?.principal).toBe("alice"); // on the approval
		expect(ec.audit?.entries().at(-1)?.principal).toBe("alice"); // and the audit trail
	});

	it("runs AFTER strip — a caller can't forge the principal; the trusted hook wins", async () => {
		const { store } = recordingStore();
		const ec = createGovernance({
			resolveContext: (ctx) => ({ ...ctx, euroclaw__principal: "real" }),
			approvalStore: store,
		}).registerGate(needsApproval);
		await ec.handleToolCall(
			{ name: "reject", args: {} },
			{ euroclaw__principal: "FORGED" },
		);
		expect((await store.list())[0]?.principal).toBe("real");
	});
});
