import {
	type ClawRequestHandlerOptions,
	toRequestHandler,
} from "@busyclaw/adapter-core";
import type { Claw } from "busyclaw";

export function toNextJsHandler(
	claw: Claw,
	options?: ClawRequestHandlerOptions,
) {
	const handler = toRequestHandler(claw, options);
	return {
		DELETE: handler,
		GET: handler,
		PATCH: handler,
		POST: handler,
		PUT: handler,
	};
}

export type { ClawRequestHandlerOptions };
