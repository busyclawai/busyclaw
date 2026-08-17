/**
 * A model you SCRIPT, because a scenario is a story about what the agent decides to do.
 *
 * Every mock model in the repo today is hand-rolled per test — `textModel`, `lookupToolModel`,
 * `approvalToolModel`, `volunteersPiiModel` — each a fresh 40-line literal differing only in what it
 * answers. That is fine for one assertion and useless for a scenario, where the interesting part IS
 * the sequence: call this tool, look at the result, call another, then answer.
 *
 * `script([...])` takes that sequence directly. One step per model turn, in order, and the last one
 * repeats if the loop asks for more — so a scenario that ends in text cannot hang because the script
 * ran out.
 */

import type { RuntimeModel } from "@busyclaw/runtime";

/**
 * One model turn: call a tool, answer, or blow up.
 *
 * `throw` is what makes a crash scenario writable. It fires `times` times (default once) and is then
 * SPENT — the next attempt at the same turn falls through to the step after it. That is the shape a
 * transient provider failure actually has, and it is the only way to tell a run that RESUMED from one
 * that silently started over: a resumed run reaches the step after the failure, a replayed one
 * reaches the beginning.
 */
export type Step =
	| { tool: string; args?: unknown; callId?: string }
	| { text: string }
	| { throw: string; times?: number };

type V4Model = Extract<RuntimeModel, { specificationVersion: "v4" }>;

const USAGE = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
} as const;

function contentFor(step: Step, turn: number) {
	if ("text" in step) return [{ type: "text" as const, text: step.text }];
	// `reactive` spends its `throw` steps before reaching here, so this is the `script` path: a script
	// with a throw in it fails every time it gets there, which is the honest reading of a sequence
	// with no retry semantics attached.
	if ("throw" in step) throw new Error(step.throw);
	return [
		{
			type: "tool-call" as const,
			// STABLE PER TURN, not random. The provider's call id is a nonce in real life, and the
			// runtime is explicitly built to survive that (the effect id is derived from step + input
			// hash, never from this). Making it deterministic here means a scenario that replays a run
			// produces byte-identical transcripts, so a diff is a real difference rather than noise.
			toolCallId: step.callId ?? `call-${turn}`,
			toolName: step.tool,
			input: JSON.stringify(step.args ?? {}),
		},
	];
}

/**
 * A model that performs `steps` in order.
 *
 * `onTurn` reports each turn as it happens — the seam a scenario uses to assert the agent was asked
 * the right number of times, or to make the model behave differently on a retry.
 */
export function script(
	steps: readonly [Step, ...Step[]],
	options: { onTurn?: (turn: number, step: Step) => void } = {},
): RuntimeModel {
	let turn = 0;
	const model: V4Model = {
		specificationVersion: "v4",
		provider: "e2e",
		modelId: "scripted",
		supportedUrls: {},
		doGenerate: async () => {
			const step = steps[Math.min(turn, steps.length - 1)] ?? steps[0];
			options.onTurn?.(turn, step);
			turn += 1;
			return {
				content: contentFor(step, turn - 1),
				finishReason: {
					unified: "tool" in step ? ("tool-calls" as const) : ("stop" as const),
					raw: undefined,
				},
				usage: USAGE,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("e2e: streaming scenarios are not scripted yet");
		},
	};
	return model;
}

/**
 * The same script, but the turn is READ OFF THE PROMPT instead of counted.
 *
 * `script` keeps a counter in the closure, which is fine for one run and wrong the moment there are
 * several: a `workers: 2` scenario drives runs concurrently through ONE model instance, so the runs
 * interleave, the counter advances globally, and run B gets run A's next step. The failure looks
 * like a product bug and is entirely the fixture's.
 *
 * A transcript already knows which turn it is on — one tool result per completed step, because the
 * loop refuses more than one tool call per step. Counting them is stateless, so any number of runs
 * can share this model and each still walks the script from the top.
 */
export function reactive(
	steps: readonly [Step, ...Step[]],
	options: { onTurn?: (turn: number, step: Step) => void } = {},
): RuntimeModel {
	/** How many times each `throw` step has fired — the only state this model keeps, and it is about
	 *  the FAILURE rather than about any one run, so concurrent runs still share it safely. */
	const fired = new Map<number, number>();
	const model: V4Model = {
		specificationVersion: "v4",
		provider: "e2e",
		modelId: "reactive",
		supportedUrls: {},
		doGenerate: async ({ prompt }) => {
			// One tool result per completed step, because the loop refuses more than one tool call per
			// step — so the count IS the turn number, read from the transcript the SDK already typed.
			const turn = prompt.filter((message) => message.role === "tool").length;
			// A SPENT `throw` falls through to the next step. A failure produces no tool result, so the
			// retry arrives at the SAME turn number — without this it would throw forever and a crash
			// scenario could never reach the other side of the crash.
			let index = Math.min(turn, steps.length - 1);
			for (let hop = 0; hop < steps.length; hop++) {
				const candidate = steps[index];
				if (candidate === undefined || !("throw" in candidate)) break;
				const already = fired.get(index) ?? 0;
				if (already >= (candidate.times ?? 1)) {
					index = Math.min(index + 1, steps.length - 1);
					continue;
				}
				fired.set(index, already + 1);
				// Reported BEFORE the throw: a crashed call is still a call, and a scenario counting how
				// many times the provider was reached must not get a discount for the one that failed.
				options.onTurn?.(turn, candidate);
				throw new Error(candidate.throw);
			}
			const step = steps[index] ?? steps[0];
			options.onTurn?.(turn, step);
			return {
				content: contentFor(step, turn),
				finishReason: {
					unified: "tool" in step ? ("tool-calls" as const) : ("stop" as const),
					raw: undefined,
				},
				usage: USAGE,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("e2e: streaming scenarios are not scripted yet");
		},
	};
	return model;
}
