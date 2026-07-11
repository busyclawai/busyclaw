// At-rest encryption for stored secret values — AES-256-GCM via @noble/ciphers. This table is a
// deliberate honeypot (many tokens for many users in one place), so unlike channels'
// `endpoint.secret` (host's-database-concern posture) the value column NEVER holds plaintext:
// `seal` runs inside the store's write path, `open` inside the provider's read path, and the
// encoded form is all that ever touches the adapter.
//
// Sealed encoding: `hex( nonce(12 bytes) ‖ ciphertext+tag )` — a fresh random 96-bit GCM nonce is
// generated per seal and prepended, so the row is self-contained (no key/nonce bookkeeping columns)
// and re-sealing the same plaintext never reuses a nonce. GCM appends its 16-byte auth tag to the
// ciphertext, so the minimum sealed length is 28 bytes (56 hex chars) — tampering or a wrong key
// fails authentication loud in `open`.

import { configurationError, errorMessage } from "@euroclaw/contracts";
import { gcm } from "@noble/ciphers/aes.js";
import {
	bytesToHex,
	bytesToUtf8,
	hexToBytes,
	randomBytes,
	utf8ToBytes,
} from "@noble/ciphers/utils.js";

/** The canonical name the master key resolves under (through the one-door reader) when no
 *  `secretStore({ key })` is configured. The store provider SHORT-CIRCUITS this name to a miss —
 *  the key must come from another provider (env/vault) or config, never from its own table. */
export const SECRET_STORE_KEY_NAME = "EUROCLAW_SECRET_STORE_KEY";

const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // the standard 96-bit GCM nonce

/**
 * Parse + validate a master key: exactly 32 bytes, HEX-encoded (64 chars — the house encoding;
 * generate one with `openssl rand -hex 32`). Fails loud on anything else — a truncated or
 * mis-encoded key must never silently weaken the cipher.
 */
export function parseSecretStoreKey(encoded: string): Uint8Array {
	let bytes: Uint8Array;
	try {
		bytes = hexToBytes(encoded);
	} catch (err) {
		throw configurationError(
			"secret store master key is not valid hex — pass 32 bytes hex-encoded (64 chars)",
			{ cause: errorMessage(err) },
		);
	}
	if (bytes.length !== KEY_BYTES) {
		throw configurationError(
			"secret store master key has the wrong length — pass 32 bytes hex-encoded (64 chars)",
			{ length: bytes.length },
		);
	}
	return bytes;
}

/** Seal/open stored secret values. One instance per plugin, shared by the store (write path) and
 *  the provider (read path), so both sides always use the same key. */
export type SecretCipher = {
	seal: (plaintext: string) => Promise<string>;
	open: (sealed: string) => Promise<string>;
};

/**
 * Build the cipher over a LAZY key resolver — the key is fetched on first seal/open, not at
 * construction (so it can live behind the one-door reader, which isn't consultable until the
 * assembly hands it to `configure`), and memoized on success. A resolver failure propagates loud
 * from every seal/open — with rows present there is no degraded mode, only "fix the key".
 */
export function createSecretCipher(
	resolveKey: () => Promise<Uint8Array>,
): SecretCipher {
	let cached: Uint8Array | undefined;
	const key = async (): Promise<Uint8Array> => {
		if (!cached) cached = await resolveKey();
		return cached;
	};

	return {
		seal: async (plaintext) => {
			const nonce = randomBytes(NONCE_BYTES);
			const sealed = gcm(await key(), nonce).encrypt(utf8ToBytes(plaintext));
			return bytesToHex(nonce) + bytesToHex(sealed);
		},
		open: async (sealed) => {
			const k = await key();
			let bytes: Uint8Array;
			try {
				bytes = hexToBytes(sealed);
			} catch (err) {
				throw configurationError(
					"stored secret value is not a sealed payload — the row was written outside the store",
					{ cause: errorMessage(err) },
				);
			}
			try {
				return bytesToUtf8(
					gcm(k, bytes.slice(0, NONCE_BYTES)).decrypt(bytes.slice(NONCE_BYTES)),
				);
			} catch (err) {
				// GCM authentication failed: a wrong/rotated key or a tampered row. Loud and actionable —
				// never ciphertext, never a miss.
				throw configurationError(
					"cannot decrypt stored secret — wrong or rotated master key, or a tampered row",
					{ cause: errorMessage(err) },
				);
			}
		},
	};
}
