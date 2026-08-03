// At-rest encryption for stored secret values — AES-256-GCM via @noble/ciphers. This table is a
// deliberate honeypot (many tokens for many users in one place), so unlike channels'
// `endpoint.secret` (host's-database-concern posture) the value column NEVER holds plaintext:
// `seal` runs inside the store's write path, `open` inside the provider's read path, and the
// encoded form is all that ever touches the adapter.
//
// Sealed encoding: `k1.<keyId>.hex( nonce(12 bytes) ‖ ciphertext+tag )` — a fresh random 96-bit GCM
// nonce is generated per seal and prepended, so the row is self-contained (no nonce bookkeeping
// column) and re-sealing the same plaintext never reuses a nonce. GCM appends its 16-byte auth tag,
// so the minimum payload is 28 bytes (56 hex chars) — tampering fails authentication loud in `open`.
// The `keyId` names WHICH key sealed the row, which is what makes rotation a procedure rather than
// an outage; see the keyring section below.
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
// PRE-ALPHA HARD CUT, twice over. A value sealed before this binding existed is byte-identical to a
// bound one, so `open` cannot tell them apart and there is no legacy path — accepting one would be a
// permanent downgrade oracle on exactly the attack this closes. A value sealed before key ids carries
// no prefix, and guessing which key to try is the ambiguity the id exists to remove. Rows written
// before either fail to open and must be re-entered.

import type { Secrets } from "@busyclaw/contracts";
import { configurationError, errorMessage } from "@busyclaw/contracts";
import { gcm } from "@noble/ciphers/aes.js";
import {
	bytesToHex,
	bytesToUtf8,
	concatBytes,
	hexToBytes,
	randomBytes,
	utf8ToBytes,
} from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

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

// ── the keyring — M-13 ───────────────────────────────────────────────────────────────────────────
//
// The envelope used to be `hex(nonce ‖ ciphertext+tag)` and said nothing about WHICH key sealed it.
// One key, forever: swapping it made every stored row fail to open, indistinguishably from tampering
// (the `open` failure below had to name "wrong or rotated master key" first among four causes,
// because it genuinely could not tell). Rotation was therefore not a procedure — it was an outage
// plus re-entering every secret by hand, which is the same as saying a leaked key can never be
// retired.
//
// A key ID in the envelope turns that into a routine operation: new writes seal under the active key,
// old rows keep opening under the key that sealed them, and an operator can see which rows are still
// on a retired key by reading the ID. The ID is DERIVED from the key — a domain-separated,
// truncated hash — so no config carries it and no operator can mislabel one. It is not secret: it
// sits beside the ciphertext it labels, and a hash of 32 random bytes gives an attacker nothing.
const ENVELOPE_V1 = "k1";
const KEY_ID_CHARS = 16;

/** The fingerprint naming one key inside an envelope. */
export function secretKeyId(key: Uint8Array): string {
	return bytesToHex(
		sha256(concatBytes(utf8ToBytes("busyclaw.secret-key-id.v1"), key)),
	).slice(0, KEY_ID_CHARS);
}

/**
 * Every key a deployment can OPEN with, and the single one it SEALS with.
 *
 * Rotation is: put the new key first. The old one stays in the list so its rows keep opening, and
 * drops out once nothing is sealed under it any more — which the IDs make checkable rather than
 * hopeful.
 */
export type SecretKeyring = {
	readonly activeId: string;
	readonly active: Uint8Array;
	readonly byId: ReadonlyMap<string, Uint8Array>;
};

/** Build a keyring from keys in priority order: the FIRST seals, all of them open. */
export function secretKeyring(keys: readonly Uint8Array[]): SecretKeyring {
	const active = keys[0];
	if (!active) {
		throw configurationError("secret store keyring is empty", {
			reason: "pass at least one 32-byte master key",
		});
	}
	const byId = new Map<string, Uint8Array>();
	for (const key of keys) byId.set(secretKeyId(key), key);
	return { activeId: secretKeyId(active), active, byId };
}

/** Seal/open stored secret values. One instance per plugin, shared by the store (write path) and
 *  the provider (read path), so both sides always use the same keyring. Both halves take the row's
 *  binding: seal writes it into the tag, open verifies it, so a value moved between rows fails. */
export type SecretCipher = {
	seal: (plaintext: string, binding: SecretBinding) => Promise<string>;
	open: (sealed: string, binding: SecretBinding) => Promise<string>;
};

/**
 * How long a resolved keyring is reused before it is fetched again.
 *
 * It used to be cached for the life of the PROCESS. That made an upstream rotation — a new key in
 * the vault the resolver reads — invisible until every host restarted, so the window in which a
 * withdrawn key was still in use had no bound and no way to observe it. Re-resolving on a timer
 * gives that window a ceiling; five minutes is short enough that a rotation lands promptly and long
 * enough that the vault is not on the hot path of every read.
 */
const KEYRING_TTL_MS = 5 * 60 * 1000;

export type SecretCipherOptions = { now?: () => number };

/**
 * Build the cipher over a LAZY keyring resolver — fetched on first seal/open, not at construction
 * (so it can live behind the one-door reader, which isn't consultable until the assembly hands it to
 * `configure`), and reused for {@link KEYRING_TTL_MS}. A resolver failure propagates loud from every
 * seal/open — with rows present there is no degraded mode, only "fix the key".
 */
