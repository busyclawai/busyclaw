// euroclaw/ai — the authoring surface for AI-SDK tools under euroclaw governance, re-exported
// from the feather-light @euroclaw/vendors/ai-sdk foundation subpath. `tool()` authors a governed
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
} from "@euroclaw/vendors/ai-sdk";
export { govern, standardSchema, tool } from "@euroclaw/vendors/ai-sdk";
