import { configurationError, stateError } from "@busyclaw/contracts";

export type TelegramFetchResponse = {
	ok: boolean;
	status?: number;
	json: () => Promise<unknown>;
};
export type TelegramFetch = (
	input: string,
	init?: { body?: string; headers?: Record<string, string>; method?: string },
) => Promise<TelegramFetchResponse>;

export type TelegramClient = {
	getUpdates: (input: {
		offset?: number;
		limit?: number;
		timeoutSeconds?: number;
	}) => Promise<unknown>;
	sendMessage: (input: {
		chatId: string | number;
		text: string;
		replyToMessageId?: number;
	}) => Promise<unknown>;
};

export function createTelegramClient(input: {
	token: string;
	fetch?: TelegramFetch;
	apiBaseUrl?: string;
}): TelegramClient {
	const globalFetch = (globalThis as { fetch?: TelegramFetch }).fetch;
	const resolvedFetch = input.fetch ?? globalFetch?.bind(globalThis);
	if (!resolvedFetch) {
		throw configurationError("Telegram fetch implementation is unavailable", {
			reason: "pass fetch or run in an environment with global fetch",
		});
	}
	const fetcher: TelegramFetch = resolvedFetch;
	const baseUrl = input.apiBaseUrl ?? "https://api.telegram.org";
	async function call(method: string, body: Record<string, unknown>) {
		const response = await fetcher(`${baseUrl}/bot${input.token}/${method}`, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const data = (await response.json()) as { ok?: boolean; result?: unknown };
		if (!response.ok || data.ok === false) {
			throw stateError("Telegram API request failed", {
				method,
				status: response.status,
				telegramOk: data.ok,
			});
		}
		return data.result;
	}
	return {
		getUpdates: ({ offset, limit, timeoutSeconds }) =>
			call("getUpdates", { offset, limit, timeout: timeoutSeconds }),
		sendMessage: ({ chatId, text, replyToMessageId }) =>
			call("sendMessage", {
				chat_id: chatId,
				text,
				reply_to_message_id: replyToMessageId,
			}),
	};
}
