// THE RUN STREAM OVER REDIS STREAMS — the implementation that fills in `watch`.
//
// A Redis stream is what this port was shaped like all along: `XADD` appends, entry ids are ordered
// cursors, and `XREAD` is exclusive-from-a-cursor by definition. So the awkward parts of the KV
// implementation — an offset counter that can expire under its own readers, holes between an
// `increment` and its `set` — simply do not exist here. And `XREAD BLOCK` is a real subscription,
// which is the one capability `SecondaryStorage` cannot express and the reason a host would reach
// for Redis at all.
//
// NO REDIS CLIENT DEPENDENCY, on purpose — so hand it the client you already have:
//
//   import Redis from "ioredis";
//   const redis = new Redis(process.env.REDIS_URL);
//
//   createClaw({
//     runStream: redisStream({
//       client: redis,
//       blocking: redis.duplicate(),   // required for PUSH; see `blocking`
//     }),
//   });
//
// node-redis, Upstash and anything else with `call` or `sendCommand` work the same way. This package
// does not depend on any of them: it duck-types the one method it needs, which keeps it from having
// to version against three ecosystems and means a client nobody here has heard of still works. If
// yours is stranger than that, pass a function instead of an object — `client` accepts either.

import type {
	RunStreamChunk,
	RunStreamPage,
	RunStreamPort,
} from "@busyclaw/contracts";
import { configurationError } from "@busyclaw/contracts";

/** Send one Redis command and return its raw reply. Arrays and bulk strings come back as this
 *  client's own representation; the parsing below accepts strings, Buffers and nested arrays. */
export type RedisCommand = (args: readonly string[]) => Promise<unknown>;

/**
 * Any Redis client, structurally: ioredis exposes `call(command, ...args)`, node-redis and Upstash
 * expose `sendCommand(args)`. Typed with `never[]` parameters deliberately — this is somebody else's
 * client and its real signatures involve branded argument arrays and Buffer unions that would not
 * match a hand-written shape. Pinning it loosely here means ONE cast, inside this file, instead of
 * every caller writing their own at the boundary.
 */
export type RedisLike = {
	call?: (...args: never[]) => unknown;
	sendCommand?: (...args: never[]) => unknown;
};

/** Reduce whatever the host handed over to the single operation this port needs. */
function resolveSender(source: RedisLike | RedisCommand): RedisCommand {
	if (typeof source === "function") return source;
	if (typeof source.call === "function") {
		const call = source.call.bind(source) as (
			...args: string[]
		) => Promise<unknown>;
		return (args) => call(...args);
	}
	if (typeof source.sendCommand === "function") {
		const sendCommand = source.sendCommand.bind(source) as (
			args: string[],
		) => Promise<unknown>;
		return (args) => sendCommand([...args]);
	}
	// LOUD, at assembly. A client this cannot drive would otherwise fail on the first delta — which
	// is to say inside an advisory write that swallows its own errors, so the symptom would be a
	// watcher that silently sees nothing rather than a deployment that refuses to start.
	throw configurationError(
		"this redis client has neither `call` nor `sendCommand`",
		{
			reason:
				"pass an ioredis/node-redis client, or a function taking a string[] command and returning its reply",
		},
	);
}

/** The field XADD stores the chunk under. One field, one JSON document: the chunk is read whole or
 *  not at all, so splitting it across fields would buy nothing and cost a schema. */
const FIELD = "c";

/** Where a reader starts when it has no cursor. `0` means "everything after id 0", which is every
 *  entry — XREAD is exclusive, so this is the from-the-beginning cursor rather than a sentinel. */
const FROM_START = "0";

