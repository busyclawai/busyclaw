// @busyclaw/channels — the channels() plugin and the floor every provider builds on (the
// @better-auth/core/oauth2 analog). channels([...]) is the app's own shared bots (the
// socialProviders/genericOAuth analog); channels([...], { registrations: { enabled: true } }) flips the
// same call to user-registered bots (the SSO analog) — one plugin, no separate export, no subpath.
//
// Deliberately NOT re-exported here (subpath isolation beats tree-shaking):
//   import { telegram } from "@busyclaw/channels/telegram"  — providers

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
	// The queues' recovery half. Both plugin modes schedule these as a cron task, so a host does not
	// have to — they are exported because a deployment with its own scheduler (a worker dyno, a queue
	// runner, a platform cron that does not POST /cron) needs to be able to call them directly.
	//
	// `drainOutbox` in particular was previously reachable by nobody: not exported, not scheduled, and
	// named in exactly one test. The comment above it said a deployment would call it "on whatever it
	// already runs on a schedule", which no deployment could.
	drainDeliveries,
	drainOutbox,
	type EndpointResolver,
	handleInbound,
	pollEndpoint,
	type ResolvedEndpoint,
	runDelivery,
} from "./core/dispatch";
export { endpointId } from "./core/id";
export type {
	ClaimedDelivery,
	ClaimedReply,
	DeliveryClaim,
	DeliveryInbox,
	DeliveryKey,
	DeliveryOutbox,
	DeliveryWork,
	OutboundRecord,
} from "./core/inbox";
