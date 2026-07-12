// The `redaction` config group — policy vocabulary over the mechanism ports. The assembly derives
// the PII mapping store from the SAME `database` as every other store, wires per-claw posture
// routing over the claw row, and hands the runtime ONE resolved Redactor. Mechanism lives in
// @euroclaw/core (createStoredRedactor / createRoutingRedactor / createInertRedactor); this module
// only assembles it. See docs/plans/redaction-dx-plan.md.
import type {
	Adapter,
	ClawsStore,
	Detector,
	RedactionContext,
	Redactor,
} from "@euroclaw/contracts";
import { configurationError, field } from "@euroclaw/contracts";
import {
	type ContainerPosture,
	createInertRedactor,
	createMemoryPiiMappingStore,
	createRoutingRedactor,
	createStoredRedactor,
} from "@euroclaw/core";
import { createPiiMappingStore } from "@euroclaw/storage-durable";

export const REDACTION_POSTURES = ["strict", "raw"] as const;

/** The claw column per-claw posture rides on — set at creation, immutable after (a mixed-posture
 *  transcript would break both the coreference and the erasure story; new posture = new claw). */
export const clawRedactionFields = {
	redaction: field.enum(REDACTION_POSTURES),
} as const;

export type StrictRedactionConfig = {
	/** Every container redacted. The default arm. */
	posture?: "strict";
	/** What counts as PII. Omit → armed-but-silent (mechanism on, nothing detected). */
	detector?: Detector;
	/** Dedup key — deterministic placeholders per (value, kind, container). Loss/rotation only
	 *  resets dedup, never rehydration. */
	indexKey?: string;
	/** Full-custom escape hatch (tests, exotic stores); mutually exclusive with detector/indexKey. */
	redactor?: Redactor;
};

export type PerClawRedactionConfig = Omit<StrictRedactionConfig, "posture"> & {
	/** Posture per claw row: chosen at row creation via the `redaction` field, immutable after. */
	posture: "per-claw";
	/** Posture for NEW claw rows and for context-less redactions. Default "strict" (fail closed). */
	default?: ContainerPosture;
};

/** The explicit opt-out: durable state persists unredacted, so per-subject erasure does not exist
 *  for this deployment. Boots with one warning — chosen, never accidental. */
export type RawRedactionConfig = { posture: "raw" };

export type RedactionConfig =
	| StrictRedactionConfig
	| PerClawRedactionConfig
	| RawRedactionConfig;

/** The placeholder contract, appended to the system prompt whenever redaction is armed — the model
 *  must know the tokens are stable, opaque, and to be passed to tools verbatim. */
// NOTE: the schematic form below must never be a WELL-FORMED token — a live-format example would
// serialize into every prompt ahead of real tokens and become a decoy for the model (and for
// anything scanning the prompt). The angle-bracket placeholders keep it unmatchable.
export const REDACTION_SYSTEM_FRAGMENT = [
	"Some values in this conversation appear as privacy placeholders of the form",
	"{{pii:<kind>:<id>}}. They are opaque, stable tokens: the same token always denotes the",
	"same underlying value, and different tokens denote different values. Treat a token as",
	"the value itself and pass it to tools verbatim — tools receive the real value",
	"automatically. Never invent, alter, or expand a placeholder, and never guess what one",
	"stands for.",
].join(" ");

export type ResolvedRedaction = {
	redactor?: Redactor;
	/** A detector or custom redactor is present — placeholders can actually appear, so the model
	 *  gets the placeholder contract appended to its system prompt. */
	armed: boolean;
	perClaw: boolean;
};

/** Reject a `redaction` patch — posture is a birth fact of the row. Wrapped ONCE by the assembly
 *  when posture is per-claw, so every writer (api, plugins, event sinks) sees the same wall. */
export function withImmutableRedaction(store: ClawsStore): ClawsStore {
	return {
		...store,
		claws: {
			...store.claws,
			// Async so the wall is a REJECTION (the port's shape), never a sync throw mid-call-site.
			update: async (id, patch) => {
				if (
					patch !== null &&
					typeof patch === "object" &&
					"redaction" in patch
				) {
					throw configurationError(
						"redaction posture is immutable after claw creation",
						{ clawId: id, reason: "create a new claw for a different posture" },
					);
				}
				return store.claws.update(id, patch);
			},
		},
	};
}

export function resolveRedaction(input: {
	config: RedactionConfig | undefined;
	adapter: Adapter | undefined;
	/** Required for posture "per-claw" (the routing reads the claw row). Pass the WRAPPED store. */
	clawsStore: ClawsStore | undefined;
	warn: (message: string) => void;
}): ResolvedRedaction {
	const cfg = input.config;
	if (cfg === undefined) return { armed: false, perClaw: false };

	if (cfg.posture === "raw") {
		input.warn(
			'redaction posture "raw": durable state persists unredacted — per-subject erasure is unavailable for this deployment',
		);
		return { redactor: createInertRedactor(), armed: false, perClaw: false };
	}

	if (cfg.redactor && (cfg.detector !== undefined || cfg.indexKey !== undefined)) {
		throw configurationError(
			"redaction.redactor is mutually exclusive with detector/indexKey",
			{ reason: "a custom redactor owns its own detection and dedup" },
		);
	}
	const strict =
		cfg.redactor ??
		createStoredRedactor({
			mappings: input.adapter
				? createPiiMappingStore(input.adapter)
				: createMemoryPiiMappingStore(),
			...(cfg.detector !== undefined ? { detector: cfg.detector } : {}),
			...(cfg.indexKey !== undefined ? { indexKey: cfg.indexKey } : {}),
			warn: input.warn,
		});
	const armed = cfg.redactor !== undefined || cfg.detector !== undefined;

	if (cfg.posture !== "per-claw") {
		return { redactor: strict, armed, perClaw: false };
	}

	const clawsStore = input.clawsStore;
	if (clawsStore === undefined) {
		throw configurationError(
			'redaction posture "per-claw" requires a database',
			{ reason: "the per-row posture lives on the claw row" },
		);
	}
	const defaultPosture: ContainerPosture = cfg.default ?? "strict";
	// Posture is immutable at birth, so a row's resolved posture caches forever — invalidation is
	// a non-problem by construction. Unknown rows are NOT cached (the row may appear later).
	const postureCache = new Map<string, ContainerPosture>();
	const postureOf = async (
		ctx?: RedactionContext,
	): Promise<ContainerPosture> => {
		const scopeId = ctx?.scope === "claw" ? ctx.scopeId : undefined;
		if (scopeId === undefined) return defaultPosture;
		const cached = postureCache.get(scopeId);
		if (cached !== undefined) return cached;
		const row = await clawsStore.claws.get(scopeId);
		if (row === null) return defaultPosture;
		const value = (row as Record<string, unknown>)["redaction"];
		const posture =
			value === "raw" || value === "strict" ? value : defaultPosture;
		postureCache.set(scopeId, posture);
		return posture;
	};
	return {
		redactor: createRoutingRedactor({ strict, postureOf }),
		armed,
		perClaw: true,
	};
}
