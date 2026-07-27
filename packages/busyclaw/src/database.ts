// The database intake for the product config — better-auth's DX: hand createClaw a storage Adapter
// OR a raw Kysely input (better-sqlite3 Database, pg Pool, dialect) and the assembly wraps it. This
// lives HERE, not in runtime: bundling one ORM's intake into the runtime taxed every consumer;
// runtime speaks only the storage protocol (`Adapter`).
import type { Adapter } from "@busyclaw/contracts";
import { type KyselyDatabase, kyselyAdapter } from "@busyclaw/storage-kysely";

/** Durable substrate accepted by createClaw. Raw Kysely inputs are wrapped; Adapters pass through. */
export type ClawDatabase = Adapter | KyselyDatabase;

function isAdapter(db: ClawDatabase): db is Adapter {
	const x = db as Partial<Adapter>;
	return (
		typeof x.id === "string" &&
		typeof x.create === "function" &&
		typeof x.consumeOne === "function"
	);
}

export function resolveDatabase(db: ClawDatabase): Adapter {
	return isAdapter(db) ? db : kyselyAdapter(db);
}
