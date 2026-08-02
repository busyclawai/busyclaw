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

import type { Adapter, JsonObject, JsonValue } from "@busyclaw/contracts";
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

// The lifecycle of one inbound delivery, as a state machine rather than a marker.
//
// `pending` is the state that did not exist, and its absence is what lost messages. The row was
// created ALREADY `processing`, by the request that was also running the turn — so the row recorded
// that somebody was working, never that there was work TO DO. When that somebody died, nothing was
// left describing the message: the payload had never been stored, the provider had been answered 200,
// and the lease simply lapsed with no one to hand it to.
//
// Admitted work now lands `pending` and is claimed separately. The two questions are different — "is
// this delivery known?" (dedupe) and "is somebody running it right now?" (the lease) — and collapsing
// them into one insert is what made an unclaimed message unrepresentable.
export const channelDeliveryStatusValues = [
	"pending",
	"processing",
	"completed",
	"dead",
] as const;
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
		doc: "`pending` is admitted work nobody is running; `processing` is a live attempt under a lease; `completed` is answered and never re-run; `dead` has failed past its attempt cap and waits for a human. A `processing` row whose lease has lapsed is a turn that died mid-flight and is re-claimable.",
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
	/**
	 * The normalized message itself — the reason this row is a work item and not a receipt.
	 *
	 * The claim used to store WHO was handling the delivery and nothing about WHAT it was. So a turn
	 * that died took the only copy with it: the provider had already been answered 200 and would not
	 * send it again, and no worker could recover something it had never been told. Persisting this
	 * before acknowledging is what makes the 200 honest.
	 *
	 * TOKENIZED, not raw. It is written through the plugin's `redact` door into the CLAW's container —
	 * the same container the transcript uses — so the worker's `sendMessage` rehydrates it at the model
	 * boundary exactly as a resumed run does, and durable state never holds the original. A deployment
	 * with no detector configured gets the identity function and stores what it always would have.
	 */
	payload: field.jsonObject({
		pii: "redacted",
		immutable: true,
		doc: "The normalized inbound message, tokenized into the claw's container. Immutable: what was admitted is what runs.",
	}),
	/** WHERE the work lands, resolved at ingress. Binding is a cheap, deterministic lookup-or-create, so
	 *  it happens on the acknowledged path and the worker inherits a fully-resolved unit of work rather
	 *  than re-deriving one from an endpoint that may since have been revoked. */
	clawId: field.string({ index: true, immutable: true }),
	threadId: field.string({ immutable: true }),
	/** How many attempts this delivery has cost. A row that keeps failing becomes visible and eventually
	 *  terminal, instead of being retried forever by every drain that passes. */
	attempts: field.number({ required: true }),
	/** When this work becomes eligible again — the backoff. Absent ⇒ eligible now. Indexed because it is
	 *  half of the worker's due-query, and a queue whose due-query cannot use an index is a queue that
	 *  gets slower exactly as it gets busier. */
	nextAttemptAt: field.string({ index: true }),
	/** Why the last attempt failed. Redacted: a provider error can quote the message that caused it. */
	lastError: field.string({ pii: "redacted" }),
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
export type DeliveryClaim = { leaseId: string; work: DeliveryWork };

/** One unit of admitted work: the message, and where it was already resolved to land. */
export type DeliveryWork = {
	/** The normalized message as stored — tokenized, and rehydrated by the runtime at the model
	 *  boundary, so a worker passes it straight to `sendMessage` without re-identifying anything. */
	payload: JsonObject;
	clawId: string;
	threadId: string;
	/** How many attempts have already been spent on it, this one included. */
	attempts: number;
};

/** A delivery the worker found waiting — the claim, plus which endpoint it belongs to. */
export type ClaimedDelivery = DeliveryClaim & { key: DeliveryKey };

/** What a dispatch asks of the inbox. Absent entirely when the claw has no database — the same
 *  deployment shape that has no registration rows either. */
