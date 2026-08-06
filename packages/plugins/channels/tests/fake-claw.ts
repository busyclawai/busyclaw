// A claw that keeps a transcript, because the dispatch engine now reads one.
//
// The reply used to be whatever `sendMessage` handed back, so a fake with two methods was enough. It
// is not any more, and for a reason worth stating: a run can be joined by a later message, parked on
// an approval, or driven to its end by another process, so the answer is READ FROM THE TRANSCRIPT
// rather than returned to whoever happened to start it. A fake that returns text it never records is
// a fake that agrees with none of those paths.
//
// So this one records. `sendMessage` opens a run, writes the user message and (unless the run parks)
// the assistant's, and `listMessages` gives them back — which makes the fake's own behaviour the
// thing under test rather than a set of canned returns that have to be kept in sync by hand.

import type { JsonValue } from "@busyclaw/contracts";
import { conflictError } from "@busyclaw/contracts";
import type { ClawLike } from "../src/index";

export type FakeMessage = {
	id: string;
	threadId: string;
	runId?: string;
	role: string;
	content: JsonValue;
	visibility: string;
};

export type FakeRun = { id: string; status: string; threadId: string };

export type FakeClawOptions = {
	/** What the model says. A function sees the prompt; `null` ⇒ the run produces no answer at all. */
	answer?:
		| string
		| null
		| ((message: string) => string | null | Promise<string | null>);
	/** Where the run lands. `running`/`waiting_approval` leave it live, so nothing is owed yet. */
	status?: string;
	/** `false` ⇒ somebody else owns the task; this invocation drove nothing. */
	driven?: boolean;
	/** Run before the turn — for tests that need to interleave a second arrival with the first. */
	onTurn?: (message: string) => void | Promise<void>;
	clawId?: string;
	threadId?: string;
};

export type FakeClaw = ClawLike & {
	/** Every prompt that opened a run, in order. */
	readonly relayed: string[];
	/** Every message delivered INTO a run already in flight, in order. */
	readonly joined: { toRunId: string; text: string }[];
	readonly messages: FakeMessage[];
	readonly runs: FakeRun[];
	/** Finish a live run as if a drain had: append its answer and mark it terminal. */
	finish: (runId: string, text?: string | null, status?: string) => void;
};

export function fakeClaw(options: FakeClawOptions = {}): FakeClaw {
	const clawId = options.clawId ?? "claw-1";
	const threadId = options.threadId ?? "thread-1";
	const relayed: string[] = [];
	const joined: { toRunId: string; text: string }[] = [];
	const messages: FakeMessage[] = [];
	const runs: FakeRun[] = [];
	const admitted = new Set<string>();
	let nextRun = 0;
	let nextMessage = 0;

	const answerFor = async (message: string): Promise<string | null> => {
		// `??` and not `||`: an explicit `null` means "this run says nothing", which is a different
		// instruction from omitting the option, and the two must not collapse into the default.
		const answer =
			options.answer === undefined ? "the SECOND answer" : options.answer;
		return typeof answer === "function" ? await answer(message) : answer;
	};
	const append = (message: Omit<FakeMessage, "id">): FakeMessage => {
		nextMessage += 1;
		const row = { ...message, id: `m-${nextMessage}` };
		messages.push(row);
		return row;
	};
	const finish: FakeClaw["finish"] = (runId, text, status = "completed") => {
		const run = runs.find((candidate) => candidate.id === runId);
		if (run) run.status = status;
		if (text != null && text !== "") {
			append({
				threadId: run?.threadId ?? threadId,
				runId,
				role: "assistant",
				content: { text },
				visibility: "user",
			});
		}
	};

	return {
		relayed,
		joined,
		messages,
		runs,
		finish,
		api: {
			bindConversation: async () => ({
				claw: { id: clawId },
				thread: { id: threadId },
			}),
			sendMessage: async (input) => {
				await options.onTurn?.(input.message);
				relayed.push(input.message);
				nextRun += 1;
				const runId = `run-${nextRun}`;
				const status = options.status ?? "completed";
				runs.push({ id: runId, status, threadId: input.threadId });
				append({
					threadId: input.threadId,
					runId,
					role: "user",
					content: { text: input.message },
					visibility: "user",
				});
				const text = await answerFor(input.message);
				// A run that is still live has not written an answer yet — that is what makes it live.
				if (status === "completed" && text != null) {
					append({
						threadId: input.threadId,
						runId,
						role: "assistant",
						content: { text },
						visibility: "user",
					});
				}
				if (options.driven === false) return { driven: false as const, runId };
				return {
					driven: true as const,
					runId,
					result: { status, ...(text != null ? { text } : {}) },
				};
			},
			listActiveRuns: async (input) =>
				runs
					.filter(
						(run) =>
							run.threadId === input.threadId &&
							run.status !== "completed" &&
							run.status !== "failed" &&
							run.status !== "cancelled",
					)
					// Newest first, like the real door.
					.reverse()
					.map((run) => ({ id: run.id, status: run.status })),
			appendMessage: async (input) => {
				// The real door's primary key. A caller-supplied id that is already present conflicts,
				// which is what makes the join path's transcript write idempotent.
				if (input.id !== undefined) {
					if (messages.some((row) => row.id === input.id)) {
						throw conflictError("message already exists", { id: input.id });
					}
					nextMessage += 1;
					messages.push({
						id: input.id,
						threadId: input.threadId,
						...(input.runId !== undefined ? { runId: input.runId } : {}),
						role: input.role,
						content: input.content,
						visibility: input.visibility ?? "user",
					});
					return;
				}
				append({
					threadId: input.threadId,
					...(input.runId !== undefined ? { runId: input.runId } : {}),
					role: input.role,
					content: input.content,
					visibility: input.visibility ?? "user",
				});
			},
			deliverMessage: async (input) => {
				// The engine's exactly-once admission, in one line: a redelivery loses the insert.
				if (admitted.has(input.idempotencyKey)) return;
				admitted.add(input.idempotencyKey);
				const text = input.body.text;
				joined.push({
					toRunId: input.toRunId,
					text: typeof text === "string" ? text : JSON.stringify(input.body),
				});
			},
			getRun: async (input) => runs.find((run) => run.id === input.id) ?? null,
			listMessages: async (input) =>
				messages.filter(
					(message) =>
						message.threadId === input.threadId &&
						(input.runId === undefined || message.runId === input.runId) &&
						(input.visibility === undefined ||
							input.visibility.includes(
								message.visibility as "user" | "internal" | "audit-only",
							)),
				),
		},
	};
}
