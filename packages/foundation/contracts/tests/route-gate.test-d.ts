// Type-level proof that the governed route builder cannot be bypassed. Every `@ts-expect-error` below
// is an ASSERTION: if the case stops failing to compile, tsc reports the directive as unused and this
// file breaks the build. That is the point — these are the four ways someone could ship an unauthorized
// or mistyped route, and each one has to stay impossible.

import { type } from "arktype";
import { route } from "../src/governance/route";

const idInput = type({ id: "string" });
const messageOut = type({ id: "string", clawId: "string" });

// The shape that should work: resolver typed from the input, handler return pinned to the output.
export const resolved = route
	.input(idInput)
	.output(messageOut)
	.authz("read", (i) => ({ kind: "message", id: i.id }))
	.handler(async ({ id }) => ({ id, clawId: "claw-1" }));

// The escape hatch, with its mandatory reason.
export const callerOnly = route
	.input(idInput)
	.authz(null, "mints a new row whose owner is stamped from the caller")
	.handler(async ({ id }) => id);

// The scope target — an opaque access boundary, both halves read from the input.
export const scoped = route
	.input(type({ scope: "string", scopeId: "string" }))
	.authz("manage", (i) => ({ scope: i.scope, scopeId: i.scopeId }))
	.handler(async () => undefined);

// An imperative top-up is always available, and does not replace the declared gate.
export const topUp = route
	.input(type({ clawId: "string", threadId: "string" }))
	.authz("use", (i) => ({ kind: "claw", id: i.clawId }))
	.handler(async (input, ctx) => {
		await ctx.authz.enforce("use", { kind: "thread", id: input.threadId });
		return input.threadId;
	});

// ── the assertions ───────────────────────────────────────────────────────────────────────────────

// Reaching `.handler()` with no `.authz()` is the original vulnerability. It must not compile.
route
	.input(idInput)
	// @ts-expect-error — .handler() is RequireAuthz until .authz() flips the phantom flag
	.handler(async ({ id }: { id: string }) => id);

// A resolver may only read fields the input actually declares.
route
	.input(idInput)
	// @ts-expect-error — `nope` is not a key of the declared input
	.authz("read", (i) => ({ kind: "message", id: i.nope }))
	.handler(async () => undefined);

// A declared output pins the handler's return.
route
	.input(idInput)
	.output(messageOut)
	.authz("read", (i) => ({ kind: "message", id: i.id }))
	// @ts-expect-error — handler returns a shape the declared output does not accept
	.handler(async () => ({ wrong: true }));

// The caller-only escape must state a reason; a bare opt-out is not available.
route
	.input(idInput)
	// @ts-expect-error — .authz(null) requires the reason argument
	.authz(null)
	.handler(async () => undefined);

// A resolver must return a real target, not an arbitrary object.
route
	.input(idInput)
	// @ts-expect-error — neither a {kind,id} nor a {scope,scopeId} target
	.authz("read", (i) => ({ somethingElse: i.id }))
	.handler(async () => undefined);