export type DeliveryInbox = {
	/**
	 * Record this delivery as work TO DO, before anyone is told it was received.
	 *
	 * `true` ⇒ newly admitted and yours to attempt. `false` ⇒ already known, so this is a retry of
	 * something already admitted and the row (not this request) owns finishing it.
	 *
	 * This is the write that makes a 200 honest. The row used to be created already `processing` by the
	 * same request that ran the turn, carrying no payload — so a crash mid-turn left a lease over a
	 * message nobody had stored, the provider stopped retrying, and there was nothing to recover from.
	 */
	admit: (
		key: DeliveryKey,
		work: Omit<DeliveryWork, "attempts">,
	) => Promise<boolean>;
	/**
	 * Has this delivery already been admitted?
	 *
	 * A cheap primary-key read used ONLY to skip work, never to decide it: `admit`'s insert still
	 * arbitrates, so a row appearing between this read and that write loses there rather than here.
	 *
	 * It exists because admission has to resolve where the message lands BEFORE it can store it, and
	 * that resolution is a governed api call that creates rows. Without this read, a webhook reachable
	 * by strangers by design ran a full bind and authz decision for every retry of a delivery it had
	 * already finished — which is a cheap amplification for anyone willing to POST the same body twice.
	 */
	known: (key: DeliveryKey) => Promise<boolean>;
	/**
	 * Take this delivery, or report that somebody already has.
	 *
	 * A claim ⇒ it is yours to process, and the `leaseId` is the proof to present at every later step.
	 * `null` ⇒ it is completed, dead, not yet due under its backoff, or being processed right now under
	 * a live lease. A `processing` row whose lease has LAPSED is re-takeable: that is a turn which died
	 * mid-flight, and re-claiming it is the only thing that can recover it.
	 */
	claim: (key: DeliveryKey, leaseMs: number) => Promise<DeliveryClaim | null>;
	/**
	 * Take whatever work is due — the worker's entry point.
	 *
	 * `pending` rows past their backoff, and `processing` rows whose lease has lapsed, oldest first.
	 * This is what makes the queue recoverable rather than merely durable: without it a row admitted by
	 * a request that then died would sit `pending` forever, correctly stored and never run.
	 */
	claimDue: (input: {
		leaseMs: number;
		limit?: number;
	}) => Promise<ClaimedDelivery[]>;
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
	/**
	 * Record a failed attempt and hand the row back to the queue — or bury it.
	 *
	 * Returns the state it landed in. Past `maxAttempts` the row goes `dead` rather than `pending`: a
	 * message that fails every time is a message that will fail again, and retrying it forever spends
	 * a model call per drain on work that cannot succeed while burying the fact that it never did.
	 * Fenced like the rest — a displaced attempt cannot record a failure against its successor.
	 */
	fail: (input: {
		key: DeliveryKey;
		leaseId: string;
		error: string;
		backoffMs: number;
		maxAttempts: number;
	}) => Promise<"pending" | "dead" | "lost">;
};

export type DeliveryKey = {
	provider: string;
	endpointKey: string;
	deliveryId: string;
};

export type DeliveryInboxOptions = { now?: () => string };

/** How long the writer of a reply holds it before a drain may take over — long enough to cover the
 *  send it is about to make, short enough that a crash mid-send is recoverable within a drain or two. */
