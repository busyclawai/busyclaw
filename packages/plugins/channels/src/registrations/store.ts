import {
	type Adapter,
	configurationError,
	type EntityRecord,
	type EntitySchemaInput,
	errorMessage,
	isConflict,
	validationError,
} from "@busyclaw/contracts";
import type { SecretBinding, SecretCipher } from "@busyclaw/secrets";
import {
	type EntityWhere,
	type EntityWhereClause,
	entityView,
} from "@busyclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import type { EndpointEvent } from "../core/contracts";
import { endpointId } from "../core/id";
import {
	channelRegistrationFields,
	channelRegistrationLookupInput,
	type channelRegistrationLookupInputOptions,
	type channelRegistrationStatusValues,
	createChannelRegistrationInput,
	type createChannelRegistrationOptions,
	type registerChannelRegistrationInputOptions,
	updateChannelRegistrationInput,
} from "./schema";

// Types projected from the one entity (the schema module is this store's contract): the record and the
// two input shapes derive from the field map + their schema options, so there is one source of truth and
// no hand-kept object literal to drift. The runtime arktype validators live beside them in schema.ts.
export type ChannelRegistrationStatus =
	(typeof channelRegistrationStatusValues)[number];
export type ChannelRegistrationRecord = EntityRecord<
	typeof channelRegistrationFields
>;
export type RegisterChannelRegistrationInput = EntitySchemaInput<
	typeof channelRegistrationFields,
	typeof registerChannelRegistrationInputOptions
>;
export type ChannelRegistrationLookup = EntitySchemaInput<
	typeof channelRegistrationFields,
	typeof channelRegistrationLookupInputOptions
>;
/** What the STORE takes at create — the caller's input plus the `createdBy` the handler stamped. */
export type CreateChannelRegistrationInput = EntitySchemaInput<
	typeof channelRegistrationFields,
	typeof createChannelRegistrationOptions
>;
// An internal query shape (not a parsed boundary — the api/cron build it in code), so it stays plain TS.
export type ChannelRegistrationListFilter = {
	provider?: string;
	scope?: string;
	scopeId?: string;
	status?: ChannelRegistrationStatus;
};

/**
 * What the MANAGEMENT api returns — the row with both secrets removed.
 *
 * The store keeps handing out whole rows because the webhook path genuinely needs them: dispatch calls
 * the provider with `secret`, and `getBySecret` matches on `webhookSecret`. Neither is a caller's to see.
 * `redacted` on those columns was never the control it looked like — it keeps them out of audit and
 * exports, and left them in every ordinary read, so `register` handed the bot token straight back and
 * `list` handed back every token in the boundary.
 *
 * `hasSecret` survives because "is this registration configured" is the real question a management UI
 * asks of the credential, and answering it needs one bit, not the value.
 */
/**
 * The stored form of an inbound routing key.
 *
 * R-M07. `webhookSecret` was persisted VERBATIM — a live credential sitting in a table, readable by
 * anything with database access, and the one credential an attacker most wants because presenting it
 * IS how a request proves which registration it is. It could not simply be encrypted: the row is
 * FOUND by matching it, and a nonce-per-row ciphertext is unmatchable.
 *
 * So it is digested instead, which is what a high-entropy random secret wants anyway — the same shape
 * every API-key store uses. Lookup hashes what the request presented and matches that; the plaintext
 * exists only for the length of a request. Unkeyed on purpose: the value is provider-generated random
 * material, so there is no dictionary to attack and a key here would add custody without adding
 * secrecy — which is a cost with no buyer.
 */
export function webhookSecretDigest(secret: string): string {
	return bytesToHex(sha256(utf8ToBytes(secret)));
}

export type ChannelRegistrationView = Omit<
	ChannelRegistrationRecord,
	"secret" | "webhookSecret"
> & { hasSecret: boolean };

/** Project a stored row into the view. The one place credentials are dropped — every api handler returns
 *  through it, so adding a method cannot accidentally return a raw row. */
export function toChannelRegistrationView(
	row: ChannelRegistrationRecord,
): ChannelRegistrationView;
export function toChannelRegistrationView(
	row: ChannelRegistrationRecord | null,
): ChannelRegistrationView | null;
export function toChannelRegistrationView(
	row: ChannelRegistrationRecord | null,
): ChannelRegistrationView | null {
	if (row === null) return null;
	const { secret, webhookSecret, ...rest } = row;
	return { ...rest, hasSecret: secret !== undefined && secret !== "" };
}

