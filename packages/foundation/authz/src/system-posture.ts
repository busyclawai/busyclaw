import type { NamedPolicies } from "./policy-bundle";

// The code-owned system posture — slice 6b. The seeded Cedar text ALWAYS present in `live` (merged
// UNDER every customer slice by loadPolicyBundle): customers narrow or extend it with their own
// slices but can never remove it — forbid overrides permit, so the floor is sealed. Keep it small;
// this is the editable seed.
//
//   - reads run;
//   - writes need confirmation, UNLESS the run is known-interactive (a human is present): a write is
//     forbidden unless it was confirmed OR context.runMode == "interactive". The forbid overrides any
//     customer `permit`, and the needs-approval probe (re-evaluate as-if-confirmed) is the human gate
//     — so an unconfirmed AUTONOMOUS write, even one a customer slice tried to permit, surfaces as
//     needs-approval, never a silent run.
//
// EVERY CONTEXT READ BELOW IS `has`-GUARDED, and that is the whole safety argument rather than a
// style preference. cedar-wasm ERRORS on an absent attribute, and an erroring policy is SILENTLY
// SKIPPED — so an unguarded `forbid` does not block, it DISAPPEARS, and whatever customer `permit`
// sits under it decides instead. A `has`-guarded access over an absent attribute is false, which is
// the direction that fails closed.
//
// This used to lean on runMode always being stamped: the runtime puts `busyclaw__runMode` on every
// gated call and the policy-cedar mapCall defaults it to "autonomous". Both are still true, and both
// were still only a property of ONE caller. The floor is inherited by every other way into the engine
// — the shadow engine, the api plane, a plugin-supplied engine, a direct `cedarEngine` construction,
// the next door somebody adds — and none of those inherits the defaulting. With the guards, an
// unknown or absent mode reads as "must confirm" no matter who assembled the request, and only a
// known-interactive run relaxes. The failure that used to be possible left no trace, because a
// skipped forbid is absent from the decision it did not make.
// A NAMED set (rule name → cedar), not one blob: the name is what the determining-policy trail reports
// and the compliance audit persists, so the floor's rules stay legible there instead of a positional
// `policy0` that shifts as soon as a customer slice is added. The names live in THIS structure — never
// as metadata inside the policy source.
export const SYSTEM_POSTURE: NamedPolicies = {
	"floor:reads-run": `permit(principal, action in Action::"reads", resource);`,
	"floor:writes-need-confirmation": `permit(principal, action in Action::"writes", resource) when { context has confirmationUsed && context.confirmationUsed };`,
	"floor:unconfirmed-autonomous-write-forbidden": `forbid(principal, action in Action::"writes", resource) unless { (context has confirmationUsed && context.confirmationUsed) || (context has runMode && context.runMode == "interactive") };`,
};
