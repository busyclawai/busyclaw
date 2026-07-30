// @busyclaw/sandboxes — governed code execution behind pluggable isolation providers. This root
// export is the floor contracts, the shared engine, and the run_code tool factory.
//
// Deliberately NOT re-exported here (subpath isolation keeps heavy deps out of the root import
// graph):
//   import { quickjs } from "@busyclaw/sandboxes/quickjs"        // the wasm interpreter
//   import { memoryVolumeStore } from "@busyclaw/sandboxes/memory" // a VolumeStore adapter

export type {
	ExecutionContext,
	ExecutionResult,
	IsolationPosture,
	Sandbox,
	SandboxExecution,
	SandboxFetch,
	SandboxInvokeInput,
	SandboxToolInvoker,
	SandboxVolumeStore,
	VolumeRef,
	VolumeTree,
} from "./core/contracts";
export { executionResult, sandboxInvokeInput } from "./core/contracts";
export { executeInSandbox, normalizeCode } from "./core/engine";
export { runCodeTool } from "./runcode";
