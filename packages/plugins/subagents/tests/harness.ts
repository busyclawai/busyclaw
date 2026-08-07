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
	/** Withhold `requestAwait`, the way an ad-hoc `generate` with no loop does. */
	canPark?: boolean;
};

export type SpawningClaw = {
	plugin: ReturnType<typeof subagents>;
	adapter: Adapter;
	/** Every waitId the capability asked to park on, in order. */
	parkRequests: string[];
	/** The undelivered messages sitting in a run's engine inbox. */
	inboxOf: (runId: string) => Promise<{ text?: string }[]>;
	/** One reconciler pass. */
	runCron: (limit?: number) => Promise<{
		processed?: number;
		status?: string;
		data?: unknown;
	}>;
	api: {
		getRun: (
			input: { id: string },
			caller?: { principal?: Principal },
		) => Promise<{
			status: string;
			principal?: string;
			clawId?: string;
			threadId?: string;
		} | null>;
	};
	$tables: unknown;
	spawnFrom: (
		input: SpawnRequest,
	) => Promise<{ childRunId: string; parentRunId: string }>;
	/** A REAL parent run, because the door copies the child's claw off the parent's row and refuses
	 *  a parent it cannot find. */
	openRun: (principal: Principal, clawId?: string) => Promise<string>;
	capability: (input: {
		principal: Principal;
		parentRunId?: string;
		step?: number;
		canPark?: boolean;
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
	options: { adapter?: Adapter; maxDepth?: number; maxChildren?: number } = {},
): SpawningClaw {
	const adapter = options.adapter;
	if (adapter === undefined) throw new Error("harness needs an adapter");
	const plugin = subagents({
		...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
		...(options.maxChildren !== undefined
			? { maxChildren: options.maxChildren }
			: {}),
	});
	// The runtime half the ASSEMBLY builds — captured on the way past, because `createClaw` merges it
	// into its own private plugin list and hands nothing back. Wrapping `configure` is the only seam
	// that sees the real context (clawsStore, engine, checkpoints) rather than one a test invented.
	let runtimeHalf:
		| { cron?: readonly { handler: (ctx: never) => unknown }[] }
		| undefined;
	const observed = {
		...plugin,
		configure(context: Parameters<NonNullable<typeof plugin.configure>>[0]) {
			const half = plugin.configure?.(context);
			runtimeHalf = half as typeof runtimeHalf;
			return half;
		},
	};

	const claw = createClaw({
		database: adapter,
		model: idleModel(),
		// REQUIRED now, because the plugin declares `$HasCron`. The reconciler is the only thing that
		// ever learns a child failed, so a host that installs subagents and schedules nothing has parents
		// that park and never wake. These suites drive it by hand rather than on a timer.
		cronHandler: { secret: "test-cron-secret" },
		engine: sqlEngine({
			store: createSqlEngineStore(adapter),
			workerId: "w1",
			cron: false,
		}),
		// Explicit rather than incidental: these tests are about spawn, not tokenization, so the
		// container crossing is exercised through an injected `translate` instead. A database-backed
		// claw must say which posture it wants, and "raw" is the honest one here.
		redaction: { posture: "raw" },
		plugins: [observed],
	} as Parameters<typeof createClaw>[0]);

	// WHAT THE LOOP WOULD HAVE DONE. The runtime binds `requestAwait` to its own run state and parks at
	// the next step boundary; here it just records the token, so a suite can assert that `await` asked
	// to park without standing up a whole model loop to watch it happen.
	const parkRequests: string[] = [];

	const capabilityFor = (input: SpawnRequest): AgentCapability => {
		const factory = plugin.capabilities?.agent;
		if (factory === undefined)
			throw new Error("the plugin registered no agent capability");
		return factory({
			runId: input.parentRunId ?? "run-parent",
			principal: input.principal,
			step: input.step ?? 0,
			...(input.canPark === false
				? {}
				: {
						requestAwait: (waitId: string) => {
							parkRequests.push(waitId);
						},
					}),
		}) as AgentCapability;
	};

	return {
		...claw,
		plugin,
		adapter,
		parkRequests,
		async inboxOf(runId: string) {
			const rows = await adapter.findMany({
				model: "run_message",
				where: [{ field: "toRunId", value: runId }],
				sortBy: { field: "seq", direction: "asc" },
			});
			// PARSED HERE, because this reads the RAW adapter rather than an entity view — a typed JSON
			// column is still a string in the column, and the entity layer is what would parse it. Read
				// raw on purpose: the point is to see exactly what the engine stored.
			return (rows as { body?: unknown }[]).map((row) => {
				const body =
					typeof row.body === "string"
						? (JSON.parse(row.body) as { text?: string })
						: (row.body as { text?: string } | undefined);
				return { ...(body?.text !== undefined ? { text: body.text } : {}) };
			});
		},
		/**
		 * One reconciler pass, invoked the way an adapter's cron trigger would.
		 *
		 * Through the runtime half the ASSEMBLY built, captured above — not by calling `configure` a
		 * second time with a hand-made context. That second call would rebind the plugin to a context
		 * missing `clawsStore` and the engine, and every later assertion would be measuring a
		 * differently-wired plugin than the one the claw is using.
		 */
		async runCron(limit?: number) {
			const entry = runtimeHalf?.cron?.[0];
			if (entry === undefined) throw new Error("no reconciler registered");
			return entry.handler(
				(limit !== undefined ? { limit } : {}) as never,
			) as Promise<{ processed?: number; status?: string; data?: unknown }>;
		},
		async openRun(principal: Principal, clawId?: string) {
			// A parent WITH a claw is what the descendant stamp needs to inherit. Written through the
			// engine's own input rather than the door, because the door only ever derives it.
			if (clawId !== undefined) {
				// A REAL claw, because giving the run a `clawId` changes its authz parent: the run
				// loader climbs to the claw for grant parents, so a run pointed at a claw that does not
				// exist is a run nobody can read. That is the mechanism working, and the test has to
				// respect it.
				await (
					claw as unknown as {
						api: {
							createClaw: (
								i: { id: string; name: string },
								c: { principal: Principal },
							) => Promise<unknown>;
						};
					}
				).api.createClaw({ id: clawId, name: "Parent" }, { principal });
				const started = await (
					claw as unknown as {
						$context: {
							engine?: {
								startRun: (i: {
									prompt: string;
									clawId: string;
									run: { principal: Principal };
								}) => Promise<{ id: string }>;
							};
						};
					}
				).$context.engine?.startRun({
					prompt: "parent",
					clawId,
					run: { principal },
				});
				if (started === undefined) throw new Error("no engine");
				return started.id;
			}
			const started = await (
				claw as unknown as {
					api: {
						startRun: (
							i: { prompt: string },
							c: { principal: Principal },
						) => Promise<{ id: string }>;
					};
				}
			).api.startRun({ prompt: "parent" }, { principal });
			return started.id;
		},
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
			canPark?: boolean;
		}) {
			return capabilityFor({
				principal: input.principal,
				alias: "unused",
				prompt: "unused",
				...(input.parentRunId !== undefined
					? { parentRunId: input.parentRunId }
					: {}),
				...(input.step !== undefined ? { step: input.step } : {}),
				...(input.canPark !== undefined ? { canPark: input.canPark } : {}),
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
