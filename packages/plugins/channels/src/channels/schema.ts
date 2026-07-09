import type { SchemaDeclaration } from "@euroclaw/contracts";
import { type EntityField, entity, field } from "@euroclaw/contracts";
import { channelEndpointModeValues } from "../core/contracts";

// Operational STATE for the app's own (code-declared) bots — the account-side of the split. No
// credentials and no tenancy live here: code bots keep clients in memory, and whose data a
// conversation is rides the claw it binds to. Registered (user-owned) bots live in the
// channel_registration table instead (channels() registrations mode) — the ssoProvider analog.
export const channelEndpointFields = {
	// id = hash(provider, endpointKey): the natural key IS the primary key (see core/id.ts).
	id: field.string({ required: true, unique: true, immutable: true }),
	provider: field.string({ required: true, index: true, immutable: true }),
	endpointKey: field.string({ required: true, index: true, immutable: true }),
	mode: field.enum(channelEndpointModeValues, { required: true }),
	cursor: field.jsonValue({ pii: "possible" }),
	lastError: field.jsonValue({ pii: "redacted" }),
	lastReceivedAt: field.string({ index: true }),
	lastPolledAt: field.string({ index: true }),
	createdAt: field.string({ required: true, immutable: true }),
	// Written by the store on every update, never caller-provided.
	updatedAt: field.string({ required: true, input: false }),
} as const;

export const channelEndpointEntity = entity(
	"channel_endpoint",
	channelEndpointFields,
);
export const channelEndpointRecord = channelEndpointEntity.record;

// The state patch derives from the fields — every mutable column, all optional.
export const channelEndpointStatePatch = channelEndpointEntity.updateSchema();

/** The models the channels plugin registers via `plugin.schema` — collected into migrations. */
export const channelsModels: Record<
	string,
	{ fields: Record<string, EntityField> }
> = { [channelEndpointEntity.name]: { fields: channelEndpointEntity.fields } };

/** The storage view of the same table — what the state store persists through. */
export const channelsSchema: SchemaDeclaration = {
	...channelEndpointEntity.storage,
};