const DEFAULT_OUTBOX_LEASE_MS = 60 * 1000;

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
		async admit(key, work) {
			const stamp = now();
			try {
				// The INSERT is the admission. Two arrivals of the same delivery both try it and the
				// database picks one — no read-then-write window for both to pass through. The row lands
				// `pending`: known, stored, and nobody's yet.
				await db.create({
					model: "channel_delivery",
					data: {
						...key,
						id: deliveryRowId(key),
						status: "pending",
						payload: work.payload,
						clawId: work.clawId,
						threadId: work.threadId,
						attempts: 0,
						createdAt: stamp,
						updatedAt: stamp,
					},
				});
				return true;
			} catch (error) {
				// ONLY a duplicate means it is already known. Every other failure means nothing was
				// stored, and reporting "already admitted" would acknowledge a message to the provider
				// that no row describes.
				if (!isConflict(error)) throw error;
				return false;
			}
		},

		async known(key) {
			const row = await db.findOne({
				model: "channel_delivery",
				where: [{ field: "id", value: deliveryRowId(key) }],
			});
			return row !== null;
		},

		async claim(key, leaseMs) {
			const existing = await db.findOne({
				model: "channel_delivery",
				where: [{ field: "id", value: deliveryRowId(key) }],
			});
			return existing === null ? null : takeRow(existing, leaseMs);
		},

		async claimDue({ leaseMs, limit }) {
			// Two shapes are due, and they are due for opposite reasons: work nobody has started
			// (`pending`, past its backoff) and work somebody started and abandoned (`processing` under a
			// lapsed lease). A queue that reads only the first never recovers a crash; one that reads only
			// the second never starts anything.
			const candidates = await db.findMany({
				model: "channel_delivery",
				where: [
					{
						field: "status",
						operator: "in",
						value: ["pending", "processing"],
					},
				],
				sortBy: { field: "createdAt", direction: "asc" },
				// Read wider than the limit: a candidate may be a live lease or still backing off, and
				// those are filtered below rather than by the query.
				...(limit !== undefined ? { limit: limit * 4 } : {}),
			});
			const taken: ClaimedDelivery[] = [];
			for (const row of candidates) {
				if (limit !== undefined && taken.length >= limit) break;
				const claim = await takeRow(row, leaseMs);
				// Lost the race, still leased, or not yet due — somebody else's problem, or not yet
				// anybody's. Either way this worker moves on rather than waiting on it.
				if (claim === null) continue;
				taken.push({
					...claim,
					key: {
						provider: row.provider,
						endpointKey: row.endpointKey,
						deliveryId: row.deliveryId,
					},
				});
			}
			return taken;
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

		async fail({ key, leaseId, error, backoffMs, maxAttempts }) {
			const id = deliveryRowId(key);
			const held = await db.findOne({
				model: "channel_delivery",
				where: [
					{ field: "id", value: id },
					{ field: "leaseId", value: leaseId, connector: "AND" },
				],
			});
			// Displaced mid-turn: the successor owns the row, and this attempt's failure is not a fact
			// about their attempt. Recording it would spend one of THEIR retries on OUR error.
			if (held === null) return "lost";
			const attempts = held.attempts + 1;
			const buried = attempts >= maxAttempts;
			const landed = await db.update({
				model: "channel_delivery",
				where: [
					{ field: "id", value: id },
					{ field: "leaseId", value: leaseId, connector: "AND" },
				],
				update: {
					status: buried ? "dead" : "pending",
					attempts,
					lastError: error,
					// Cleared so the row reads as unheld — a `pending` row carrying a live lease would be
					// skipped by the very query meant to pick it up again.
					leaseExpiresAt: null,
					nextAttemptAt: buried
						? null
						: new Date(Date.parse(now()) + backoffMs).toISOString(),
					updatedAt: now(),
				},
			});
			// It was ours a moment ago and is not now — treat that as displacement, not as a failure
			// recorded, so a caller never reports a retry it did not actually schedule.
			if (landed === null) return "lost";
			return buried ? "dead" : "pending";
		},
	};

	/**
	 * Move one row into `processing` under a fresh lease, or decline it.
	 *
	 * Shared by the by-key claim and the worker's due-sweep so both decide eligibility the same way.
	 * The update's where pins what the read saw, so two takers racing the same row cannot both
	 * transition: the loser matches nothing and gets the same answer a live lease would have given it.
	 */
	async function takeRow(
		row: {
			id: string;
			status: string;
			leaseId?: string | null;
			leaseExpiresAt?: string | null;
			nextAttemptAt?: string | null;
			payload?: JsonObject | null;
			clawId?: string | null;
			threadId?: string | null;
			attempts: number;
		},
		leaseMs: number,
	): Promise<DeliveryClaim | null> {
		// Answered, or buried. Neither is work.
		if (row.status === "completed" || row.status === "dead") return null;
		if (row.status === "processing") {
			// Somebody is running it. Only a LAPSED lease may be re-taken, and that is the whole
			// recovery story: an attempt that died between claiming and finishing left a lease nobody
			// will ever clear.
			if (row.leaseExpiresAt == null || row.leaseExpiresAt >= now())
				return null;
		} else if (row.nextAttemptAt != null && row.nextAttemptAt > now()) {
			// Backing off. Due later, not now — and a worker that ignored this would spend every drain
			// re-running the attempt that just failed.
			return null;
		}
		// A row admitted before the payload column existed cannot be run from storage: there is nothing
		// to run. Left alone rather than claimed and failed, so an upgrade does not bury history.
		if (row.payload == null || row.clawId == null || row.threadId == null) {
			return null;
		}
		const leaseId = newLeaseId();
		const taken = await db.update({
			model: "channel_delivery",
			where: [
				{ field: "id", value: row.id },
				{ field: "status", value: row.status, connector: "AND" },
				...(row.status === "processing"
					? leaseFence(row.leaseId, row.leaseExpiresAt)
					: []),
			],
			update: {
				status: "processing",
				leaseId,
				leaseExpiresAt: leaseUntil(leaseMs),
				updatedAt: now(),
			},
		});
		if (taken === null) return null;
		return {
			leaseId,
			work: {
				payload: row.payload,
				clawId: row.clawId,
				threadId: row.threadId,
				attempts: row.attempts,
			},
		};
	}
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

