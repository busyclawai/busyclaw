// @euroclaw/channels — the channels() plugin and the floor every provider builds on (the
// @better-auth/core/oauth2 analog). channels([...]) is the app's own shared bots (the
// socialProviders/genericOAuth analog); channels([...], { registrations: { enabled: true } }) flips the
// same call to user-registered bots (the SSO analog) — one plugin, no separate export, no subpath.
//
// Deliberately NOT re-exported here (subpath isolation beats tree-shaking):
//   import { telegram } from "@euroclaw/channels/telegram"  — providers

export {
	type ChannelsPlugin,
	type ChannelsPluginOptions,
	channels,
} from "./channels/plugin";
export {
	channelEndpointFields,
	channelsModels,
	channelsSchema,
} from "./channels/schema";
export {
	type ChannelEndpointStateRecord,
	type ChannelEndpointStateStore,
	createChannelEndpointStateStore,
} from "./channels/store";
export { type ClawLike, requireClaw } from "./core/claw";
export type {
	Channel,
	ChannelEndpointMode,
	EndpointContext,
	EndpointEvent,
	InboundMessage,
	InboundRequest,
	OutboundMessage,
	PersistEndpointEvent,
} from "./core/contracts";
export {
	APP_ENDPOINT_KEY,
	channelEndpointModeValues,
} from "./core/contracts";
export {
	type ChannelDispatchResult,
	dispatchWebhook,
	handleInbound,
	pollEndpoint,
} from "./core/dispatch";
export { endpointId } from "./core/id";