export type ChannelRegistrationsStore = {
	/**
	 * CREATE a bot registration — the sso `registerSSOProvider` analog. Create-ONLY: `null` means the
	 * (provider, endpointKey) natural key is already taken.
	 *
	 * It used to rotate an existing row in place, and that is the whole of R-H09. The endpoint asked
	 * for `manage` only when its OWN read found a row; the store then read again and patched whatever
	 * it found — with the second caller's token, secret, scope and bind defaults — and the create's
	 * catch path did the same on a lost race. A caller arriving before the row existed, or losing the
	 * create by microseconds, rewrote somebody else's registration having been asked for nothing. The
	 * key is caller-chosen, so two tenants picking the same obvious name is enough.
	 *
	 * Taking over an existing row is a management operation on it, so the decision belongs where the
	 * decisions are: `null` sends the caller back to the api layer to load the winner, authorize
	 * `manage` against THAT row, and rotate it through {@link rotate}.
	 */
	register: (
		input: CreateChannelRegistrationInput,
	) => Promise<ChannelRegistrationRecord | null>;
	/**
	 * Rotate an EXISTING registration's credentials and bind defaults, and re-activate it.
	 *
	 * `expectedUpdatedAt` makes it a compare-and-set: the row must still be the one the caller
	 * authorized against. Without it, `manage` is decided against a row that can change before the
	 * write lands — the same time-of-check gap one layer down.
	 */
	rotate: (
		lookup: ChannelRegistrationLookup,
		patch: Record<string, unknown>,
		expectedUpdatedAt: string,
	) => Promise<ChannelRegistrationRecord | null>;
	get: (id: string) => Promise<ChannelRegistrationRecord | null>;
	getByKey: (
		input: ChannelRegistrationLookup,
	) => Promise<ChannelRegistrationRecord | null>;
	/**
	 * Resolve a registration by its inbound routing key — the webhookSecret the provider echoes in a
	 * request (`Channel.identify`). The webhook route's only lookup: one URL per provider, the row found
	 * by secret. Returns the row at any status; the caller enforces `active`.
	 */
	getBySecret: (
		provider: string,
		webhookSecret: string,
	) => Promise<ChannelRegistrationRecord | null>;
	list: (
		filter?: ChannelRegistrationListFilter,
	) => Promise<ChannelRegistrationRecord[]>;
	/** Soft-disable: the registration stops resolving but the row survives. */
	revoke: (
		input: ChannelRegistrationLookup,
	) => Promise<ChannelRegistrationRecord | null>;
	/** Map a dispatch event onto the registration's webhook state columns. */
	record: (
		key: ChannelRegistrationLookup,
		event: EndpointEvent,
	) => Promise<ChannelRegistrationRecord | null>;
};

export type ChannelRegistrationsStoreOptions = {
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
	/**
	 * The at-rest cipher for the BOT TOKEN (R-M07). Absent ⇒ stored as it arrives, which is what a
	 * deployment with no master key configured gets — and what every deployment used to get.
	 *
	 * The token is the credential that acts AS the bot: whoever holds it sends as that bot, reads its
	 * conversations, and does not need this system at all to do it. It sat in a column readable by
	 * anything with database access.
	 */
	cipher?: SecretCipher;
};

// ── Enabled-but-not-migrated safety net (the secret-alias.ts precedent) ──────────────────────────
// Enabling registrations adds `channel_registration` to the generated schema (host runs
// generate→migrate). If the table isn't there, a DB call throws a native "no such table"/"does not
// exist" error — every op wraps that into a clear configurationError. Fires on first table access.

/** A DB error meaning the `channel_registration` table isn't migrated — sqlite/postgres/mysql phrasings. */
function isMissingTableError(err: unknown): boolean {
	const message = errorMessage(err).toLowerCase();
	return (
		message.includes("no such table") || // sqlite
		message.includes("does not exist") || // postgres: relation "channel_registration" does not exist
		message.includes("doesn't exist") || // mysql
		message.includes("no such relation") ||
		message.includes("unknown table")
	);
}

/** Rethrow a table-missing DB error as an actionable configurationError; otherwise rethrow as-is. */
function wrapMissingTable(err: unknown): never {
	if (isMissingTableError(err)) {
		throw configurationError(
			"channel_registration table isn't in your database — run the migration for channel registrations",
			{
				reason:
					"enabling registrations adds channel_registration to the generated schema — run generate + migrate to create it",
				cause: errorMessage(err),
			},
		);
	}
	throw err;
}

