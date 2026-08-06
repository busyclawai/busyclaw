import {
	type BindConversationInput,
	configurationError,
	type JsonObject,
	type JsonValue,
	type Principal,
	type RunMessageMode,
} from "@busyclaw/contracts";

/** The out-of-band app-authz caller — identity beside the domain input (the real Claw's WithCaller
 *  contract). The dispatch acts on behalf of a stranger, so it passes `system:anonymous`. */
type Caller = { principal?: Principal };

/**
 * The minimal claw surface the dispatch engine consumes — two api methods, nothing more. The route
 * and cron contexts deliver the assembled product as `unknown` (the adapter owns the real type);
 * requireClaw narrows to this. Keeping the type structural is what lets this package depend only on
 * the protocol (@busyclaw/contracts), never on the busyclaw assembly — the real Claw satisfies it,
 * pinned by a type test. Each method takes the optional app-authz caller (2nd arg) the PEP reads.
 */
export type ClawLike = {
	api: {
		bindConversation: (
			input: BindConversationInput,
			caller?: Caller,
		) => Promise<{ claw: { id: string }; thread: { id: string } }>;
		/**
		 * A UNION result, because a chat turn is a durable run: a concurrent replica may own the
		 * task, or the driver may have lost its lease, and neither of those has a result to report.
		 * A channel that assumed `result` was always there would print an empty reply into somebody's
		 * chat and call it an answer — see `dispatch.ts`, which now says nothing instead.
		 */
		sendMessage: (
			input: {
				clawId: string;
				threadId: string;
				message: string;
			},
			caller?: Caller,
		) => Promise<
			| {
					driven: true;
					runId: string;
					result: { status: string; text?: string | undefined };
			  }
			| { driven: false; runId: string }
		>;
		/**
		 * Is somebody already answering this conversation? The question that decides whether an arriving
		 * message starts a turn or joins one.
		 *
		 * Several is a legitimate answer in general, but for a channel it is a degenerate one: every
		 * message on this thread arrives through this one endpoint, so a second live run means a relay
		 * that raced itself. The router joins the newest and lets the rest finish.
		 */
		listActiveRuns: (
			input: { threadId: string },
			caller?: Caller,
		) => Promise<{ id: string; status: string }[]>;
		/**
		 * Write a message into the transcript directly.
		 *
		 * Needed only on the JOIN path: `deliverMessage` fills the run's inbox and nothing else, so a
		 * follow-up that skipped this would reach the model and never appear in the conversation.
		 */
		appendMessage: (
			input: {
				id?: string;
				clawId: string;
				threadId: string;
				runId?: string;
				role: "user" | "assistant" | "system" | "tool";
				content: JsonValue;
				visibility?: "user" | "internal" | "audit-only";
			},
			caller?: Caller,
		) => Promise<unknown>;
		/** Steer a run already in flight, instead of starting a second one beside it. */
		deliverMessage: (
			input: {
				toRunId: string;
				body: JsonObject;
				mode: RunMessageMode;
				idempotencyKey: string;
			},
			caller?: Caller,
		) => Promise<unknown>;
		/** Has this run finished? The reply sweep's only question about it. */
		getRun: (
			input: { id: string },
			caller?: Caller,
		) => Promise<{ status: string } | null>;
		/**
		 * What this run said — read from the TRANSCRIPT rather than from the invocation, because the
		 * invocation that produced it may have ended hours before anything asks.
		 */
		listMessages: (
			input: {
				threadId: string;
				runId?: string;
				visibility?: readonly ("user" | "internal" | "audit-only")[];
			},
			caller?: Caller,
		) => Promise<{ role: string; content: JsonValue }[]>;
	};
};

/** The api methods `requireClaw` insists on before it will narrow. */
const REQUIRED_API_METHODS = [
	"bindConversation",
	"sendMessage",
	"listActiveRuns",
	"appendMessage",
	"deliverMessage",
	"getRun",
	"listMessages",
] as const;

/**
 * Narrow the route/cron context's `unknown` claw to the surface the engine needs — checked and loud
 * instead of a blind cast: a miswired adapter fails with a configuration error, not a TypeError.
 */
export function requireClaw(claw: unknown): ClawLike {
	if (claw !== null && typeof claw === "object" && "api" in claw) {
		const api = claw.api as Record<string, unknown> | null;
		if (api !== null && typeof api === "object") {
			const missing = REQUIRED_API_METHODS.filter(
				(name) => typeof api[name] !== "function",
			);
			if (missing.length === 0) {
				// The one seam between the adapter's untyped hand-off and the typed engine — the checks
				// above make the narrowing sound at the method level (typeof cannot see signatures; the
				// type test against the real Claw covers those).
				return claw as ClawLike;
			}
			throw configurationError("channels received an invalid claw", {
				// NAMED, not merely counted. The surface grew when a message learned to join a run in
				// flight, and a host on an older assembly gets a list it can act on instead of a
				// sentence that was accurate about the old two methods and silent about the new four.
				reason: `the assembled claw is missing api methods: ${missing.join(", ")}`,
			});
		}
	}
	throw configurationError("channels received an invalid claw", {
		reason:
			"the route/cron context must carry the assembled claw (an object with an `api`)",
	});
}
