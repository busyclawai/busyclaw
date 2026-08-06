// A real claw with the plugin wired, plus a way to reach the capability the way the runtime does.
//
// The capability is obtained from the PLUGIN OBJECT, not constructed directly — so these tests
// exercise the lazy `claw()` thunk and the `configure`-time store binding, which is where the
// construction-order argument actually has to hold. The runtime's own injection (which tool gets
// which capability, and that it is built per call) is pinned in `@busyclaw/runtime`'s tests; this
// covers what the capability then does.

import type {
	Adapter,
	CapabilityContext,
	Principal,
} from "@busyclaw/contracts";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import type { wrapLanguageModel } from "ai";
import { createClaw } from "busyclaw";
import { type AgentCapability, subagents } from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

/** A model that never gets called — every spawn here is driven through the capability directly. */
const idleModel = (): V2Model => ({
	specificationVersion: "v4",
	provider: "mock",
	modelId: "mock",
	supportedUrls: {},
	doGenerate: async () => ({
		content: [{ type: "text", text: "done" }],
		finishReason: { unified: "stop", raw: undefined },
		usage: {
			inputTokens: {
				total: 1,
				noCache: undefined,
				cacheRead: undefined,
				cacheWrite: undefined,
			},
			outputTokens: { total: 1, text: undefined, reasoning: undefined },
		},
		warnings: [],
	}),
	doStream: async () => {
		throw new Error("stream not used");
	},
});

export type SpawnRequest = {
	principal: Principal;
	alias: string;
	prompt: string;
	/** The run doing the spawning. Defaults to one id, so repeated calls are the same parent. */
	parentRunId?: string;
	/** Replay-stable, and part of the derived child id. */
	step?: number;
};

export type SpawningClaw = {
	api: {
		getRun: (
			input: { id: string },
			caller?: { principal?: Principal },
		) => Promise<{ status: string; principal?: string } | null>;
	};
	$tables: unknown;
	spawnFrom: (
		input: SpawnRequest,
	) => Promise<{ childRunId: string; parentRunId: string }>;
	capability: (input: {
		principal: Principal;
		parentRunId?: string;
		step?: number;
	}) => AgentCapability;
	statusFrom: (input: {
		principal: Principal;
		parentRunId?: string;
	}) => Promise<
		readonly { alias: string; childRunId: string; status: string }[]
	>;
};

// ANNOTATED, not inferred. `createClaw`'s return type reaches into `busyclaw`'s internal
// `ClawSchemaConfig`, which is not nameable from here — so an inferred signature is not portable and
// tsc says so. The tests need four members; this names them.
export function spawningClaw(
	options: {
		adapter?: Adapter;
		maxDepth?: number;
		maxChildren?: number;
		/** Stand in for the runtime's container crossing. Identity unless a test supplies one. */
		translate?: CapabilityContext["translate"];
	} = {},
): SpawningClaw {
	const adapter = options.adapter;
	if (adapter === undefined) throw new Error("harness needs an adapter");
	const plugin = subagents({
		...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
		...(options.maxChildren !== undefined
			? { maxChildren: options.maxChildren }
			: {}),
	});
	const claw = createClaw({
		database: adapter,
		model: idleModel(),
		engine: sqlEngine({
			store: createSqlEngineStore(adapter),
			workerId: "w1",
			cron: false,
		}),
		// Explicit rather than incidental: these tests are about spawn, not tokenization, so the
		// container crossing is exercised through an injected `translate` instead. A database-backed
		// claw must say which posture it wants, and "raw" is the honest one here.
		redaction: { posture: "raw" },
		plugins: [plugin],
	} as Parameters<typeof createClaw>[0]);

	const translate =
		options.translate ?? (async <T>(value: T) => value satisfies T as T);

	const capabilityFor = (input: SpawnRequest): AgentCapability => {
		const factory = plugin.capabilities?.agent;
		if (factory === undefined)
			throw new Error("the plugin registered no agent capability");
		return factory({
			runId: input.parentRunId ?? "run-parent",
			principal: input.principal,
			step: input.step ?? 0,
			translate,
		}) as AgentCapability;
	};

	return {
		...claw,
		/** Spawn as if a stamped tool had. */
		async spawnFrom(input: SpawnRequest) {
			const parentRunId = input.parentRunId ?? "run-parent";
			const result = await capabilityFor(input).spawnChild({
				alias: input.alias,
				prompt: input.prompt,
			});
			return { ...result, parentRunId };
		},
		/** ONE capability instance, several spawns — the ordinal path, which a fresh instance per call
		 *  never reaches. This is what a script-layer fan-out looks like from the capability's side. */
		capability(input: {
			principal: Principal;
			parentRunId?: string;
			step?: number;
		}) {
			return capabilityFor({
				principal: input.principal,
				alias: "unused",
				prompt: "unused",
				...(input.parentRunId !== undefined
					? { parentRunId: input.parentRunId }
					: {}),
				...(input.step !== undefined ? { step: input.step } : {}),
			});
		},
		async statusFrom(input: { principal: Principal; parentRunId?: string }) {
			return capabilityFor({
				principal: input.principal,
				alias: "unused",
				prompt: "unused",
				...(input.parentRunId !== undefined
					? { parentRunId: input.parentRunId }
					: {}),
			}).status();
		},
	};
}
