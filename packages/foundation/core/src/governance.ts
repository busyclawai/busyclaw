// The neutral governance. `createGovernance({})` is a TRUE inert pass-through: no redaction,
// no audit, no gates. Everything is opt-in. One governed call is:
//   validate → strip reserved ctx → redact (edge) → before-gates → tool → after-gates.
// The factory is generic over the config (the better-auth pattern): it captures the
// plugin tuple as a literal type and folds each plugin's $Infer / $InferContext /
// $REASON_CODES onto the instance and the turn context.
// See docs/architecture/02a + 04 and docs/research/better-auth/.

import {
	type AfterGate,
	type ApprovalMetadataResolver,
	type ApprovalStore,
	type AuditSink,
	type BoundaryCall,
	type BoundaryGate,
	type ContextResolver,
	type BusyclawPlugin,
	type Gate,
	gateDecision,
	type HandleResult,
	type InferContext,
	type InferPlugins,
	type InferReasonCodes,
	type ModelCall,
	type ModelRunner,
	modelCall,
	type Outcome,
	type PolicyAnnotations,
	RESERVED_CONTEXT_PREFIX,
	type ReasonCode,
	type Redactor,
	redactionContextFrom,
	type ToolCall,
	type ToolRunner,
	type TurnContext,
	toolCall,
} from "@busyclaw/contracts";
import {
	configurationError,
	stateError,
	validationError,
} from "@busyclaw/errors";
import { type } from "arktype";
import { approvalGate } from "./approval";
import { auditGate } from "./audit";
import { createMemoryRedactor } from "./redact";

export type GovernanceConfig = {
	/**
	 * The redaction substrate (Redactor port). Providing one turns redaction ON. A stored redactor
	 * uses a PiiMappingStore — the re-identification store mapping placeholders back to original PII.
	 * Omit → no redaction.
	 */
	redactor?: Redactor;
	/** The audit store (AuditSink port). Providing one turns audit ON. Omit → no audit. */
	audit?: AuditSink;
	/**
	 * The approval store (ApprovalStore port). Providing one persists every needs-approval call
	 * so it survives a restart and a human can grant it. Omit → needs-approval is in-flight only.
	 */
	approvalStore?: ApprovalStore;
	/** Optional metadata attached to persisted approvals. Runtime uses this for checkpoints. */
	approvalMetadata?: ApprovalMetadataResolver;
	/**
	 * A trusted hook to enrich the context before gates run (after reserved keys are stripped). The
	 * claw composes its `identity`/`membership` resolution into this; governance just runs it. Omit → none.
	 */
	resolveContext?: ContextResolver;
	/** Plugins — each contributes gates (runtime) and folded types (compile time). */
	plugins?: readonly BusyclawPlugin[];
	/** Executes a permitted tool. Default just echoes the call (no real effect). */
	runTool?: ToolRunner;
	/** Invokes the model (LLM). Required to use `handleModelCall`. Keeps governance SDK-agnostic. */
	callModel?: ModelRunner;
	/** The host's single operator-notice door, handed to every after-gate handler so a plugin
	 *  OBSERVER reports a swallowed failure where the host is already looking (the runtime threads
	 *  `RuntimeConfig.warn` in here, already defaulted to `console.warn`). NOT a logger, and never a
	 *  decision path. Omit → silent, the same rule redact.ts states: core has no console. */
	warn?: (message: string) => void;
	/** Time source (a Clock port, simplified). */
	now?: () => string;
};

/** The turn context for a given config: the base bag + every plugin's contributed fields. */
export type Context<Config extends GovernanceConfig> = TurnContext &
	InferContext<Config>;

