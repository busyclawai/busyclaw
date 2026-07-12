// @euroclaw/core — the governance & privacy KERNEL: the redactor (privacy enforcement), the
// hash-chained audit, the approval gate, and createGovernance (the non-bypassable pipeline).
// The protocol everyone speaks — boundary/plugin/entity contracts, ports, schemas — is
// @euroclaw/contracts; import it directly. Core does NOT re-export it.
export { approvalGate } from "./approval";
export {
	auditGate,
	createMemoryAudit,
	headOf,
	verifyAuditChain,
} from "./audit";
export type { Context, Governance, GovernanceConfig } from "./governance";
export { createGovernance } from "./governance";
export {
	composeDetectors,
	type ContainerPosture,
	createInertRedactor,
	createMemoryPiiMappingStore,
	createMemoryRedactor,
	createRoutingRedactor,
	createStoredRedactor,
	noopDetector,
	type RoutingRedactorOptions,
	type StoredRedactorOptions,
} from "./redact";
