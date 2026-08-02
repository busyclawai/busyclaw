import type { SchemaDeclaration } from "@busyclaw/contracts";
import {
	bindConversationClawInput,
	bindConversationThreadInput,
	type EntityField,
	entity,
	field,
} from "@busyclaw/contracts";

// A channel registration is a USER-registered bot — the ssoProvider analog: registered at runtime,
// credentials stored in the row and read back at use. Registrations are WEBHOOK-ONLY — no poll surface
// (no mode/cursor/lastPolledAt columns). All registrations of a provider share ONE webhook URL; the row
// is resolved from the request by its webhookSecret (the provider echoes it — see Channel.identify), so
// the secret is the INBOUND ROUTING KEY: required and unique per provider.
//
// A registration is a SHAREABLE resource like a claw: `createdBy` + the `(scope, scopeId)` boundary, and
// the plugin registers the `channel_registration` kind so the generic PEP decides every management call.
// Before those columns existed the row belonged to nobody, which meant any authenticated caller reached
// any tenant's bot — read its token, re-point its conversations, revoke it.
//
// The boundary REPLACED a bare `organizationId`, which was the same idea spelled org-only: the pair says
// where this bot's conversations land AND who may manage it, and core reads neither half (an
// `organization` scope means something to the org plugin, nothing here).
export const channelRegistrationStatusValues = ["active", "disabled"] as const;

export const channelRegistrationFields = {
	// id = hash(provider, endpointKey): the natural key IS the primary key (see core/id.ts).
	id: field.string({ required: true, unique: true, immutable: true }),
	provider: field.string({
		required: true,
		index: true,
		immutable: true,
		doc: "Must name a provider handed to channels([...]) — register rejects unknown providers; with endpointKey it forms the natural key the row id hashes.",
	}),
	// The stable identity a registration binds under (`registrations/${endpointKey}`) — chosen at
	// register time (e.g. an org id), NOT in the webhook URL, and never rotated.
	endpointKey: field.string({
		required: true,
		index: true,
		immutable: true,
		doc: "A single path-segment key (letters, digits, _ or -; no slash — enforced at register). Becomes the `registrations/`-prefixed conversation binding key, disjoint from app-bot keys by construction; re-registering the same (provider, endpointKey) rotates the row in place.",
	}),
	// Enforced at resolution: a disabled registration receives no webhooks. Revoke is soft — the row
	// (and its audit trail) survives.
	status: field.enum(channelRegistrationStatusValues, {
		required: true,
		index: true,
		doc: "Soft lifecycle: revoke sets 'disabled' — the row stops resolving webhooks (indistinguishable from absent to callers) but survives with its audit trail; re-registering sets 'active' again.",
	}),
	// The egress credential (e.g. the bot token), stored in the row and read back at use time — the
	// sso `oidcConfig` model. `redacted` keeps it out of audit/exports; at-rest protection is the
	// host's database concern.
	secret: field.string({
		pii: "redacted",
		doc: "The egress credential (e.g. the bot token) dispatch reads back to call the provider; rotated in place by re-registering the same key.",
	}),
	// The INBOUND routing key AND verifier: the secret the provider echoes in each webhook (telegram's
	// secret_token). The plugin resolves the row by matching it, so it's REQUIRED and unique per provider;
	// `verify` then checks it. Indexed for the by-secret lookup; `redacted` keeps it out of audit/exports.
	webhookSecret: field.string({
		required: true,
		index: true,
		pii: "redacted",
		doc: "Inbound routing key and verifier: the provider echoes it on each webhook (e.g. telegram's secret_token) and the row is resolved by matching it, so it must be unique per provider — registering it under a second endpointKey fails loud.",
	}),
	// Who registered this bot — the accountability and erasure key, never the access boundary. Stamped
	// from the authenticated caller at register, never read from the body, and never rotated by a
	// re-registration (a manager rotating credentials does not become the registrant).
	createdBy: field.principal({
		required: true,
		index: true,
		immutable: true,
		doc: "Immutable registrant principal — stamped from the authenticated caller, the accountability key; the access boundary is the separate mutable (scope, scopeId) pair.",
	}),
	// The access boundary, exactly as a claw carries it. Both halves are opaque here.
	scope: field.string({
		required: true,
		index: true,
		doc: "Access-boundary KIND, opaque to the core ('personal'/'organization' mean something to plugins, not here); defaults to 'personal' at register.",
	}),
	scopeId: field.string({
		required: true,
		index: true,
		doc: "The access boundary's id — with scope it names who may manage this bot AND where its bound conversations land; defaults to createdBy at register (personal until registered into a boundary the caller belongs to).",
	}),
	// Bind defaults for conversations on this registration (sans the boundary — the row's own wins).
	// Schema-first: the bindConversation claw/thread inputs are all-optional, so they hold at rest —
	// a bad default fails at REGISTER time (and on read), not first at dispatch. The context assembly
	// still re-validates the MERGED value (the org scope lands on top of these defaults).
	claw: field.json(bindConversationClawInput, {
		pii: "possible",
		doc: "Bind defaults for the claw a fresh conversation creates — validated at register (a bad default fails there, not at first traffic) and re-validated at dispatch after the org scope merges on top; createdBy is filled at bind time.",
	}),
	thread: field.json(bindConversationThreadInput, {
		pii: "possible",
		doc: "Bind defaults for the thread a fresh conversation creates; validated at register, read back at dispatch.",
	}),
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
	{
		// The webhookSecret is the INBOUND ROUTING KEY — the webhook route resolves the row by matching
		// it — so two rows sharing one makes routing ambiguous, and which bot receives a tenant's
		// traffic becomes a question of row order. The column's doc has always claimed this; the store
		// enforced it by reading before writing, which is the same time-of-check gap as the
		// registration race above (two registers both read "free", both write). A physical unique is
		// what makes the claim true under concurrency, turning a lost race into a loud conflict
		// instead of a silently ambiguous route. R-H09.
		uniques: [["provider", "webhookSecret"]],
	},
);
export const channelRegistrationRecord = channelRegistrationEntity.record;

