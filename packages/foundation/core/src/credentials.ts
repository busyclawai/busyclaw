// Comparing a presented credential against the expected one.
//
// It lives in core, beside the request-body budget, for the same reason that does: both are
// decisions about what busyclaw will do with untrusted input, and both have call sites on opposite
// sides of the plugin boundary — the adapter's cron route and a channel's webhook verify. A
// comparison either of them re-implements is a comparison one of them will get wrong, which is
// exactly what happened: telegram's webhook secret was compared carefully and `/cron`'s was not.

import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Compare a presented secret against the expected one WITHOUT leaking, through timing, how much of a
 * guess was right.
 *
 * `===` on strings short-circuits at the first differing byte, which turns a secret into something an
 * attacker can walk out one character at a time given enough requests. Both sides are hashed to a
 * fixed 32 bytes first, so the comparison length is constant and reveals nothing about the secret's
 * own length either; the XOR-accumulate then always reads every byte.
 *
 * `null` — the header was absent — is never equal to anything, and returns before the hashing rather
 * than being folded in as an empty string, which would make "no header" and "empty header" the same
 * event to anyone watching the clock.
 */
export function constantTimeEquals(
	presented: string | null | undefined,
	expected: string,
): boolean {
	if (presented === null || presented === undefined) return false;
	const a = sha256(utf8ToBytes(presented));
	const b = sha256(utf8ToBytes(expected));
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}
