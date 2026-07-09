import {
	type Adapter,
	configurationError,
	type EntityRecord,
	type EntitySchemaInput,
	errorMessage,
	validationError,
	type Where,
} from "@euroclaw/contracts";
import { type } from "arktype";
import type { EndpointEvent } from "../core/contracts";
import { endpointId } from "../core/id";
import {
	type channelRegistrationFields,
	channelRegistrationLookupInput,
	type channelRegistrationLookupInputOptions,
	channelRegistrationRecord,
	type channelRegistrationStatusValues,
	registerChannelRegistrationInput,
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
// An internal query shape (not a parsed boundary — the api/cron build it in code), so it stays plain TS.
export type ChannelRegistrationListFilter = {
	provider?: string;
	organizationId?: string;
	status?: ChannelRegistrationStatus;
};

export type ChannelRegistrationsStore = {
	/**
	 * Register (or re-register) a bot — the sso `registerSSOProvider` analog. Idempotent on the
	 * (provider, endpointKey) natural key: re-registering rotates credentials/defaults in place and
	 * re-activates a revoked registration (registration is the trust grant).
	 */
	register: (
		input: RegisterChannelRegistrationInput,
	) => Promise<ChannelRegistrationRecord>;
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

function assertRegisterInput(input: unknown): RegisterChannelRegistrationInput {
	const valid = registerChannelRegistrationInput(input);
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

function assertRegistrationRecord(input: unknown): ChannelRegistrationRecord {
	const valid = channelRegistrationRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("channel registration record invalid", valid.summary);
	}
	return valid;
}

function listWhere(filter: ChannelRegistrationListFilter): Where[] {
	const where: Where[] = [];
	const add = (fieldName: string, value: string): void => {
		where.push(
			where.length === 0
				? { field: fieldName, value }
				: { field: fieldName, value, connector: "AND" },
		);
	};
	if (filter.provider !== undefined) add("provider", filter.provider);
	if (filter.organizationId !== undefined)
		add("organizationId", filter.organizationId);
	if (filter.status !== undefined) add("status", filter.status);
	return where;
}

/** The registration registry — user-registered bots persisted through a schema-aware adapter. */
export function createChannelRegistrationsStore(
	// The schema-aware adapter the assembly hands through the configure context; tests wrap manually.
	db: Adapter,
	options: ChannelRegistrationsStoreOptions = {},
): ChannelRegistrationsStore {
	const now = options.now ?? (() => new Date().toISOString());

	const patchByKey = async (
		lookup: ChannelRegistrationLookup,
		patch: Record<string, unknown>,
	): Promise<ChannelRegistrationRecord | null> => {
		const valid = updateChannelRegistrationInput(patch);
		if (valid instanceof type.errors) {
			throw validationError(
				"channel registration patch invalid",
				valid.summary,
			);
		}
		const row = await guarded(() =>
			db.update<ChannelRegistrationRecord>({
				model: "channel_registration",
				where: [{ field: "id", value: endpointId(lookup) }],
				update: { ...valid, updatedAt: now() },
			}),
		);
		return row ? assertRegistrationRecord(row) : null;
	};

	return {
		async register(input) {
			const valid = assertRegisterInput(input);
			const { provider, endpointKey, ...rest } = valid;
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
			// Re-registration is the trust grant: rotate credentials/defaults and re-activate.
			const existing = await this.getByKey(lookup);
			if (existing) {
				const updated = await patchByKey(lookup, { ...rest, status: "active" });
				if (updated) return updated;
			}
			const ts = now();
			const record = assertRegistrationRecord({
				...valid,
				id: endpointId(lookup),
				status: "active",
				createdAt: ts,
				updatedAt: ts,
			});
			try {
				await guarded(() =>
					db.create({ model: "channel_registration", data: record }),
				);
				return record;
			} catch (err) {
				// create raced another register onto the same natural key (id is its hash) — fall through
				// to patching the winner's row.
				const raced = await patchByKey(lookup, { ...rest, status: "active" });
				if (raced) return raced;
				throw err;
			}
		},

		get(id) {
			return guarded(() =>
				db.findOne<ChannelRegistrationRecord>({
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
			const row = await guarded(() =>
				db.findOne<ChannelRegistrationRecord>({
					model: "channel_registration",
					where: [
						{ field: "provider", value: provider },
						{ field: "webhookSecret", value: webhookSecret, connector: "AND" },
					],
				}),
			);
			return row ? assertRegistrationRecord(row) : null;
		},

		list(filter = {}) {
			return guarded(() =>
				db.findMany<ChannelRegistrationRecord>({
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
