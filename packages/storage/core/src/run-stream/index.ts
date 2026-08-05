// THE RUN STREAM — live deltas of work in flight, for everyone who is not driving it.
//
// The protocol (`RunStreamPort`, `RunStreamChunk`, the key helpers) lives in @busyclaw/contracts; the
// implementations live here. Three files, and the split is by what varies:
//
//   batch.ts             coalesce text before it reaches a backend — wraps any of the below
//   chunk.ts             how a chunk becomes bytes and back — shared, so two backends cannot
//                        disagree about what an unreadable entry means
//   polling.ts           `read` → a subscription, for the backends that cannot push
//   shared.ts            one reader per key per process, fanned out — wraps any of the below
//   database.ts          over the storage Adapter — the backing of last resort, so a claw with only
//                        a `database` can still be watched
//   kv.ts                over any `SecondaryStorage` — the default whenever a host has a KV
//   redis.ts             over Redis Streams — the one that can actually push
//
// The backend files are named for WHAT BACKS THEM, not for what they return: both return a
// `RunStreamPort`. `kv.ts` is not the in-memory one — it runs over whatever `SecondaryStorage` the
// host configured, which in production is usually a real server.
//
// See docs/plans/one-run.md D17 for why this exists and what it may never become (a record).

export {
	type BatchedStreamOptions,
	batchedStream,
	DEFAULT_BATCH_CHARS,
	DEFAULT_BATCH_MS,
} from "./batch";
export { decodeChunk, encodeChunk } from "./chunk";
export { type DatabaseStreamOptions, databaseStream } from "./database";
export { secondaryStorageStream } from "./kv";
export {
	DEFAULT_POLL_INTERVAL_MS,
	type PollingWatchOptions,
	pollingWatch,
} from "./polling";
export {
	type RedisCommand,
	type RedisLike,
	type RedisStreamOptions,
	redisStream,
} from "./redis";
export { sharedStream } from "./shared";