export function createSecretCipher(
	resolveKeyring: () => Promise<SecretKeyring>,
	options: SecretCipherOptions = {},
): SecretCipher {
	const now = options.now ?? (() => Date.now());
	let cached: { keyring: SecretKeyring; fetchedAt: number } | undefined;
	let inFlight: Promise<SecretKeyring> | undefined;

	const keyring = async (): Promise<SecretKeyring> => {
		if (cached && now() - cached.fetchedAt < KEYRING_TTL_MS) {
			return cached.keyring;
		}
		// One fetch at a time: an expiry under concurrent reads would otherwise send every waiting
		// call to the vault at once, which is a thundering herd aimed at the one dependency that must
		// stay available for anything to be decryptable at all.
		if (!inFlight) {
			inFlight = resolveKeyring()
				.then((resolved) => {
					cached = { keyring: resolved, fetchedAt: now() };
					return resolved;
				})
				.finally(() => {
					inFlight = undefined;
				});
		}
		return inFlight;
	};

	return {
		seal: async (plaintext, binding) => {
			const ring = await keyring();
			const nonce = randomBytes(NONCE_BYTES);
			const sealed = gcm(ring.active, nonce, bindingAad(binding)).encrypt(
				utf8ToBytes(plaintext),
			);
			// Self-describing: version, the key that sealed it, then the payload. Dots cannot occur
			// in hex, so the split is unambiguous.
			return `${ENVELOPE_V1}.${ring.activeId}.${bytesToHex(nonce)}${bytesToHex(sealed)}`;
		},
		open: async (sealed, binding) => {
			const ring = await keyring();
			const parts = sealed.split(".");
			// PRE-ALPHA HARD CUT, the same one the binding took: an envelope with no key id predates
			// the keyring, and guessing which key to try would be exactly the ambiguity the id exists
			// to remove. Re-enter those rows.
			if (parts.length !== 3 || parts[0] !== ENVELOPE_V1) {
				throw configurationError(
					"stored secret value is not a sealed payload — the row was written outside the store, or predates key ids (pre-alpha: re-enter it)",
					{ length: sealed.length },
				);
			}
			const keyId = parts[1] ?? "";
			const payload = parts[2] ?? "";
			const key = ring.byId.get(keyId);
			if (!key) {
				// Nameable, unlike a bare authentication failure: the operator learns WHICH key is
				// missing, so a rotation that dropped a key still in use is a fixable mistake rather
				// than a row that has silently become unreadable.
				throw configurationError(
					"stored secret was sealed with a key this deployment no longer holds — restore it to the keyring, or re-enter the secret",
					{
						keyId,
						knownKeyIds: [...ring.byId.keys()],
						scope: binding.scope,
						scopeId: binding.scopeId,
						name: binding.name,
					},
				);
			}
			let bytes: Uint8Array;
			try {
				bytes = hexToBytes(payload);
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
					gcm(key, bytes.slice(0, NONCE_BYTES), bindingAad(binding)).decrypt(
						bytes.slice(NONCE_BYTES),
					),
				);
			} catch (err) {
				// GCM authentication failed. The key was the RIGHT one (its id matched), so the causes
				// left are: a tampered row, or a value sealed for a DIFFERENT row and moved here — the
				// binding refusing, which is the point. Narrower than it used to be precisely because
				// the key id removed "wrong or rotated key" from the list.
				throw configurationError(
					"cannot decrypt stored secret — the row was tampered with, or the value was sealed for another row",
					{
						cause: errorMessage(err),
						keyId,
						scope: binding.scope,
						scopeId: binding.scopeId,
						name: binding.name,
					},
				);
			}
		},
	};
}

/**
 * Build a cipher over the deployment's master key, read through the one-door reader.
 *
 * The keyring resolution lived inside the secrets plugin, where it was the only consumer. R-M07 gave
 * it three more — the channel bot token, PII mapping originals, SQL-engine prompts — and each writing
 * its own copy of "read the env var, split on commas, parse the hex" is three chances to disagree
 * about what a keyring is.
 *
 * ONE key for all of them, which is safe here rather than merely convenient: every ciphertext is
 * bound to its own `(scope, scopeId, name)` as AAD, so a sealed bot token cannot be opened as a PII
 * original even under the same key — the tag will not verify. What a separate key per consumer would
 * buy is rotating one without the others, which nothing has asked for and which is a change of `name`
 * away if it ever does.
 *
 * Lazy and cached by {@link createSecretCipher}: a deployment that never seals anything never reads
 * the key, so this costs nothing where it is not used.
 */
export function cipherFromSecrets(
	reader: Secrets,
	options: SecretCipherOptions = {},
): SecretCipher {
	return createSecretCipher(async () => {
		// `require` fails loud naming the key rather than returning null — a deployment that stores
		// credentials and cannot find its key must not start writing them in the clear.
		const material = await reader.require(SECRET_STORE_KEY_NAME, {
			kind: "token",
		});
		// Comma-separated, so one env var carries a whole keyring: first seals, all open. A single key
		// is a list of one, so nothing changes for a deployment that has not rotated yet.
		return secretKeyring(
			material.value
				.split(",")
				.map((part: string) => part.trim())
				.filter((part: string) => part.length > 0)
				.map(parseSecretStoreKey),
		);
	}, options);
}
