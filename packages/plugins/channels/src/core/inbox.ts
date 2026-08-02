// The delivery inbox — one row per (provider, endpoint, deliveryId), claimed before the turn runs.
//
// A provider retries: on a non-2xx, on a timeout, on its own schedule. Nothing distinguished a retry
// from a new message, so the whole turn ran again — a second model charge, a second set of tool calls,
// a second reply, under a new run id. The endpoint row recorded only that SOMETHING arrived
// (`lastReceivedAt`), which cannot tell one delivery from the next.
//
// The claim is the row's own creation. `id` is the natural key hashed, so a second attempt at the same
// delivery loses the insert — the database arbitrates, not a read-then-write that two processes can
// both pass. The same shape the effect ledger and the approval lease use, for the same reason.
//
// Rows are RETAINED after completion, deliberately: a claim that vanished on success would let the
// retry that arrives a second later look new again. They are the memory of what has been handled, so
// they must outlive the provider's retry window — pruning them is a deployment's own housekeeping and
// is left to the host rather than guessed at here.

import type { Adapter, JsonValue } from "@busyclaw/contracts";
import {
	BusyclawError,
	type EntityField,
	entity,
	field,
	type SchemaDeclaration,
} from "@busyclaw/contracts";
import { entityView, isUniqueViolation } from "@busyclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Is this the database saying "that row already exists"?
 *
 * The whole insert-as-claim shape rests on telling ONE failure apart from every other. A duplicate
 * means somebody else got here first, and the recovery is to re-read and adopt the winner. Anything
 * else means the write did not happen at all — and the two must not be answered the same way, because
 * the answer to a duplicate is "carry on, it is handled".
 *
 * A bare `catch` collapsed them, so a dropped connection, a missing table, or a misconfigured adapter
 * read as "already claimed" and the caller proceeded as though the delivery were safely somebody's.
 * That is the shape that loses a message while reporting 200.
 *
 * Both spellings are accepted because both arrive honestly: the assembly wraps its adapter with
 * `entityAdapter`, which normalizes a driver's violation into the typed conflict, while a host passing
 * an unwrapped adapter gets whatever its driver raised. Anything unrecognised is NOT a conflict and is
 * rethrown with its identity and stack intact — guessing wrong turns a real outage into a silent
 * success, which is strictly worse than a loud failure.
 */
function isConflict(error: unknown): boolean {
	return (
		(error instanceof BusyclawError && error.code === "BUSYCLAW_CONFLICT") ||
		isUniqueViolation(error)
	);
}

export const channelDeliveryStatusValues = ["processing", "completed"] as const;
export type ChannelDeliveryStatus =
	(typeof channelDeliveryStatusValues)[number];