export type RedisStreamOptions = {
	/** Your Redis client — ioredis, node-redis, Upstash, anything with `call` or `sendCommand`. A
	 *  function taking a `string[]` command works too, for a client shaped like none of those. */
	client: RedisLike | RedisCommand;
	/**
	 * A SECOND client, for blocking reads. Present ⇒ this port exposes `watch` and subscribers get
	 * PUSH; absent ⇒ no `watch`, and `watchThread` falls back to polling.
	 *
	 * SEPARATE BY NECESSITY, not by preference. `XREAD BLOCK` holds the connection until something
	 * arrives, so issuing it on the connection the rest of the app shares would stall every other
	 * command behind it — a stall that looks like the database being slow and has nothing to do with
	 * the database. Requiring a distinct client makes `redis.duplicate()` a decision the host takes
	 * on purpose rather than a production incident it discovers.
	 */
	blocking?: RedisLike | RedisCommand;
	/** How long a stream key lives after its last write, in seconds. Refreshed on every append —
	 *  unlike the KV counter, whose window has to be born-once, there is nothing here that restarts
	 *  numbering, so keeping a live conversation's log alive is safe. */
	ttlSeconds?: number;
	/** Approximate cap on entries per stream, enforced by `XADD MAXLEN ~`. A ceiling on one runaway
	 *  answer, not a retention policy — the ttl is what bounds the ordinary case. */
	maxLen?: number;
	/** Entries per `read`. A late joiner pages through a long answer rather than blocking on all of
	 *  it. */
	maxChunksPerRead?: number;
	/** How long one `XREAD BLOCK` waits before returning empty and being reissued. Not a latency
	 *  knob — delivery is immediate either way — but a bound on how long a cancelled watcher's
	 *  connection stays parked in Redis after it stops reading. */
	blockMs?: number;
};

const DEFAULTS = {
	ttlSeconds: 3600,
	maxLen: 10_000,
	maxChunksPerRead: 64,
	blockMs: 15_000,
} as const;

/**
 * Redis replies arrive as bulk strings. Both mainstream clients hand those back as JS strings by
 * default; a client in buffer mode hands back a Node `Buffer`, whose own `toString` decodes utf8.
 *
 * No `TextDecoder`: this package compiles against ES2023 with no DOM or Node lib, which is what
 * keeps it importable from anywhere. A bare `Uint8Array` — as opposed to a Buffer — would stringify
 * to comma-joined bytes, so it is not accepted rather than silently mangled; no Redis client
 * produces one.
 */
function asText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (ArrayBuffer.isView(value)) {
		const text = String(value);
		return /^[\d,]*$/.test(text) && text !== "" ? undefined : text;
	}
	return undefined;
}

/**
 * Pull `{cursor, chunks}` out of an XREAD reply.
 *
 * The shape is `[[streamKey, [[id, [field, value, …]], …]], …]`, and null when nothing matched. A
 * malformed or unreadable entry is SKIPPED rather than thrown on — a buffer is not a record, and one
 * bad entry must not take down the live view of everything else.
 */
function parseXRead(reply: unknown): {
	chunks: RunStreamChunk[];
	last?: string;
} {
	const chunks: RunStreamChunk[] = [];
	let last: string | undefined;
	if (!Array.isArray(reply)) return { chunks };
	for (const stream of reply) {
		// RESP3 clients may hand back `{ name, messages }` instead of a two-element array.
		const entries = Array.isArray(stream)
			? stream[1]
			: (stream as { messages?: unknown } | null)?.messages;
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			const id = Array.isArray(entry)
				? asText(entry[0])
				: asText((entry as { id?: unknown } | null)?.id);
			if (id === undefined) continue;
			last = id;
			const fields = Array.isArray(entry) ? entry[1] : undefined;
			if (!Array.isArray(fields)) continue;
			// [field, value, field, value, …] — find ours rather than assuming position, so an entry
			// written by a future version with extra fields still reads.
			for (let i = 0; i + 1 < fields.length; i += 2) {
				if (asText(fields[i]) !== FIELD) continue;
				const raw = asText(fields[i + 1]);
				if (raw === undefined) continue;
				try {
					const parsed: unknown = JSON.parse(raw);
					if (parsed && typeof parsed === "object" && "kind" in parsed) {
						chunks.push(parsed as RunStreamChunk);
					}
				} catch {
					// Unreadable entry: skipped, and the cursor still advances past it.
				}
			}
		}
	}
	return { chunks, ...(last !== undefined ? { last } : {}) };
}

