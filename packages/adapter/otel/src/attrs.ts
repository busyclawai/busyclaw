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
export const ATTR_EUROCLAW_RUN_ID = "euroclaw.run.id";
export const ATTR_EUROCLAW_CLAW_ID = "euroclaw.claw.id";
export const ATTR_EUROCLAW_STEP = "euroclaw.step";
export const ATTR_EUROCLAW_REASON_CODE = "euroclaw.reason_code";
export const ATTR_EUROCLAW_RUN_OUTCOME = "euroclaw.run.outcome";
export const ATTR_EUROCLAW_TOOL_OUTCOME = "euroclaw.tool.outcome";
export const ATTR_EUROCLAW_CHECKPOINT_ID = "euroclaw.checkpoint.id";
