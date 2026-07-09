// @euroclaw/channels/telegram — the Telegram provider. `telegram({ tokenRef })` is the app's own
// bot (channels() app-bot mode); bare `telegram()` is the pure transport for registrations mode.
// Telegram-specific helpers grow here without touching the floor.
export {
	type TelegramConfig,
	telegram,
	telegramWebhookSecret,
} from "./channel";
export {
	createTelegramClient,
	type TelegramClient,
	type TelegramFetch,
	type TelegramFetchResponse,
} from "./client";
