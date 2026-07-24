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
// Depends on runMode ALWAYS being present in the request context — guaranteed two ways: the runtime
// stamps `euroclaw__runMode` on every gated call (default "autonomous"), and the policy-cedar mapCall
// defaults `context.runMode` to "autonomous" when absent. Both matter because cedar-wasm ERRORS on an
// absent optional access (even under a `has` guard, verified 4.11.1) → an erroring forbid is SILENTLY
// SKIPPED. With runMode guaranteed present, an unknown/autonomous mode reads as "must confirm"
// (fail-closed) and only a known-interactive run relaxes.
// Each policy carries an `@id` so the determining-policy trail (and the compliance audit that persists
// it) NAMES the floor rule that decided, instead of a positional `policy0` that shifts as soon as a
// customer slice is added above it. Annotations are metadata — never evaluated — so the posture's
// semantics are untouched.
export const SYSTEM_POSTURE = `@id("floor:reads-run")
permit(principal, action in Action::"reads", resource);

@id("floor:writes-need-confirmation")
permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };

@id("floor:unconfirmed-autonomous-write-forbidden")
forbid(principal, action in Action::"writes", resource) unless { context.confirmationUsed || context.runMode == "interactive" };`;
