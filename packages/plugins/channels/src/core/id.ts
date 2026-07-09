import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * The row id for anything keyed by (provider, endpointKey) IS the hash of that natural key —
 * uniqueness rides the primary key, concurrent upserts converge on one row, and by-key lookups are
 * primary-key reads (engine-sql's idempotency-id precedent). Both the channel_endpoint state table
 * and the channel_registration registry derive their ids here.
 */
export function endpointId(key: {
	provider: string;
	endpointKey: string;
}): string {
	return bytesToHex(
		sha256(
			utf8ToBytes(
				JSON.stringify({
					provider: key.provider,
					endpointKey: key.endpointKey,
				}),
			),
		),
	);
}