/**
 * A `RunStreamPort` over Redis Streams.
 *
 * The cursor is the Redis entry id (`<ms>-<seq>`), handed to clients verbatim and returned verbatim
 * — which is exactly what `Last-Event-ID` needs and why nothing here has to invent a numbering
 * scheme of its own.
 */
export function redisStream(options: RedisStreamOptions): RunStreamPort {
	const send = resolveSender(options.client);
	const ttl = options.ttlSeconds ?? DEFAULTS.ttlSeconds;
	const maxLen = options.maxLen ?? DEFAULTS.maxLen;
	const count = options.maxChunksPerRead ?? DEFAULTS.maxChunksPerRead;
	const blockMs = options.blockMs ?? DEFAULTS.blockMs;

	/**
	 * Has this stream been TRIMMED OUT from under a reader's cursor?
	 *
	 * The stale case here is not the KV's expiring counter — it is the key having gone entirely (the
	 * ttl lapsed while the client was away, or `MAXLEN` dropped everything it had). A missing key
	 * plus a cursor that is not the from-the-start one means the offsets a client holds no longer
	 * refer to anything, so it must reload rather than be served whatever appears next.
	 *
	 * Asked only when a read came back EMPTY, which is the idle path — a busy stream never pays for
	 * it.
	 */
	const isStale = async (key: string, cursor: string): Promise<boolean> => {
		if (cursor === FROM_START) return false;
		const exists = await send(["EXISTS", key]);
		return Number(asText(exists) ?? exists) === 0;
	};

	const readFrom = async (
		sender: RedisCommand,
		key: string,
		cursor: string,
		block: number | undefined,
	): Promise<RunStreamPage> => {
		const reply = await sender([
			"XREAD",
			"COUNT",
			String(count),
			...(block !== undefined ? ["BLOCK", String(block)] : []),
			"STREAMS",
			key,
			cursor,
		]);
		const { chunks, last } = parseXRead(reply);
		if (chunks.length === 0 && last === undefined) {
			return {
				chunks: [],
				cursor,
				stale: await isStale(key, cursor),
			};
		}
		return { chunks, cursor: last ?? cursor, stale: false };
	};

	const port: RunStreamPort = {
		append: async (key, chunk) => {
			// MAXLEN ~ is the approximate form: Redis trims at node boundaries rather than exactly,
			// which is dramatically cheaper and is the right trade for a ceiling that exists to stop a
			// runaway, not to hold a precise number.
			await send([
				"XADD",
				key,
				"MAXLEN",
				"~",
				String(maxLen),
				"*",
				FIELD,
				JSON.stringify(chunk),
			]);
			// REFRESHED on every append, not set once. There is no counter here to restart numbering,
			// so a long conversation keeps its live log for as long as it is live — and a dead one
			// still expires `ttl` after its last word.
			await send(["EXPIRE", key, String(ttl)]);
		},

		read: async (key, cursor) =>
			readFrom(send, key, cursor ?? FROM_START, undefined),
	};

	// PUSH, only when the host gave this port a connection it may block. Without one the member is
	// absent, and `watchThread` falls back to polling — a documented degradation rather than a
	// blocking command quietly issued on the connection the rest of the app is using.
	if (options.blocking !== undefined) {
		const blocking = resolveSender(options.blocking);
		port.watch = async function* watch(key, cursor) {
			let at = cursor ?? FROM_START;
			while (true) {
				const page = await readFrom(blocking, key, at, blockMs);
				at = page.cursor;
				if (page.stale) {
					yield page;
					return;
				}
				// An empty page is `BLOCK` timing out with nothing to say. Reissue rather than yield —
				// a consumer counting pages should be counting deltas, not heartbeats.
				if (page.chunks.length > 0) yield page;
			}
		};
	}
	return port;
}