/** Run one adapter op behind the missing-table safety net. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		return wrapMissingTable(err);
	}
}

function assertRegisterInput(input: unknown): CreateChannelRegistrationInput {
	const valid = createChannelRegistrationInput(input);
	if (valid instanceof type.errors) {
		throw validationError(
			"register channel registration invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertLookup(input: unknown): ChannelRegistrationLookup {
	const valid = channelRegistrationLookupInput(input);
	if (valid instanceof type.errors) {
		throw validationError("channel registration lookup invalid", valid.summary);
	}
	return valid;
}

type RegistrationWhere = EntityWhere<typeof channelRegistrationFields>;

function listWhere(filter: ChannelRegistrationListFilter): RegistrationWhere[] {
	const where: RegistrationWhere[] = [];
	const add = (
		fieldName: EntityWhereClause<typeof channelRegistrationFields>["field"],
		value: string,
	): void => {
		where.push(
			where.length === 0
				? { field: fieldName, value }
				: { field: fieldName, value, connector: "AND" },
		);
	};
	if (filter.provider !== undefined) add("provider", filter.provider);
	if (filter.scope !== undefined) add("scope", filter.scope);
	if (filter.scopeId !== undefined) add("scopeId", filter.scopeId);
	if (filter.status !== undefined) add("status", filter.status);
	return where;
}

/** The registration registry — user-registered bots persisted through the entity-validating adapter. */
/**
 * The AAD a registration's bot token is sealed under — its own boundary and its own key.
 *
 * Row-specific on purpose: a ciphertext lifted from one registration's row into another's will not
 * open, because the tag is bound to the (scope, scopeId, name) it was sealed for. That is what makes
 * ONE deployment key safe across every consumer of this cipher — a sealed bot token cannot be opened
 * as a PII original or another tenant's token even under the same key.
 */
function tokenBinding(row: {
	scope: string;
	scopeId: string;
	provider: string;
	endpointKey: string;
}): SecretBinding {
	return {
		scope: row.scope,
		scopeId: row.scopeId,
		name: `channel:${row.provider}:${row.endpointKey}`,
	};
}

/**
 * Open a stored bot token for use.
 *
 * The single decrypt point: the plaintext exists for the length of one outbound call and is never
 * returned by an ordinary read (`ChannelRegistrationView` omits it entirely). Absent cipher, or a row
 * written before sealing existed, passes through — which is what a deployment with no master key gets
 * and what every deployment had until now.
 */
export async function openRegistrationSecret(
	row: ChannelRegistrationRecord,
	cipher?: SecretCipher,
): Promise<string | undefined> {
	if (row.secret === undefined) return undefined;
	if (!cipher) return row.secret;
	try {
		return await cipher.open(row.secret, tokenBinding(row));
	} catch {
		// A row sealed before the cipher was configured, or written by an older build: the value is
		// what it is. Returned as-is rather than failing the send, because refusing here would take a
		// working bot offline over a migration nobody was told to run.
		return row.secret;
	}
}

