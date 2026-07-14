// @euroclaw/policy-cedar — a Cedar PDP behind the @euroclaw/contracts PolicyEngine port.
// ./contracts holds the config/context types, ./engine the PDP (deny-by-default, forbid-overrides,
// the needs-approval probe), ./plugin the surfaces: `cedar()` (a policy SOURCE — text merged under
// the assembly's floor), `cedarMapCall()` (the default tool-call → PARC mapper, shared by the
// assembly's internal engine), and `cedarPolicyPlugin()` (the engine-wrapper escape hatch).

export type { PolicyPlugin } from "@euroclaw/authz";
export { createPolicyPlugin } from "@euroclaw/authz";
export type {
	EntityRef,
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";
export type {
	CedarContext,
	CedarEngineConfig,
	CedarEntitiesInput,
	CedarMapCallConfig,
	CedarPluginConfig,
	CedarSourceConfig,
} from "./contracts";
export { cedarEngine } from "./engine";
export {
	cedar,
	cedarFloorEngine,
	cedarMapCall,
	cedarPolicyPlugin,
} from "./plugin";