export const channelOutboxStatusValues = ["pending", "sent", "dead"] as const;
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
		doc: "`pending` is owed, `sent` is delivered, `dead` has failed past its cap. A `pending` row under a live lease is being sent right now; under a lapsed one, by somebody who died mid-send.",
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
	/**
	 * WHICH attempt is sending this reply — the same fence the inbound side carries, for a sharper
	 * reason: the drain had none at all, so two drains both read the row as pending and both sent it.
	 * The queue that existed to make a lost reply impossible produced duplicate ones instead.
	 */
	leaseId: field.string({
		doc: "Identifies the attempt sending this reply. Only the current lease may mark it sent or failed, so two drains cannot both deliver it.",
	}),
	leaseExpiresAt: field.string({ index: true }),
	/** When a failed send becomes eligible again. Absent ⇒ now. Without it every drain re-sent every
	 *  failing row immediately, so a provider outage turned into a tight retry loop against it. */
	nextAttemptAt: field.string({ index: true }),
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

/** A reply the drain took responsibility for, with the proof it holds it. */
export type ClaimedReply = OutboundRecord &
	DeliveryKey & { leaseId: string; attempts: number };

export type DeliveryOutbox = {
	/**
	 * Record a reply as pending BEFORE it is sent, and TAKE it in the same step.
	 *
	 * A claim ⇒ newly recorded and yours to send. `null` ⇒ this delivery already has a reply, so a
	 * re-run cannot enqueue a second and must not send one either.
	 *
	 * The claim comes back with the row because the writer is always its first sender. Without it there
	 * was a window where a concurrent drain could pick up the row this call had just written and send it
	 * too — the queue built to stop a reply being lost producing a duplicate instead.
	 */
	enqueue: (
		key: DeliveryKey,
		reply: OutboundRecord,
	) => Promise<{ leaseId: string } | null>;
	/** Take whatever replies are owed and due — the drain's entry point. Fenced, so two drains running
	 *  at once divide the work rather than duplicating it. */
	claimPending: (input: {
		leaseMs: number;
		limit?: number;
	}) => Promise<ClaimedReply[]>;
	/** Mark it delivered. `false` ⇒ the lease was re-taken; this attempt does not get to say it sent. */
	markSent: (key: DeliveryKey, leaseId: string) => Promise<boolean>;
	/**
	 * Record a failed send, back it off, and bury it past the cap.
	 *
	 * A reply that cannot be delivered — a deleted chat, a revoked bot — used to be retried by every
	 * drain forever. Now it becomes `dead`: still on the record, no longer costing an api call a minute.
	 */
	markFailed: (input: {
		key: DeliveryKey;
		leaseId: string;
		error: string;
		backoffMs: number;
		maxAttempts: number;
	}) => Promise<"pending" | "dead" | "lost">;
	/** Every reply still owed, oldest first — a READ, for tests and operators. The drain uses
	 *  `claimPending`; reading this and acting on it is the race the lease exists to close. */
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
	const leaseUntil = (leaseMs: number) =>
		new Date(Date.parse(now()) + leaseMs).toISOString();
	const rowWhere = (key: DeliveryKey, leaseId: string) => [
		{ field: "id" as const, value: deliveryRowId(key) },
		{ field: "leaseId" as const, value: leaseId, connector: "AND" as const },
	];

	return {
		async enqueue(key, reply) {
			const stamp = now();
			const leaseId = newLeaseId();
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
						// Written HELD. The writer is always this reply's first sender, and a row that
						// existed unheld — even briefly — is a row a concurrent drain could pick up and
						// send alongside the caller about to send it.
						leaseId,
						leaseExpiresAt: leaseUntil(DEFAULT_OUTBOX_LEASE_MS),
						createdAt: stamp,
						updatedAt: stamp,
					},
				});
				return { leaseId };
			} catch (error) {
				// A storage failure is NOT a duplicate. Reporting it as one told the caller "this delivery
				// already owes a reply", so the caller skipped recording the answer it was holding and the
				// reply was lost with nothing left to recover it from.
				if (!isConflict(error)) throw error;
				// One reply per delivery — the same key already owes or has sent one.
				return null;
			}
		},

		async claimPending({ leaseMs, limit }) {
			const candidates = await db.findMany({
				model: "channel_outbox",
				where: [{ field: "status", value: "pending" }],
				sortBy: { field: "createdAt", direction: "asc" },
				// Read wider than the limit: a candidate may be held or still backing off, and those are
				// filtered below rather than by the query.
				...(limit !== undefined ? { limit: limit * 4 } : {}),
			});
			const taken: ClaimedReply[] = [];
			for (const row of candidates) {
				if (limit !== undefined && taken.length >= limit) break;
				// Somebody is sending it right now, or it is not due yet. Neither is this drain's work.
				if (row.leaseExpiresAt != null && row.leaseExpiresAt >= now()) continue;
				if (row.nextAttemptAt != null && row.nextAttemptAt > now()) continue;
				const leaseId = newLeaseId();
				// The where pins what the read saw, so two drains racing the same row cannot both take it:
				// the loser matches nothing and moves on to the next.
				const held = await db.update({
					model: "channel_outbox",
					where: [
						{ field: "id", value: row.id },
						{ field: "status", value: "pending", connector: "AND" },
						...leaseFence(row.leaseId, row.leaseExpiresAt),
					],
					update: {
						leaseId,
						leaseExpiresAt: leaseUntil(leaseMs),
						updatedAt: now(),
					},
				});
				if (held === null) continue;
				taken.push({
					provider: row.provider,
					endpointKey: row.endpointKey,
					deliveryId: row.deliveryId,
					externalConversationId: row.externalConversationId,
					text: row.text,
					...(row.replyContext !== undefined
						? { replyContext: row.replyContext }
						: {}),
					attempts: row.attempts,
					leaseId,
				});
			}
			return taken;
		},

		async markSent(key, leaseId) {
			const marked = await db.update({
				model: "channel_outbox",
				where: rowWhere(key, leaseId),
				update: {
					status: "sent",
					leaseExpiresAt: null,
					nextAttemptAt: null,
					updatedAt: now(),
				},
			});
			return marked !== null;
		},

		async markFailed({ key, leaseId, error, backoffMs, maxAttempts }) {
			const held = await db.findOne({
				model: "channel_outbox",
				where: rowWhere(key, leaseId),
			});
			// Displaced: the row is somebody else's send now, and this failure is not a fact about it.
			// Recording it would spend one of THEIR retries on OUR error — the same read-then-increment
			// race the counter had when two drains could both read `attempts` and both write the same +1.
			if (held === null) return "lost";
			const attempts = held.attempts + 1;
			const buried = attempts >= maxAttempts;
			const landed = await db.update({
				model: "channel_outbox",
				where: rowWhere(key, leaseId),
				update: {
					status: buried ? "dead" : "pending",
					attempts,
					lastError: error,
					// Released, so the next drain can see it as owed rather than as somebody's live send.
					leaseExpiresAt: null,
					nextAttemptAt: buried
						? null
						: new Date(Date.parse(now()) + backoffMs).toISOString(),
					updatedAt: now(),
				},
			});
			if (landed === null) return "lost";
			return buried ? "dead" : "pending";
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
