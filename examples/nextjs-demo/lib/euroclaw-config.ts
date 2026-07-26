// The claw's configuration, as a factory over its connection string.
//
// Two callers need this config with two DIFFERENT connections, and only the connection differs:
//
//   the app  → Neon's POOLED endpoint. Every serverless invocation opens its own connection, so
//              without PgBouncer in front you exhaust the database's connection limit under load.
//   the CLI  → Neon's UNPOOLED endpoint. The pooler runs in transaction mode, which is a poor fit
//              for migrations; DDL wants a plain session.
//
// A factory keeps that the ONLY difference. Two hand-written configs would drift, and a drifted
// migration config is the one that quietly migrates the wrong set of tables.

import { regexDetector } from "@euroclaw/detectors/regex";
import { Pool } from "pg";
import { resolveModel } from "./model";

export function clawConfig(connectionString: string) {
	return {
		model: resolveModel(),

		// A `pg` Pool — createClaw duck-types it and wraps it in Kysely, so no adapter is
		// constructed here. That matters for the CLI: it needs the underlying Kysely input to
		// introspect, and an already-wrapped Adapter would hide it.
		database: new Pool({
			connectionString,
			// Neon terminates idle connections; a small pool with a short idle timeout keeps a
			// serverless instance from holding sockets it will not reuse.
			max: 5,
			idleTimeoutMillis: 10_000,
			connectionTimeoutMillis: 10_000,
		}),

		// Redaction ARMED. With no tools wired yet this is what makes the chat interesting: type an
		// email or an IBAN and the model receives a placeholder, and the streamed answer is
		// rehydrated on the way back to the reader.
		redaction: {
			detectors: [regexDetector],
			// Without this the same value mints a NEW placeholder every time it appears: the vault
			// grows per occurrence, and a transcript loses coreference — two mentions of one person
			// stop looking like one person to the model. It is a SECRET, not a salt to hardcode: the
			// dedup index is a keyed hash, so that low-entropy PII cannot be dictionary-attacked
			// offline by anyone who gets the table. Losing it only resets dedup; rehydration of
			// existing mappings is unaffected.
			indexKey: redactionIndexKey(),
		},
	};
}

/** The dedup key for PII placeholders. Absent in dev is survivable (the runtime warns); absent in
 *  a deployment means every mention of one person looks like a different person. */
function redactionIndexKey(): string | undefined {
	const key = process.env.EUROCLAW_REDACTION_INDEX_KEY;
	return key === undefined || key === "" ? undefined : key;
}

/** The app's connection: pooled. */
export function appConnectionString(): string {
	const url = process.env.DATABASE_URL;
	if (url === undefined || url === "") {
		throw new Error(
			"DATABASE_URL is not set — copy .env.example to .env.local and fill in your Neon pooled connection string.",
		);
	}
	return url;
}

/** The migrator's connection: unpooled when available, since DDL wants a plain session. */
export function migrationConnectionString(): string {
	return (
		process.env.DATABASE_URL_UNPOOLED ??
		process.env.POSTGRES_URL_NON_POOLING ??
		appConnectionString()
	);
}
