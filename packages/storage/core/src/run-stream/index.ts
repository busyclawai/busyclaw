// THE RUN STREAM — live deltas of work in flight, for everyone who is not driving it.
//
// The protocol (`RunStreamPort`, `RunStreamChunk`, the key helpers) lives in @busyclaw/contracts; the
// implementations live here. Three files, and the split is by what varies:
//
//   chunk.ts             how a chunk becomes bytes and back — shared, so two backends cannot
//                        disagree about what an unreadable entry means
//   polling.ts           `read` → a subscription, for the backends that cannot push
//   secondary-storage.ts over any `SecondaryStorage` — the default whenever a host has a KV
//   redis.ts             over Redis Streams — the one that can actually push
//
// See docs/plans/one-run.md D17 for why this exists and what it may never become (a record).

export { decodeChunk, encodeChunk } from "./chunk";
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
export { secondaryStorageStream } from "./secondary-storage";
