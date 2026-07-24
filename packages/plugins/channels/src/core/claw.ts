import {
	type BindConversationInput,
	configurationError,
	type Principal,
} from "@euroclaw/contracts";

/** The out-of-band app-authz caller — identity beside the domain input (the real Claw's WithCaller
 *  contract). The dispatch acts on behalf of a stranger, so it passes `system:anonymous`. */
type Caller = { principal?: Principal };

/**
 * The minimal claw surface the dispatch engine consumes — two api methods, nothing more. The route
 * and cron contexts deliver the assembled product as `unknown` (the adapter owns the real type);
 * requireClaw narrows to this. Keeping the type structural is what lets this package depend only on
 * the protocol (@euroclaw/contracts), never on the euroclaw assembly — the real Claw satisfies it,
 * pinned by a type test. Each method takes the optional app-authz caller (2nd arg) the PEP reads.
 */
export type ClawLike = {
	api: {
		bindConversation: (
			input: BindConversationInput,
			caller?: Caller,
		) => Promise<{ claw: { id: string }; thread: { id: string } }>;
		sendMessage: (
			input: {
				clawId: string;
				threadId: string;
				message: string;
			},
			caller?: Caller,
		) => Promise<{ result: { status: string; text?: string | undefined } }>;
	};
};

/**
 * Narrow the route/cron context's `unknown` claw to the surface the engine needs — checked and loud
 * instead of a blind cast: a miswired adapter fails with a configuration error, not a TypeError.
 */
export function requireClaw(claw: unknown): ClawLike {
	if (claw !== null && typeof claw === "object" && "api" in claw) {
		const api = claw.api;
		if (
			api !== null &&
			typeof api === "object" &&
			"bindConversation" in api &&
			"sendMessage" in api &&
			typeof api.bindConversation === "function" &&
			typeof api.sendMessage === "function"
		) {
			// The one seam between the adapter's untyped hand-off and the typed engine — the checks
			// above make the narrowing sound at the method level (typeof cannot see signatures; the
			// type test against the real Claw covers those).
			return claw as ClawLike;
		}
	}
	throw configurationError("channels received an invalid claw", {
		reason:
			"the route/cron context must carry the assembled claw (an object with api.bindConversation and api.sendMessage)",
	});
}
