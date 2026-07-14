// @euroclaw/policy-cedar — the cedar() policy SOURCE. It contributes raw Cedar policy TEXT to the
// assembly's internal engine (merged UNDER the SYSTEM_POSTURE floor). The Cedar decision engine
// (eval, floor, request mapper, escape-hatch plugin) lives in @euroclaw/authz; this package is a
// thin source — no cedar-wasm.

export type { CedarSourceConfig } from "./source";
export { cedar } from "./source";