export const channelDeliveryFields = {
	/** hash(provider, endpointKey, deliveryId) — the natural key IS the primary key, so the insert is
	 *  the claim and a duplicate is a database conflict rather than a race two readers can both win. */
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	provider: field.string({ required: true, index: true, immutable: true }),
	endpointKey: field.string({ required: true, index: true, immutable: true }),
	/** The provider's own id for this delivery, verbatim. */
	deliveryId: field.string({ required: true, index: true, immutable: true }),
	status: field.enum(channelDeliveryStatusValues, {
		required: true,
		index: true,
		doc: "`processing` while the turn runs, `completed` once it has. A `processing` row whose lease has lapsed is a turn that died mid-flight and may be retried; a `completed` one is never re-run.",
	}),
	/** When a `processing` claim goes stale. A turn that died mid-flight would otherwise hold its
	 *  delivery forever, and the provider's retry — the one thing that could recover it — would be
	 *  turned away by the claim its own crashed predecessor left behind. */
	leaseExpiresAt: field.string({ index: true }),
	/**
	 * WHICH attempt holds this delivery — the fence.
	 *
	 * The expiry alone answers "has the holder gone away?", and that was the only question the row
	 * could answer. It cannot answer "am I still the holder?", so a slow turn whose lease lapsed and
	 * was re-taken went on to call `complete` and marked the delivery finished while its successor was
	 * still running it. The successor's work then looked like a second, unclaimed turn.
	 *
	 * Every transition after the claim is matched on this, so a runner that lost its lease can no
	 * longer act on the row — the same rule the approval lease applies, for the same reason.
	 */
	leaseId: field.string({
		doc: "Identifies the attempt holding this delivery. Completion and heartbeat are accepted only from the lease that is current, so a runner whose lease lapsed and was re-taken cannot finish over its successor.",
	}),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const channelDeliveryEntity = entity(
	"channel_delivery",
	channelDeliveryFields,
);

/** The models the inbox contributes via `plugin.schema`. */
export const channelDeliveryModels: Record<
	string,
	{ fields: Record<string, EntityField> }
> = {
	[channelDeliveryEntity.name]: { fields: channelDeliveryEntity.fields },
};

/** The storage view of the same table. */
export const channelDeliverySchema: SchemaDeclaration = {
	...channelDeliveryEntity.storage,
};

/**
 * The row id for one delivery — the natural key, hashed.
 *
 * The parts are joined by NUL because a `deliveryId` is the PROVIDER's string and may hold anything,
 * including whatever separator looked safe. Under a printable one, `("a b", "c")` and `("a", "b c")`
 * hash alike, so two different deliveries would share a claim and one of them would silently never
 * run. NUL cannot occur in any of the three, so the join is unambiguous.
 *
 * Written as the ESCAPE rather than a literal NUL byte. Identical string, but a source file carrying
 * a raw NUL is BINARY to git: every diff of this file read "Binary files differ", so no change to the
 * queue could be reviewed.
 */
export function deliveryRowId(key: {
	provider: string;
	endpointKey: string;
	deliveryId: string;
}): string {
	return bytesToHex(
		sha256(
			utf8ToBytes(
				`${key.provider}\u0000${key.endpointKey}\u0000${key.deliveryId}`,
			),
		),
	);
}

/** The proof that an attempt holds a delivery — carried back into every later transition on it. */
export type DeliveryClaim = { leaseId: string };

/** What a dispatch asks of the inbox. Absent entirely when the claw has no database — the same
 *  deployment shape that has no registration rows either. */
export type DeliveryInbox = {
	/**
	 * Take this delivery, or report that somebody already has.
	 *
	 * A claim ⇒ it is yours to process, and the `leaseId` is the proof to present at every later step.
	 * `null` ⇒ it is already completed, or being processed right now under a live lease, and this
	 * attempt must not run the turn again. A `processing` row whose lease has LAPSED is re-takeable
	 * exactly once more: that is a turn which died mid-flight, and a retry is the only thing that can
	 * recover it.
	 */
	claim: (key: DeliveryKey, leaseMs: number) => Promise<DeliveryClaim | null>;
	/**
	 * Say "still here", or learn that the lease is gone.
	 *
	 * `false` means a recovery re-took this delivery and the caller no longer owns it. Without this a
	 * claim got ONE fixed window and no way to extend it, so a turn that legitimately outran the lease
	 * — a long tool chain, a slow model — was indistinguishable from a dead one and was reclaimed
	 * while it was still running.
	 */
	heartbeat: (
		key: DeliveryKey,
		leaseId: string,
		leaseMs: number,
	) => Promise<boolean>;
	/**
	 * Mark it handled, and say whether this attempt was still the one entitled to.
	 *
	 * `false` ⇒ the lease was re-taken and the row now belongs to somebody else; this attempt's work
	 * is discarded rather than written over theirs. The row is RETAINED either way — it is the memory
	 * that keeps a later retry from looking new, so removing it would reopen the hole it closed.
	 */
	complete: (key: DeliveryKey, leaseId: string) => Promise<boolean>;
};

export type DeliveryKey = {
	provider: string;
	endpointKey: string;
	deliveryId: string;
};

export type DeliveryInboxOptions = { now?: () => string };

/** A fresh lease id — the same 16 random bytes the approval lease mints, for the same purpose. */
const newLeaseId = (): string => bytesToHex(randomBytes(16));

/**
 * The where-clause that pins the lease a recovery READ, so two recoveries cannot both take the row.
 *
 * Prefers the lease id and falls back to the expiry only when the row predates that column — a
 * delivery claimed before the fence existed carries no lease to pin, and refusing to recover those
 * would strand every claim already sitting in a deployment's database at upgrade time.
 */
function leaseFence(
	leaseId: string | null | undefined,
	leaseExpiresAt: string | null | undefined,
): { field: "leaseId" | "leaseExpiresAt"; value: string; connector: "AND" }[] {
	if (leaseId != null) {
		return [{ field: "leaseId", value: leaseId, connector: "AND" }];
	}
	if (leaseExpiresAt != null) {
		return [
			{ field: "leaseExpiresAt", value: leaseExpiresAt, connector: "AND" },
		];
	}
	return [];
}

/** Back the inbox with a storage adapter. */
export function createDeliveryInbox(
	adapter: Adapter,
	options: DeliveryInboxOptions = {},
): DeliveryInbox {
	const now = options.now ?? (() => new Date().toISOString());
	const db = entityView(adapter, {
		channel_delivery: { fields: channelDeliveryFields },
	});
	const leaseUntil = (leaseMs: number) =>
		new Date(Date.parse(now()) + leaseMs).toISOString();

	return {
		async claim(key, leaseMs) {
			const id = deliveryRowId(key);
			const stamp = now();
			const leaseId = newLeaseId();
			try {
				// The INSERT is the claim. Two processes racing the same delivery both try it and the
				// database picks one — no read-then-write window for both to pass through.
				await db.create({
					model: "channel_delivery",
					data: {
						...key,
						id,
						status: "processing",
						leaseId,
						leaseExpiresAt: leaseUntil(leaseMs),
						createdAt: stamp,
						updatedAt: stamp,
					},
				});
				return { leaseId };
			} catch (error) {
				// ONLY a duplicate means somebody has it. Every other failure means this claim was never
				// recorded, and answering "somebody else has it" would hand the delivery to a holder that
				// does not exist.
				if (!isConflict(error)) throw error;
				// Somebody has it. Completed ⇒ never again. Processing under a live lease ⇒ not now.
				// Processing under a LAPSED one ⇒ the holder died, and this retry may take over.
				const existing = await db.findOne({
					model: "channel_delivery",
					where: [{ field: "id", value: id }],
				});
				if (!existing || existing.status === "completed") return null;
				if (
					existing.leaseExpiresAt != null &&
					existing.leaseExpiresAt >= now()
				) {
					return null;
				}
				// The where pins the lease we READ, so two recoveries cannot both take it — and the row
				// leaves this call carrying a NEW lease id, which is what makes the displaced holder's
				// later `complete` match nothing.
				const taken = await db.update({
					model: "channel_delivery",
					where: [
						{ field: "id", value: id },
						{ field: "status", value: "processing", connector: "AND" },
						...leaseFence(existing.leaseId, existing.leaseExpiresAt),
					],
					update: {
						leaseId,
						leaseExpiresAt: leaseUntil(leaseMs),
						updatedAt: now(),
					},
				});
				return taken === null ? null : { leaseId };
			}
		},

		async heartbeat(key, leaseId, leaseMs) {
			// Same ownership question `complete` asks, asked early and often: a row that is no longer
			// ours matches nothing, and the caller learns it has been displaced instead of running on
			// to write over its successor.
			const extended = await db.update({
				model: "channel_delivery",
				where: [
					{ field: "id", value: deliveryRowId(key) },
					{ field: "status", value: "processing", connector: "AND" },
					{ field: "leaseId", value: leaseId, connector: "AND" },
				],
				update: { leaseExpiresAt: leaseUntil(leaseMs), updatedAt: now() },
			});
			return extended !== null;
		},

		async complete(key, leaseId) {
			// FENCED. Without the lease in this where, a runner whose lease had lapsed and been re-taken
			// still marked the delivery completed — over the top of the successor that was running it,
			// whose own work then finished against a row it no longer appeared to own.
			const finished = await db.update({
				model: "channel_delivery",
				where: [
					{ field: "id", value: deliveryRowId(key) },
					{ field: "leaseId", value: leaseId, connector: "AND" },
				],
				update: { status: "completed", updatedAt: now() },
			});
			return finished !== null;
		},
	};
}

// ── the outbox ───────────────────────────────────────────────────────────────────────────────────
//
// De-duplicating the inbound half creates a new way to lose a reply. The turn runs, the process dies
// before `channel.send`, and the delivery is already claimed — so the provider's retry correctly
// declines to run it again, and the answer the model produced is simply gone. At-most-once inbound and
// at-least-once outbound cannot both hold without somewhere to put the reply between them.
//
// So the reply is written BEFORE it is sent, and marked only after. A crash anywhere in between leaves
// a `pending` row that `drainOutbox` re-sends. That means a duplicate send is possible — the send
// succeeded and the mark did not — which is the right side to fail on: a repeated message is visible
// and recoverable, a lost one is neither.

export const channelOutboxStatusValues = ["pending", "sent"] as const;
export type ChannelOutboxStatus = (typeof channelOutboxStatusValues)[number];

export const channelOutboxFields = {
	/** hash(provider, endpointKey, deliveryId) — one reply per delivery, so a re-run of the same
	 *  delivery cannot enqueue a second. */
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	provider: field.string({ required: true, index: true, immutable: true }),
	endpointKey: field.string({ required: true, index: true, immutable: true }),
	deliveryId: field.string({ required: true, immutable: true }),
	status: field.enum(channelOutboxStatusValues, {
		required: true,
		index: true,
	}),
	externalConversationId: field.string({ required: true, immutable: true }),
	/** The reply text. Already redacted — it is the runtime's own output, tokenized on the way out. */
	text: field.string({ required: true, pii: "redacted", immutable: true }),
	/** The provider's opaque threading token, round-tripped to `send` verbatim. */
	replyContext: field.jsonValue({ pii: "possible" }),
	/** How many times a send has been attempted. A row that keeps failing is visible rather than
	 *  silently retried forever. */
	attempts: field.number({ required: true }),
	lastError: field.string({ pii: "redacted" }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const channelOutboxEntity = entity(
	"channel_outbox",
	channelOutboxFields,
);

/** The models the outbox contributes via `plugin.schema`. */
export const channelOutboxModels: Record<
	string,
	{ fields: Record<string, EntityField> }
> = {
	[channelOutboxEntity.name]: { fields: channelOutboxEntity.fields },
};

export type OutboundRecord = {
	externalConversationId: string;
	text: string;
	replyContext?: JsonValue;
};

export type DeliveryOutbox = {
	/** Record a reply as pending BEFORE it is sent. Returns false when this delivery already has one —
	 *  a re-run cannot enqueue a second. */
	enqueue: (key: DeliveryKey, reply: OutboundRecord) => Promise<boolean>;
	/** Mark it delivered. */
	markSent: (key: DeliveryKey) => Promise<void>;
	/** Record a failed attempt, leaving it pending for the next drain. */
	markFailed: (key: DeliveryKey, error: string) => Promise<void>;
	/** Every reply still owed, oldest first. */
	pending: (
		limit?: number,
	) => Promise<(OutboundRecord & DeliveryKey & { attempts: number })[]>;
};

/** Back the outbox with a storage adapter. */
export function createDeliveryOutbox(
	adapter: Adapter,
	options: DeliveryInboxOptions = {},
): DeliveryOutbox {
	const now = options.now ?? (() => new Date().toISOString());
	const db = entityView(adapter, {
		channel_outbox: { fields: channelOutboxFields },
	});
	const rowWhere = (key: DeliveryKey) => [
		{ field: "id" as const, value: deliveryRowId(key) },
	];

	return {
		async enqueue(key, reply) {
			const stamp = now();
			try {
				await db.create({
					model: "channel_outbox",
					data: {
						...key,
						id: deliveryRowId(key),
						status: "pending",
						externalConversationId: reply.externalConversationId,
						text: reply.text,
						...(reply.replyContext !== undefined
							? { replyContext: reply.replyContext }
							: {}),
						attempts: 0,
						createdAt: stamp,
						updatedAt: stamp,
					},
				});
				return true;
			} catch (error) {
				// A storage failure is NOT a duplicate. Reporting it as one told the caller "this delivery
				// already owes a reply", so the caller skipped recording the answer it was holding and the
				// reply was lost with nothing left to recover it from.
				if (!isConflict(error)) throw error;
				// One reply per delivery — the same key already owes or has sent one.
				return false;
			}
		},

		async markSent(key) {
			await db.update({
				model: "channel_outbox",
				where: rowWhere(key),
				update: { status: "sent", updatedAt: now() },
			});
		},

		async markFailed(key, error) {
			const existing = await db.findOne({
				model: "channel_outbox",
				where: rowWhere(key),
			});
			await db.update({
				model: "channel_outbox",
				where: rowWhere(key),
				update: {
					attempts: (existing?.attempts ?? 0) + 1,
					lastError: error,
					updatedAt: now(),
				},
			});
		},

		async pending(limit) {
			const rows = await db.findMany({
				model: "channel_outbox",
				where: [{ field: "status", value: "pending" }],
				sortBy: { field: "createdAt", direction: "asc" },
				...(limit !== undefined ? { limit } : {}),
			});
			return rows.map((row) => ({
				provider: row.provider,
				endpointKey: row.endpointKey,
				deliveryId: row.deliveryId,
				externalConversationId: row.externalConversationId,
				text: row.text,
				...(row.replyContext !== undefined
					? { replyContext: row.replyContext }
					: {}),
				attempts: row.attempts,
			}));
		},
	};
}
