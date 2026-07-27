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
//
// Every seal is BOUND to the row it belongs to, as GCM additional authenticated data (authenticated,
// not encrypted). Without it a sealed value is portable: the blob says nothing about where it came
// from, so anyone able to write the value column — SQL injection, a backup restored into the wrong
// boundary, a rogue DBA, an app bug addressing the wrong row — can copy one boundary's sealed secret into
// another scope's row and the reader decrypts it happily, because the key is right and the tag is
// valid. The binding makes the ciphertext refuse to open anywhere but its own row.
//
// The binding is the RESOLUTION KEY `(scope, scopeId, name)`, deliberately not the row `id`. The
// read path finds a row by that tuple and never by id, so binding to id would leave a gap: a row
// carrying a victim's id but the attacker's boundary is still found by the attacker's lookup, and the
// AAD would match. Binding to the tuple closes it structurally — to make the AAD match you must set
// the row's boundary to the victim's, and then the attacker's lookup no longer finds the row at all.
// The thing bound and the thing looked up are one key, so nothing fits between them.
//
// Scope of the guarantee, honestly: this defends DB write WITHOUT key access. Anyone holding the
// master key can re-seal any value under any binding, and AAD does not pretend otherwise — it is the
// cheap version of per-boundary keys, not a replacement.
//
// PRE-ALPHA HARD CUT: a value sealed before this binding existed is byte-identical to a bound one, so
// `open` cannot tell them apart and there is no legacy path — accepting one would be a permanent
// downgrade oracle on exactly the attack this closes. Rows written earlier fail to open and must be
// re-entered.

import { configurationError, errorMessage } from "@busyclaw/contracts";
import { gcm } from "@noble/ciphers/aes.js";
import {
	bytesToHex,
	bytesToUtf8,
	hexToBytes,
	randomBytes,
	utf8ToBytes,
} from "@noble/ciphers/utils.js";

/** The canonical name the master key resolves under (through the one-door reader) when no
 *  `secrets([], { store: { key } })` is configured. The store provider SHORT-CIRCUITS this name to a
 *  miss — the key must come from another provider (env/vault) or config, never from its own table. */
export const SECRET_STORE_KEY_NAME = "BUSYCLAW_SECRET_STORE_KEY";

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
	} catch {
		// SHAPE ONLY — never the cause. noble's hex error quotes the offending characters, which here
		// are MASTER KEY material, and this throw travels to the operator-notice door and the logs.
		// The length is enough to diagnose a truncated or mis-encoded key.
		throw configurationError(
			"secret store master key is not valid hex — pass 32 bytes hex-encoded (64 chars)",
			{ length: encoded.length },
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

/**
 * The row a sealed value belongs to — the store's resolution key, and the only place its ciphertext
 * may be opened. Exactly the tuple `findByKey` looks up by, which is what makes the bind airtight.
 */
export type SecretBinding = {
	scope: string;
	scopeId: string;
	name: string;
};

/**
 * The binding as AAD bytes. Encoded as a JSON ARRAY so the parts cannot run together: concatenating
 * them would make `("a","bc",…)` and `("ab","c",…)` the same AAD, and a relocation between two such
 * rows would silently verify. An array is unambiguous and has no key-order question.
 */
function bindingAad(binding: SecretBinding): Uint8Array {
	return utf8ToBytes(
		JSON.stringify([binding.scope, binding.scopeId, binding.name]),
	);
}

/** Seal/open stored secret values. One instance per plugin, shared by the store (write path) and
 *  the provider (read path), so both sides always use the same key. Both halves take the row's
 *  binding: seal writes it into the tag, open verifies it, so a value moved between rows fails. */
export type SecretCipher = {
	seal: (plaintext: string, binding: SecretBinding) => Promise<string>;
	open: (sealed: string, binding: SecretBinding) => Promise<string>;
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
		seal: async (plaintext, binding) => {
			const nonce = randomBytes(NONCE_BYTES);
			const sealed = gcm(await key(), nonce, bindingAad(binding)).encrypt(
				utf8ToBytes(plaintext),
			);
			return bytesToHex(nonce) + bytesToHex(sealed);
		},
		open: async (sealed, binding) => {
			const k = await key();
			let bytes: Uint8Array;
			try {
				bytes = hexToBytes(sealed);
			} catch {
				// Shape only, same rule as the key parse — noble's hex error quotes the offending
				// characters, and here those are stored ciphertext.
				throw configurationError(
					"stored secret value is not a sealed payload — the row was written outside the store",
					{ length: sealed.length },
				);
			}
			try {
				return bytesToUtf8(
					gcm(k, bytes.slice(0, NONCE_BYTES), bindingAad(binding)).decrypt(
						bytes.slice(NONCE_BYTES),
					),
				);
			} catch (err) {
				// GCM authentication failed. One of: a wrong/rotated master key, a tampered row, a value
				// sealed for a DIFFERENT row and moved here (the binding refusing, which is the point), or
				// a row written before values were bound (pre-alpha — re-enter it). Indistinguishable by
				// construction, so the message names all four rather than guessing. Loud and actionable —
				// never ciphertext, never a miss.
				throw configurationError(
					"cannot decrypt stored secret — wrong or rotated master key, a tampered row, a value sealed for another row, or a row predating value binding",
					{
						cause: errorMessage(err),
						scope: binding.scope,
						scopeId: binding.scopeId,
						name: binding.name,
					},
				);
			}
		},
	};
}