// Registration input: transport identity + credentials + bind boundary. State columns (errors,
// timestamps) and the derived id/status are the store's to write, not the caller's. There is no `mode`
// input — a registration is always a webhook.
//
// `createdBy` is OMITTED, not optional: it is stamped from the authenticated caller in the handler, so a
// forged body loses to runtime proof. `(scope, scopeId)` stay caller-settable but are not free — an
// explicit boundary is authorized as membership before the row is written (see the register handler),
// and an omitted one defaults to the caller's own personal boundary.
export const registerChannelRegistrationInputOptions = {
	omit: [
		"id",
		"status",
		"createdBy",
		"lastError",
		"lastReceivedAt",
		"createdAt",
		"updatedAt",
	],
	optional: ["scope", "scopeId"],
} as const;
export const registerChannelRegistrationInput = channelRegistrationEntity
	.schema(registerChannelRegistrationInputOptions)
	.configure({
		busyclaw: {
			// Operation-level prose only — the per-field semantics (provider/endpointKey/
			// webhookSecret/scope/…) now ride the field map above and flow into this
			// derived schema's properties, so restating them here would be the drift machine.
			doc: "Registers a user's bot, or re-registers an existing one — the SSO-provider analog. Idempotent on the (provider, endpointKey) natural key: re-submitting the same key rotates the stored credentials and bind defaults in place and re-activates a revoked row (registration is the trust grant, and re-registering requires manage on the existing row).",
		},
	});

// The STORE boundary, one step wider than the caller's: `createdBy` is REQUIRED here because the handler
// has already stamped it. The two must not be the same schema — the caller must not be able to send the
// field the handler proves.
export const createChannelRegistrationOptions = {
	omit: [
		"id",
		"status",
		"lastError",
		"lastReceivedAt",
		"createdAt",
		"updatedAt",
	],
	optional: ["scope", "scopeId"],
} as const;
export const createChannelRegistrationInput = channelRegistrationEntity.schema(
	createChannelRegistrationOptions,
);

export const channelRegistrationLookupInputOptions = {
	pick: ["provider", "endpointKey"],
} as const;
export const channelRegistrationLookupInput = channelRegistrationEntity
	.schema(channelRegistrationLookupInputOptions)
	.configure({
		busyclaw: {
			doc: "Addresses one registration by its (provider, endpointKey) natural key — the pair is hashed into the row id, so there is no separate lookup index. Backs `getByKey` (read) and `revoke`, which soft-disables the row: it stops resolving webhooks but survives with its audit trail.",
		},
	});

// The list filter stays a plain-TS query shape in-process, but as a routed endpoint input it crosses
// the HTTP boundary — derived from the entity's own columns so the status enum can't drift.
export const listChannelRegistrationsInput = channelRegistrationEntity
	.schema({
		pick: ["provider", "scope", "scopeId", "status"],
		optional: ["provider", "scope", "scopeId", "status"],
	})
	.configure({
		busyclaw: {
			doc: "Filters the registration list; the supplied fields are AND-combined. `provider` and `status` narrow the set and `(scope, scopeId)` narrows to one boundary's bots. The filter only narrows — every row the filter admits is still authorized individually, so a wide filter returns what the caller may read rather than everything. The filter columns are picked from the entity so the `status` enum stays a single source of truth with storage.",
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
