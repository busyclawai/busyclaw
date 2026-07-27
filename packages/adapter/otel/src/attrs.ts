// Every attribute name this bridge emits, pinned as local string constants: the GenAI
// semantic conventions are still incubating (names move between releases), so we pin the
// exact strings instead of depending on @opentelemetry/semantic-conventions.
export const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const ATTR_GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS =
	"gen_ai.response.finish_reasons";
export const ATTR_GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_BUSYCLAW_RUN_ID = "busyclaw.run.id";
export const ATTR_BUSYCLAW_CLAW_ID = "busyclaw.claw.id";
export const ATTR_BUSYCLAW_STEP = "busyclaw.step";
export const ATTR_BUSYCLAW_REASON_CODE = "busyclaw.reason_code";
export const ATTR_BUSYCLAW_RUN_OUTCOME = "busyclaw.run.outcome";
export const ATTR_BUSYCLAW_TOOL_OUTCOME = "busyclaw.tool.outcome";
export const ATTR_BUSYCLAW_CHECKPOINT_ID = "busyclaw.checkpoint.id";
