// The claw this app is built around — assembled ONCE per server process.
//
// Next.js re-evaluates route modules on every edit in dev, so a plain module-level `createClaw`
// would mint a new runtime (and a new connection pool) on every recompile. Caching on `globalThis`
// is the standard Next escape hatch, and it is load-bearing rather than a micro-optimisation: a new
// pool per recompile leaks sockets against Neon's connection limit.
//
// State lives in Postgres now, so a fresh process is no longer a fresh world — PII placeholders,
// transcripts and approvals all survive a restart, which is what makes the demo filmable and what
// makes it deployable to a serverless host at all.

import { createClaw } from "busyclaw";
import { appConnectionString, clawConfig } from "./busyclaw-config";

/** The same object `busyclaw db migrate` reads, so the schema it migrates is the schema this runs. */
export const config = clawConfig(appConnectionString());

function assembleClaw() {
	return createClaw(config);
}

export type DemoClaw = ReturnType<typeof assembleClaw>;

const CACHE_KEY = Symbol.for("busyclaw.demo.claw");
type ClawCache = { [CACHE_KEY]?: DemoClaw };

function cached(): DemoClaw {
	const store = globalThis as unknown as ClawCache;
	const existing = store[CACHE_KEY];
	if (existing !== undefined) return existing;
	const built = assembleClaw();
	store[CACHE_KEY] = built;
	return built;
}

export const claw: DemoClaw = cached();
