// The claw this app is built around — assembled ONCE per server process.
//
// Next.js re-evaluates route modules on every edit in dev, so a plain module-level `createClaw`
// would mint a new runtime (and a new in-memory PII vault, and a new approval store) on every
// recompile — placeholders minted before the reload would stop resolving. Caching on `globalThis`
// is the standard Next escape hatch and it is load-bearing here, not a micro-optimisation.

import { regexDetector } from "@euroclaw/detectors/regex";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createClaw } from "euroclaw";
import { resolveModel } from "./model";

function assembleClaw() {
	return createClaw({
		model: resolveModel(),

		// The host's database. `memoryAdapter()` keeps the demo one `pnpm dev` away from running:
		// there is no migration CLI yet, so a SQL adapter would mean hand-writing DDL for the whole
		// schema. It is a real adapter — the durable stores, the PII vault and the approval records
		// all go through it — it just forgets everything when the process dies.
		database: memoryAdapter(),

		// Redaction ARMED, over the regex detector. This is what makes the chat interesting with no
		// tools wired yet: type an email or an IBAN and the model never receives it — it receives a
		// placeholder, and the streamed answer is rehydrated on the way back to the reader.
		redaction: [regexDetector],

		// The PEP is default-enforce. Every call below therefore has to name a caller; the HTTP door
		// gets one from `resolveCaller` (app/api/euroclaw/[...all]/route.ts), the in-process chat
		// route passes `{ principal }` directly.
	});
}

export type DemoClaw = ReturnType<typeof assembleClaw>;

const CACHE_KEY = Symbol.for("euroclaw.demo.claw");
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