export function createChannelRegistrationsStore(
	// The entity-validating adapter the assembly hands through the configure context; entityView
	// opens the typed lens for this plugin's own model (fails loud if the model was never declared).
	// Tests wrap manually: entityAdapter(memoryAdapter(), …).
	adapter: Adapter,
	options: ChannelRegistrationsStoreOptions = {},
): ChannelRegistrationsStore {
	const db = entityView(adapter, {
		channel_registration: { fields: channelRegistrationFields },
	});
	const now = options.now ?? (() => new Date().toISOString());

	const patchByKey = async (
		lookup: ChannelRegistrationLookup,
		patch: Record<string, unknown>,
		expectedUpdatedAt?: string,
	): Promise<ChannelRegistrationRecord | null> => {
		const valid = updateChannelRegistrationInput(patch);
		if (valid instanceof type.errors) {
			throw validationError(
				"channel registration patch invalid",
				valid.summary,
			);
		}
		return guarded(() =>
			db.update({
				model: "channel_registration",
				where: [
					{ field: "id", value: endpointId(lookup) },
					// The CAS half: the row must still be the one the caller was authorized against.
					...(expectedUpdatedAt !== undefined
						? [
								{
									field: "updatedAt" as const,
									value: expectedUpdatedAt,
									connector: "AND" as const,
								},
							]
						: []),
				],
				update: { ...valid, updatedAt: now() },
			}),
		);
	};

	return {
		async register(input) {
			const valid = assertRegisterInput(input);
			// `createdBy` is immutable and drops out of the rotate patch: a re-registration by someone who
			// merely MANAGES the row rotates its credentials, it does not make them the registrant.
			const { provider, endpointKey, createdBy } = valid;
			const lookup = { provider, endpointKey };
			// The webhookSecret is the inbound ROUTING key (the row is found by it), so it must be unique
			// per provider — a different registration claiming it would make routing ambiguous. Fail loud.
			const secretOwner = await this.getBySecret(provider, valid.webhookSecret);
			if (secretOwner && secretOwner.endpointKey !== endpointKey) {
				throw validationError(
					"channel registration webhookSecret already in use",
					`another registration for "${provider}" already uses this secret`,
					{ provider, endpointKey },
				);
			}
			// Create-only. An existing row is somebody's, and rotating it is a decision the api layer
			// makes after authorizing `manage` — not something this port does because the key matched.
			if (await this.getByKey(lookup)) return null;
			const ts = now();
			const scope = valid.scope ?? "personal";
			const scopeId = valid.scopeId ?? createdBy;
			const sealedSecret =
				options.cipher && valid.secret !== undefined
					? await options.cipher.seal(
							valid.secret,
							tokenBinding({ scope, scopeId, provider, endpointKey }),
						)
					: undefined;
			try {
				return await guarded(() =>
					db.create({
						model: "channel_registration",
						data: {
							...valid,
							// R-M07: the ROUTING KEY is stored digested, never verbatim. Written here rather
							// than by the caller so no write path can forget it.
							webhookSecret: webhookSecretDigest(valid.webhookSecret),
							// …and the BOT TOKEN sealed. Same rule, different mechanism: this one is read
							// BACK to call the provider, so it is encrypted rather than hashed.
							...(sealedSecret !== undefined ? { secret: sealedSecret } : {}),
							// Personal until registered into a boundary — the same default a claw takes, and
							// the reason an omitted boundary can never widen who reaches the row.
							scope: valid.scope ?? "personal",
							scopeId: valid.scopeId ?? createdBy,
							id: endpointId(lookup),
							status: "active",
							createdAt: ts,
							updatedAt: ts,
						},
					}),
				);
			} catch (err) {
				// Lost the create to a concurrent register on the same natural key (the id is its hash).
				// The winner's row is theirs; this reports the conflict rather than patching it, which
				// is exactly what the catch used to do without asking anyone.
				if (isConflict(err) || (await this.getByKey(lookup))) return null;
				throw err;
			}
		},

		async rotate(lookup, patch, expectedUpdatedAt) {
			// R-M07: a rotation carries a NEW routing key, and it is digested on the way in for the same
			// reason the create digests — the column never holds the verbatim credential, whichever write
			// path put it there.
			const routingKey = patch.webhookSecret;
			const token = patch.secret;
			// The row's OWN boundary is the AAD, so a rotation has to read it rather than trust the
			// patch — a patch that moved the boundary and resealed under the new one would let a token
			// be relocated into another tenant and still open.
			const current = await this.getByKey(lookup);
			const sealed =
				options.cipher && typeof token === "string" && current
					? await options.cipher.seal(token, tokenBinding(current))
					: undefined;
			return patchByKey(
				lookup,
				{
					...patch,
					...(typeof routingKey === "string"
						? { webhookSecret: webhookSecretDigest(routingKey) }
						: {}),
					...(sealed !== undefined ? { secret: sealed } : {}),
				},
				expectedUpdatedAt,
			);
		},

		get(id) {
			return guarded(() =>
				db.findOne({
					model: "channel_registration",
					where: [{ field: "id", value: id }],
				}),
			);
		},

		getByKey(input) {
			const lookup = assertLookup(input);
			return this.get(endpointId(lookup));
		},

		async getBySecret(provider, webhookSecret) {
			return guarded(() =>
				db.findOne({
					model: "channel_registration",
					where: [
						{ field: "provider", value: provider },
						{
							field: "webhookSecret",
							value: webhookSecretDigest(webhookSecret),
							connector: "AND",
						},
					],
				}),
			);
		},

		list(filter = {}) {
			return guarded(() =>
				db.findMany({
					model: "channel_registration",
					where: listWhere(filter),
				}),
			);
		},

		revoke(input) {
			const lookup = assertLookup(input);
			return patchByKey(lookup, { status: "disabled" });
		},

		record(key, event) {
			const lookup = assertLookup(key);
			// Registrations are webhook-only: dispatchWebhook emits `received` and nothing else (there is no
			// poll cron, so `polled`/`poll-error` never reach a registration). Map receipt onto the webhook
			// state columns; clear any stale error.
			if (event.kind === "received") {
				return patchByKey(lookup, { lastError: null, lastReceivedAt: now() });
			}
			return Promise.resolve(null);
		},
	};
}