export type Governance<Config extends GovernanceConfig = GovernanceConfig> = {
	/** Add a boundary before-gate — decides across tool/model boundaries. Chainable. */
	registerBoundaryGate: (
		gate: BoundaryGate<Context<Config>>,
	) => Governance<Config>;
	/** Add a before-gate — decides permit/deny/needs-approval. Chainable. */
	registerGate: (gate: Gate<Context<Config>>) => Governance<Config>;
	/** Add an after-gate — observes the outcome (runs even on deny/error). Chainable. */
	registerAfterGate: (gate: AfterGate<Context<Config>>) => Governance<Config>;
	/** Run one governed tool call through the pipeline. */
	handleToolCall: (
		call: ToolCall,
		ctx?: Context<Config>,
	) => Promise<HandleResult>;
	/** Run one governed model (LLM) call: redact the prompt → invoke → audit. */
	handleModelCall: (
		call: ModelCall,
		ctx?: Context<Config>,
	) => Promise<HandleResult>;
	/**
	 * Gate a model call WITHOUT running it — the streaming counterpart to handleModelCall's
	 * gate+run bundle. Redacts the prompt, runs the model-boundary before-gates, and returns their
	 * outcome (`ok` when permitted). The caller (a streaming loop) then streams the model itself.
	 */
	checkModelBoundary: (
		call: ModelCall,
		ctx?: Context<Config>,
	) => Promise<HandleResult>;
	/**
	 * Decide tool calls WITHOUT running them — the tool-side sibling of {@link checkModelBoundary},
	 * and the substrate for DISCLOSURE (telling the agent what the floor would say before it spends a
	 * turn finding out). Before-gates only, through the very same code path a real call takes: no
	 * tool runs, and NO AFTER-GATE fires, so nothing is audited, nothing is parked, nothing is
	 * recorded. Asking is not doing.
	 *
	 * ADVISORY, NEVER AUTHORIZATION. An answer here is a decision about the call as ASKED, and a
	 * caller who only has a tool name asks with no arguments — while a gate may read them. It is also
	 * point-in-time: policy and scopes can change before the call. Nothing may act on this; the real
	 * call is decided again, by these same gates, and that decision is the only one that governs.
	 *
	 * BATCHED because the turn context resolves ONCE for the whole set — a disclosure over a page of
	 * tools must not re-run the host's identity/membership resolution per tool. Results are index-
	 * aligned with `calls`. A gate that throws on a call it cannot decide answers `error` for that
	 * call alone and never fails the batch: refusing to decide is not a denial.
	 */
	checkToolCalls: (
		calls: readonly ToolCall[],
		ctx?: Context<Config>,
	) => Promise<readonly Outcome[]>;
	/**
	 * Continue an approved tool call: atomically consume the approval (single-use) and re-run the
	 * stored call, bypassing the gate that demanded approval. Every other gate + audit still fire.
	 * Returns the governed result, or `null` if the approval isn't consumable (absent / not granted /
	 * expired / already used / no store configured).
	 */
	continueRun: (
		id: string,
		ctx?: Context<Config>,
	) => Promise<HandleResult | null>;
	readonly audit?: AuditSink;
	/** The approval store, if one was configured — grant/deny/consume/list pending approvals. */
	readonly approvals?: ApprovalStore;
	readonly redactor: Redactor;
	/** Named types contributed by this config's plugins. `{}` at runtime — types only. */
	readonly $Infer: InferPlugins<Config>;
	/** Merged governance reason-code catalog from every plugin (real values + types). */
	readonly $REASON_CODES: InferReasonCodes<Config>;
};

const defaultRunTool: ToolRunner = (call) => ({ ran: call.name });

/** Drop caller-supplied reserved keys so identity can't be forged from outside. */
function stripReserved(ctx: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(ctx)) {
		if (!k.startsWith(RESERVED_CONTEXT_PREFIX)) out[k] = v;
	}
	return out;
}

