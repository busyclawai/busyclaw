// The streaming chat endpoint — what `useChat` on the client talks to.
//
// Streaming is the one api method with no mounted HTTP route (`ClawApiMethod` excludes it: SSE is a
// different transport, so euroclaw declines to guess one for you). The host writes that route, and
// it is this short, because both halves already exist:
//
//   await claw.api.stream(...)    → { textStream, result }, deltas ALREADY rehydrated reader-facing
//   toUIMessageStreamResponse(…)  → that stream framed as the SSE protocol useChat consumes
//
// What the reader sees is not what the model saw. Ingress redaction tokenizes the prompt before it
// reaches the provider; the deltas are turned back into real values on the way out, by the runtime,
// with a boundary buffer that will not let a `{{pii:…}}` token be split across two chunks.

import { toUIMessageStreamResponse } from "@euroclaw/vendors/ai-sdk";
import { claw } from "@/lib/claw";
import { DEMO_ONLY_readPrincipal, principalOf } from "@/lib/session";

export const maxDuration = 60;

type UiPart = { type?: string; text?: string };
type UiMessage = { role?: string; parts?: UiPart[]; content?: string };

/** `useChat` posts the whole message list; the runtime's `stream` takes a prompt. Until the durable
 *  transcript path streams (it is `sendMessage`, which returns whole), the last user message IS the
 *  prompt — stated here rather than hidden, because it is the demo's real limitation. */
function lastUserText(messages: readonly UiMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		const fromParts = (message.parts ?? [])
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("");
		const text = fromParts !== "" ? fromParts : (message.content ?? "");
		if (text.trim() !== "") return text;
	}
	return "";
}

export async function POST(request: Request): Promise<Response> {
	const body = (await request.json()) as { messages?: UiMessage[] };
	const prompt = lastUserText(body.messages ?? []);
	if (prompt === "") {
		return new Response(JSON.stringify({ error: "empty prompt" }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}

	// This route is hand-written, so it owns the check the mounted adapter does for every other
	// method — no session, no run. Skipping it here would leave one door open beside a locked one.
	const user = DEMO_ONLY_readPrincipal(request);
	if (user === undefined) {
		return new Response(JSON.stringify({ error: "not authenticated" }), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}

	// The in-process door: identity rides as the out-of-band caller argument, exactly as the HTTP
	// adapter passes it for every other method.
	//
	// Awaited: `stream` resolves to the stream rather than returning it, because authorizing is
	// asynchronous and a denial must hand back nothing at all.
	const stream = await claw.api.stream(
		{ prompt },
		{ principal: principalOf(user) },
	);

	return toUIMessageStreamResponse(stream);
}
