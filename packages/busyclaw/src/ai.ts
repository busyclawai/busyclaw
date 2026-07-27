// busyclaw/ai — the authoring surface for AI-SDK tools under busyclaw governance, re-exported
// from the feather-light @busyclaw/vendors/ai-sdk foundation subpath. `tool()` authors a governed
// tool in one definition; `govern()` adopts a tool you didn't author.

export type {
	AuthoredTool,
	ToolDefinition,
	ToolDefinitionSet,
	ToolDescriptor,
	ToolEffectPolicy,
	ToolGate,
	ToolGovernance,
	ToolInvocation,
	ToolPresence,
} from "@busyclaw/vendors/ai-sdk";
export { govern, standardSchema, tool } from "@busyclaw/vendors/ai-sdk";