// The generic-config factory shape — capture the config as a literal type, fold every
// plugin's types onto the result — mirrors better-auth's `betterAuth<Options>(options)`.
// Pattern/API only; the fold machinery lives in plugin.ts. See THIRD_PARTY_NOTICES.md.
export function createGovernance<const Config extends GovernanceConfig>(
	// One blessed cast: the impl needs the wide value AND the generic for the phantom folds below,
	// so the empty-default takes the parameter's type (same family as the `$Infer: {} as …` phantoms).
	config: Config = {} as Config,
): Governance<Config> {
	// Each capability is enabled by providing its port (config keys, like a `database`).
	const redactionOn = config.redactor !== undefined;
	const redactor = config.redactor ?? createMemoryRedactor();
	const auditSink = config.audit;
	const approvalStore = config.approvalStore;
	const approvalMetadata = config.approvalMetadata;
	const resolveContext = config.resolveContext;
	const runTool = config.runTool ?? defaultRunTool;
	const callModel = config.callModel;
	// Resolved ONCE, before any gate runs — so an after-gate takes it as a plain argument and never
	// has to `?.` it (the rule the plugin configure context's `secrets` follows). Unset is SILENT, not
	// console: core has no console (redact.ts says the same), and the runtime — which does — hands its
	// already-defaulted `RuntimeConfig.warn` down, so every assembled claw's plugins get a real door.
	const warn = config.warn ?? (() => {});
	const now = config.now ?? (() => new Date().toISOString());
	const plugins = config.plugins ?? [];

	const toolBoundaryCall = (call: ToolCall): BoundaryCall => ({
		boundary: "tool",
		name: call.name,
		payload: call.args,
		toolCall: call,
	});
	const modelBoundaryCall = (call: ModelCall): BoundaryCall => ({
		boundary: "model",
		name: "model",
		payload: { messages: call.messages },
		modelCall: call,
	});

	// Reason codes are real runtime values — merge every plugin's catalog into one. A gate may deny
	// with just a `reasonCode`; this is how governance fills the human-readable reason from that code.
	const reasonCodes: Record<string, ReasonCode> = Object.assign(
		{},
		...plugins.map((p) => p.$REASON_CODES ?? {}),
	);
	// The reason on the way out: the gate's explicit reason, else the catalog message for its
	// reason code, else the bare reason code, else "". So a code-only denial still yields a string.
	const resolveReason = (v: { reason?: string; reasonCode?: string }): string =>
		v.reason ??
		(v.reasonCode ? (reasonCodes[v.reasonCode]?.message ?? v.reasonCode) : "");

	// Both annotation bags off a verdict, copied together onto the outcome. Together because they are
	// one fact split by AUDIENCE, and forgetting the model half at one of four sites would make an
	// annotation reach the agent on some paths and not others. Governance reads neither: which key
	// belongs to which audience was settled by its declaration, in the engine.
	const annotationsOf = (v: {
		annotations?: PolicyAnnotations;
		modelAnnotations?: PolicyAnnotations;
	}): {
		annotations?: PolicyAnnotations;
		modelAnnotations?: PolicyAnnotations;
	} => ({
		...(v.annotations ? { annotations: v.annotations } : {}),
		...(v.modelAnnotations ? { modelAnnotations: v.modelAnnotations } : {}),
	});

	// Internal lists are context-erased; the typed surface lives on the methods.
	const boundaryBefore: BoundaryGate<TurnContext>[] = [];
	const before: Gate<TurnContext>[] = [];
	const after: AfterGate<TurnContext>[] = [];
	const sealed = new Set<string>();
	const boundaryGateIds = new Set<string>();
	const toolGateIds = new Set<string>();

	// The governance wires nothing of its own — except two observer after-gates, each *if* you asked:
	// audit (record every outcome) and approval (persist a needs-approval so it survives a restart).
	if (auditSink) after.push({ ...auditGate(auditSink, now), sealed: true });
	if (approvalStore)
		after.push({
			...approvalGate(approvalStore, now, approvalMetadata),
			sealed: true,
		});

	function add(
		list: { id: string; sealed?: boolean }[],
		gate: { id: string; sealed?: boolean },
		kind?: "boundary" | "tool",
	): void {
		if (kind === "boundary" && toolGateIds.has(gate.id)) {
			throw stateError(
				`gate "${gate.id}" is already registered as a tool gate`,
				{ gateId: gate.id },
			);
		}
		if (kind === "tool" && boundaryGateIds.has(gate.id)) {
			throw stateError(
				`gate "${gate.id}" is already registered as a boundary gate`,
				{ gateId: gate.id },
			);
		}
		const i = list.findIndex((g) => g.id === gate.id);
		if (i !== -1) {
			if (sealed.has(gate.id) || list[i]?.sealed) {
				throw stateError(
					`gate "${gate.id}" is sealed and cannot be redefined`,
					{
						gateId: gate.id,
					},
				);
			}
			list.splice(i, 1);
		}
		if (gate.sealed) {
			const firstUnsealed = list.findIndex((g) => !g.sealed);
			list.splice(firstUnsealed === -1 ? list.length : firstUnsealed, 0, gate);
		} else {
			list.push(gate);
		}
		if (gate.sealed) sealed.add(gate.id);
		if (kind === "boundary") boundaryGateIds.add(gate.id);
		if (kind === "tool") toolGateIds.add(gate.id);
	}

	// Plugins install their gates now; their folded types are applied at compile time.
	for (const plugin of plugins) {
		for (const gate of plugin.boundaryGates ?? [])
			add(boundaryBefore, gate, "boundary");
		for (const gate of plugin.gates ?? []) add(before, gate, "tool");
		for (const gate of plugin.afterGates ?? []) add(after, gate);
	}

	// Strip caller-forged reserved keys, then let the trusted resolveContext hook (the claw's composed
	// identity/membership) populate them — after strip, before gates. Governance runs it; it doesn't resolve.
	async function resolveCtx(
		ctxInput: Record<string, unknown> | undefined,
	): Promise<Record<string, unknown>> {
		const ctx = stripReserved(ctxInput ?? {});
		return resolveContext ? await resolveContext(ctx) : ctx;
	}

	async function runBoundaryBeforeGates(
		call: BoundaryCall,
		ctx: Record<string, unknown>,
		input: { bypassGateId?: string; allowApproval: boolean },
	): Promise<Extract<
		HandleResult,
		{ status: "denied" | "needs-approval" }
	> | null> {
		for (const gate of boundaryBefore) {
			if (gate.id === input.bypassGateId) continue;
			if (!gate.matcher(call, ctx)) continue;
			const verdict = gateDecision(await gate.handler(call, ctx));
			if (verdict instanceof type.errors) {
				throw validationError(
					`boundary gate "${gate.id}" returned an invalid decision`,
					verdict.summary,
					{ gateId: gate.id },
				);
			}
			if (verdict.decision === "deny") {
				return {
					status: "denied",
					gateId: gate.id,
					reason: resolveReason(verdict),
					reasonCode: verdict.reasonCode,
					...annotationsOf(verdict),
				};
			}
			if (verdict.decision === "needs-approval") {
				if (!input.allowApproval) {
					throw stateError(
						"model boundary approval waits are unsupported; deny model egress and retry after a policy exception",
						{ gateId: gate.id },
					);
				}
				return {
					status: "needs-approval",
					gateId: gate.id,
					reason: resolveReason(verdict),
					reasonCode: verdict.reasonCode,
					...annotationsOf(verdict),
				};
			}
		}
		return null;
	}

	// The tool before-gates, in order — the DECISION half of the pipeline, factored out so the
	// disclosure probe (`checkToolCalls`) and a real call cannot drift apart: one implementation, so
	// "what the floor would say" is literally what the floor says. Null when nothing objected.
	async function runToolBeforeGates(
		call: ToolCall,
		ctx: Record<string, unknown>,
		bypassGateId?: string,
	): Promise<Extract<
		HandleResult,
		{ status: "denied" | "needs-approval" }
	> | null> {
		for (const gate of before) {
			if (gate.id === bypassGateId) continue; // pre-approved → skip this gate exactly once
			if (!gate.matcher(call, ctx)) continue;
			const verdict = gateDecision(await gate.handler(call, ctx));
			if (verdict instanceof type.errors) {
				throw validationError(
					`gate "${gate.id}" returned an invalid decision`,
					verdict.summary,
					{ gateId: gate.id },
				);
			}
			if (verdict.decision === "deny") {
				return {
					status: "denied",
					gateId: gate.id,
					reason: resolveReason(verdict),
					reasonCode: verdict.reasonCode,
					...annotationsOf(verdict),
				};
			}
			if (verdict.decision === "needs-approval") {
				// The pipeline only DECIDES. Persisting the pending approval (when a store is configured)
				// is an observer's job — the approvalGate after-gate, same as audit.
				return {
					status: "needs-approval",
					gateId: gate.id,
					reason: resolveReason(verdict),
					reasonCode: verdict.reasonCode,
					...annotationsOf(verdict),
				};
			}
		}
		return null;
	}

	// The governed pipeline over an ALREADY-REDACTED call: boundary-gates → tool-gates → tool → after-gates.
	// `handleToolCall` feeds it a freshly-redacted call; `continueRun` feeds it the stored call
	// and passes `bypassGateId` to skip (exactly once) the gate that demanded approval.
	async function runGoverned(
		call: ToolCall,
		ctx: Record<string, unknown>,
		bypassGateId?: string,
	): Promise<HandleResult> {
		let outcome: Outcome | null = null;
		const boundaryCall = toolBoundaryCall(call);
		try {
			const boundaryOutcome = await runBoundaryBeforeGates(boundaryCall, ctx, {
				allowApproval: true,
				bypassGateId,
			});
			if (boundaryOutcome) {
				outcome = boundaryOutcome;
				return boundaryOutcome;
			}
			const gateOutcome = await runToolBeforeGates(call, ctx, bypassGateId);
			if (gateOutcome) {
				outcome = gateOutcome;
				return gateOutcome;
			}
			// Permitted → run the tool. PII rehydrated *inside* the boundary only.
			const output = await runTool(call, ctx, {
				rehydrate: (v) => redactor.rehydrateValue(v, redactionContextFrom(ctx)),
			});
			outcome = { status: "ok", output };
			return outcome;
		} catch (err) {
			const rawReason = err instanceof Error ? err.message : String(err);
			outcome ??= {
				status: "error",
				reason: redactionOn
					? await redactor.redactValue(rawReason, redactionContextFrom(ctx))
					: rawReason,
			};
			throw err;
		} finally {
			// After-gates — observe the outcome. Always run (audit + approval are these).
			const final: Outcome = outcome ?? { status: "error", reason: "unknown" };
			for (const gate of after) {
				if (gate.matcher(boundaryCall, ctx))
					await gate.handler(boundaryCall, ctx, final, warn);
			}
		}
	}

	async function runAfterGates(
		call: BoundaryCall,
		ctx: Record<string, unknown>,
		outcome: Outcome,
	): Promise<void> {
		for (const gate of after) {
			if (gate.matcher(call, ctx)) await gate.handler(call, ctx, outcome, warn);
		}
	}

	const api: Governance<Config> = {
		registerBoundaryGate(gate) {
			add(boundaryBefore, gate, "boundary");
			return api;
		},

		registerGate(gate) {
			add(before, gate, "tool");
			return api;
		},

		registerAfterGate(gate) {
			add(after, gate);
			return api;
		},

		async handleModelCall(rawCall, ctxInput) {
			if (!callModel) {
				throw configurationError(
					"handleModelCall requires config.callModel — tell busyclaw how to invoke your model",
				);
			}
			// Validate, strip reserved ctx, redact the prompt at the edge — PII never leaves
			// for the model provider. The model reasons on placeholders; rehydration happens
			// only at the tool boundary, so there is nothing to rehydrate here.
			const valid = modelCall(rawCall);
			if (valid instanceof type.errors) {
				throw validationError("invalid model call", valid.summary);
			}
			const ctx = await resolveCtx(ctxInput);
			const call: ModelCall = redactionOn
				? await redactor.redactValue(valid, redactionContextFrom(ctx))
				: valid;

			let outcome: Outcome | null = null;
			const boundaryCall = modelBoundaryCall(call);
			try {
				const boundaryOutcome = await runBoundaryBeforeGates(
					boundaryCall,
					ctx,
					{
						allowApproval: false,
					},
				);
				if (boundaryOutcome) {
					outcome = boundaryOutcome;
					return boundaryOutcome;
				}
				const output = await callModel(call, ctx);
				outcome = { status: "ok", output };
				return outcome;
			} catch (err) {
				const rawReason = err instanceof Error ? err.message : String(err);
				outcome ??= {
					status: "error",
					reason: redactionOn
						? await redactor.redactValue(rawReason, redactionContextFrom(ctx))
						: rawReason,
				};
				throw err;
			} finally {
				const final: Outcome = outcome ?? {
					status: "error",
					reason: "unknown",
				};
				await runAfterGates(boundaryCall, ctx, final);
			}
		},

		async checkModelBoundary(rawCall, ctxInput) {
			const valid = modelCall(rawCall);
			if (valid instanceof type.errors) {
				throw validationError("invalid model call", valid.summary);
			}
			const ctx = await resolveCtx(ctxInput);
			const call: ModelCall = redactionOn
				? await redactor.redactValue(valid, redactionContextFrom(ctx))
				: valid;
			const boundaryOutcome = await runBoundaryBeforeGates(
				modelBoundaryCall(call),
				ctx,
				{ allowApproval: false },
			);
			// Permitted → ok (the caller streams the model); otherwise the gate's deny/needs-approval.
			return boundaryOutcome ?? { status: "ok", output: undefined };
		},

		async checkToolCalls(rawCalls, ctxInput) {
			// ONE resolution for the whole batch — see the doc comment: a page of disclosures must not
			// cost a page of identity/membership lookups.
			const ctx = await resolveCtx(ctxInput);
			const outcomes: Outcome[] = [];
			for (const rawCall of rawCalls) {
				try {
					const valid = toolCall(rawCall);
					if (valid instanceof type.errors) {
						throw validationError("invalid tool call", valid.summary);
					}
					// Redacted exactly as a real call is, so a gate reading args sees what it always sees.
					const args = redactionOn
						? await redactor.redactValue(valid.args, redactionContextFrom(ctx))
						: valid.args;
					const call: ToolCall = { name: valid.name, args };
					const boundaryOutcome = await runBoundaryBeforeGates(
						toolBoundaryCall(call),
						ctx,
						{ allowApproval: true },
					);
					outcomes.push(
						boundaryOutcome ??
							(await runToolBeforeGates(call, ctx)) ?? {
								status: "ok",
								output: undefined,
							},
					);
				} catch (err) {
					// A gate that throws has not denied anything — it declined to decide (a fail-closed
					// mapper with no stamped principal, a gate that assumes arguments this probe has
					// none of). Report that as itself: a caller may not read it as a "no", and the batch
					// carries on so one brittle gate cannot blank a whole disclosure.
					const rawReason = err instanceof Error ? err.message : String(err);
					outcomes.push({
						status: "error",
						reason: redactionOn
							? await redactor.redactValue(rawReason, redactionContextFrom(ctx))
							: rawReason,
					});
				}
			}
			return outcomes;
		},

		async handleToolCall(rawCall, ctxInput) {
			// 0. Validate the inbound call at runtime — the LLM is untrusted input.
			const valid = toolCall(rawCall);
			if (valid instanceof type.errors) {
				throw validationError("invalid tool call", valid.summary);
			}
			// Trust seam: a caller cannot forge busyclaw__* identity — stripped, then the configured
			// resolver (if any) stamps the principal.
			const ctx = await resolveCtx(ctxInput);
			// Redact at the edge — only if configured. Otherwise the call passes through.
			const args = redactionOn
				? await redactor.redactValue(valid.args, redactionContextFrom(ctx))
				: valid.args;
			return runGoverned({ name: valid.name, args }, ctx);
		},

		async continueRun(id, ctxInput) {
			if (!approvalStore) return null;
			// Atomically take the APPROVED record (single-use — concurrent resumes get exactly one winner).
			const record = await approvalStore.consume(id);
			if (!record) return null;
			const ctx = await resolveCtx(ctxInput);
			// The stored args are already REDACTED. Re-run the exact call, bypassing the gate that
			// demanded approval (now granted) — every OTHER gate + the audit still fire.
			return runGoverned(
				{ name: record.toolName, args: record.args },
				ctx,
				record.gateId,
			);
		},

		audit: auditSink,
		approvals: approvalStore,
		redactor,
		$Infer: {} as InferPlugins<Config>,
		$REASON_CODES: reasonCodes as InferReasonCodes<Config>,
	};

	return api;
}
