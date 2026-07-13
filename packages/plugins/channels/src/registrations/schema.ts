import type { SchemaDeclaration } from "@euroclaw/contracts";
import {
	bindConversationClawInput,
	bindConversationThreadInput,
	type EntityField,
	entity,
	field,
} from "@euroclaw/contracts";

// A channel registration is a USER-registered bot — the ssoProvider analog: registered at runtime,
// credentials stored in the row and read back at use, with the organization it belongs to as optional row
// DATA (the organizationId analog), never part of transport identity. Registrations are WEBHOOK-ONLY —
// no poll surface (no mode/cursor/lastPolledAt columns). All registrations of a provider share ONE
// webhook URL; the row is resolved from the request by its webhookSecret (the provider echoes it — see
// Channel.identify), so the secret is the INBOUND ROUTING KEY: required and unique per provider.
export const channelRegistrationStatusValues = ["active", "disabled"] as const;

export const channelRegistrationFields = {
	// id = hash(provider, endpointKey): the natural key IS the primary key (see core/id.ts).
	id: field.string({ required: true, unique: true, immutable: true }),
	provider: field.string({ required: true, index: true, immutable: true }),
	// The stable identity a registration binds under (`registrations/${endpointKey}`) — chosen at
	// register time (e.g. an org id), NOT in the webhook URL, and never rotated.
	endpointKey: field.string({ required: true, index: true, immutable: true }),
	// Enforced at resolution: a disabled registration receives no webhooks. Revoke is soft — the row
	// (and its audit trail) survives.
	status: field.enum(channelRegistrationStatusValues, {
		required: true,
		index: true,
	}),
	// The egress credential (e.g. the bot token), stored in the row and read back at use time — the
	// sso `oidcConfig` model. `redacted` keeps it out of audit/exports; at-rest protection is the
	// host's database concern.
	secret: field.string({ pii: "redacted" }),
	// The INBOUND routing key AND verifier: the secret the provider echoes in each webhook (telegram's
	// secret_token). The plugin resolves the row by matching it, so it's REQUIRED and unique per provider;
	// `verify` then checks it. Indexed for the by-secret lookup; `redacted` keeps it out of audit/exports.
	webhookSecret: field.string({ required: true, index: true, pii: "redacted" }),
	// Whose bot this is — the organizationId analog. Merged into the claw bind defaults at dispatch.
	organizationId: field.string({ index: true }),
	// Bind defaults for conversations on this registration (sans organization — organizationId above wins).
	// Schema-first: the bindConversation claw/thread inputs are all-optional, so they hold at rest —
	// a bad default fails at REGISTER time (and on read), not first at dispatch. The context assembly
	// still re-validates the MERGED value (the org scope lands on top of these defaults).
	claw: field.json(bindConversationClawInput, { pii: "possible" }),
	thread: field.json(bindConversationThreadInput, { pii: "possible" }),
	// Webhook state — the last error (cleared on receipt) and the last time traffic arrived.
	lastError: field.jsonValue({ pii: "redacted" }),
	lastReceivedAt: field.string({ index: true }),
	createdAt: field.string({ required: true, immutable: true }),
	// Written by the store on every update, never caller-provided.
	updatedAt: field.string({ required: true, input: false }),
} as const;

export const channelRegistrationEntity = entity(
	"channel_registration",
	channelRegistrationFields,
);
export const channelRegistrationRecord = channelRegistrationEntity.record;

// Registration input: transport identity + credentials + bind scope. State columns (errors,
// timestamps) and the derived id/status are the store's to write, not the caller's. There is no `mode`
// input — a registration is always a webhook.
export const registerChannelRegistrationInputOptions = {
	omit: [
		"id",
		"status",
		"lastError",
		"lastReceivedAt",
		"createdAt",
		"updatedAt",
	],
} as const;
export const registerChannelRegistrationInput = channelRegistrationEntity
	.schema(registerChannelRegistrationInputOptions)
	.configure({
		euroclaw: {
			doc: "Registers a user's bot, or re-registers an existing one — the SSO-provider analog. Idempotent on the (provider, endpointKey) natural key: re-submitting the same key rotates the stored credentials and bind defaults in place and re-activates a revoked row (registration is the trust grant). `provider` must be one configured on this claw or the call is rejected; `endpointKey` becomes the conversation binding-key prefix `registrations/${endpointKey}`, so it must be a single slash-free segment. `webhookSecret` is the inbound routing key the provider echoes on each webhook and must be unique per provider. `organizationId`, when set, scopes the bound conversations to that org at dispatch and overrides any scope in the claw defaults.",
		},
	});

export const channelRegistrationLookupInputOptions = {
	pick: ["provider", "endpointKey"],
} as const;
export const channelRegistrationLookupInput = channelRegistrationEntity
	.schema(channelRegistrationLookupInputOptions)
	.configure({
		euroclaw: {
			doc: "Addresses one registration by its (provider, endpointKey) natural key — the pair is hashed into the row id, so there is no separate lookup index. Backs `getByKey` (read) and `revoke`, which soft-disables the row: it stops resolving webhooks but survives with its audit trail.",
		},
	});

// The list filter stays a plain-TS query shape in-process, but as a routed endpoint input it crosses
// the HTTP boundary — derived from the entity's own columns so the status enum can't drift.
export const listChannelRegistrationsInput = channelRegistrationEntity
	.schema({
		pick: ["provider", "organizationId", "status"],
		optional: ["provider", "status"],
	})
	.configure({
		euroclaw: {
			doc: "Filters the registration list; the supplied fields are AND-combined. `provider` and `status` narrow the set and `organizationId` scopes to one org's bots. The filter columns are picked from the entity so the `status` enum stays a single source of truth with storage.",
		},
	});

// The update patch derives from the fields — every mutable column, all optional (identity and
// server-managed columns drop out via their flags).
export const updateChannelRegistrationInput =
	channelRegistrationEntity.updateSchema();

/** The models this plugin registers via `plugin.schema` — collected into migrations. */
export const channelRegistrationsModels: Record<
	string,
	{ fields: Record<string, EntityField> }
> = {
	[channelRegistrationEntity.name]: {
		fields: channelRegistrationEntity.fields,
	},
};

/** The storage view of the same table — what the registrations store persists through. */
export const channelRegistrationsSchema: SchemaDeclaration = {
	...channelRegistrationEntity.storage,
};
