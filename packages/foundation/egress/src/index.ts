// The egress network floor — the non-negotiable beneath any policy. Cedar compares strings and
// cannot see network reality, so before an outbound request opens a socket this floor:
//   • allows https only (an allowInsecure opt for tests / localhost dev);
//   • resolves the host and REJECTS loopback / private (RFC1918) / link-local / unique-local /
//     CGNAT / unspecified ranges, IPv4 and IPv6 (incl. IPv4-mapped IPv6) — the standard outbound
//     guard that stops the runtime being used as an SSRF pivot;
//   • resolves ONCE and PINS that address, so the block decision and the connection target are the
//     same resolution — a name that passed the check cannot be re-resolved to a blocked address in
//     between (the classic check-then-connect / DNS-rebinding gap is closed WITHIN the floor).
//
// Runtime-agnostic (foundation): this package ships NO default DNS resolver — a named host requires
// the caller to inject `lookup` (the runtime binds `node:dns`; tests inject a fake). Keeping node:*
// out is what lets a plugin (sandboxes) apply the floor. A named host with no injected `lookup`
// fails loud; IP-literal targets need no resolver at all.
//
// Residual pin gap (for whoever performs the fetch): pinning returns the vetted address, but a
// global `fetch` without a custom dispatcher re-resolves at socket time. A caller that needs a hard
// pin binds its fetch to a dispatcher built from `pinnedAddress`. IP-literal targets have no gap.

import { configurationError } from "@busyclaw/contracts";

export type ResolvedAddress = { address: string; family: number };

/** Resolve a hostname to its addresses. Injected by the caller — this package ships no default
 *  (foundation is runtime-agnostic); the runtime binds node:dns, tests inject a fake. */
export type EgressLookup = (
	hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export type EgressOptions = {
	/** Allow `http:` targets (tests / localhost dev). Default false — https only. */
	allowInsecure?: boolean;
	/** DNS resolution for named hosts. REQUIRED for a named host (no default here); a named host
	 *  with no `lookup` fails loud. Omit only for IP-literal targets, which never resolve. */
	lookup?: EgressLookup;
};

export type EgressDecision = {
	/** The original URL — fetched as-is so TLS SNI / certificate validation use the real hostname. */
	url: string;
	/** The vetted, pinned address the connection should target (same resolution as the block check). */
	pinnedAddress: string;
	family: number;
};

/** Assert an egress target is allowed, returning the pinned address. Throws a clear, auditable
 *  error for a blocked target — never a silent deny. */
export async function assertEgressAllowed(
	url: string,
	options: EgressOptions = {},
): Promise<EgressDecision> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw configurationError("egress target is not a valid URL", { url });
	}
	if (
		parsed.protocol !== "https:" &&
		!(options.allowInsecure === true && parsed.protocol === "http:")
	) {
		throw configurationError("egress blocked: only https targets are allowed", {
			url,
			protocol: parsed.protocol,
		});
	}

	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	const literal = ipKind(host);
	// An IP-literal host is validated directly — no DNS, so no rebinding window at all. A named host
	// needs resolution: with no default resolver here, an absent `lookup` fails loud rather than
	// silently skipping the SSRF check.
	let resolved: readonly ResolvedAddress[];
	if (literal) {
		resolved = [{ address: host, family: literal }];
	} else {
		const lookup = options.lookup;
		if (!lookup) {
			throw configurationError(
				"egress: no DNS lookup injected — @busyclaw/egress ships no default; pass options.lookup",
				{ host },
			);
		}
		resolved = await lookup(host);
	}
	if (resolved.length === 0) {
		throw configurationError("egress blocked: host did not resolve", { host });
	}

	// Fail closed: if ANY resolved address is in a blocked range, refuse the whole target.
	for (const { address } of resolved) {
		const reason = blockedAddressReason(address);
		if (reason !== undefined) {
			throw configurationError(
				"egress blocked: target resolves to a disallowed address",
				{ host, address, reason },
			);
		}
	}

	const [first] = resolved;
	// resolved is non-empty (guarded above); index is safe.
	if (!first) {
		throw configurationError("egress blocked: host did not resolve", { host });
	}
	return { url, pinnedAddress: first.address, family: first.family };
}

/** Reason a literal address is blocked, or undefined if allowed. Exported for direct testing of
 *  the range logic. Fails closed: an address it cannot parse is treated as blocked. */
export function blockedAddressReason(address: string): string | undefined {
	const v4 = parseIPv4(address);
	if (v4) return blockedIPv4(v4);
	const v6 = expandIPv6(address);
	if (v6) return blockedIPv6(v6);
	return "unparseable address";
}

function ipKind(host: string): 0 | 4 | 6 {
	if (parseIPv4(host)) return 4;
	if (expandIPv6(host)) return 6;
	return 0;
}

function parseIPv4(text: string): [number, number, number, number] | undefined {
	const parts = text.split(".");
	if (parts.length !== 4) return undefined;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const value = Number(part);
		if (value > 255) return undefined;
		octets.push(value);
	}
	return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function blockedIPv4(octets: readonly number[]): string | undefined {
	const a = octets[0] ?? 0;
	const b = octets[1] ?? 0;
	if (a === 0) return "unspecified 0.0.0.0/8";
	if (a === 10) return "private 10.0.0.0/8";
	if (a === 127) return "loopback 127.0.0.0/8";
	if (a === 169 && b === 254) return "link-local 169.254.0.0/16";
	if (a === 172 && b >= 16 && b <= 31) return "private 172.16.0.0/12";
	if (a === 192 && b === 168) return "private 192.168.0.0/16";
	if (a === 100 && b >= 64 && b <= 127) return "CGNAT 100.64.0.0/10";
	if (a === 255 && b === 255) return "broadcast 255.255.0.0/16";
	return undefined;
}

/** Expand an IPv6 string to its 8 16-bit groups, handling `::` compression and a trailing IPv4
 *  dotted quad. Returns undefined for anything that is not a valid IPv6 literal. */
function expandIPv6(input: string): number[] | undefined {
	let text = input;
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone);
	if (!text.includes(":")) return undefined;

	const halves = text.split("::");
	if (halves.length > 2) return undefined;

	const parseSide = (segment: string): number[] | undefined => {
		if (segment === "") return [];
		const tokens = segment.split(":");
		const groups: number[] = [];
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
			if (token === undefined || token === "") return undefined;
			if (token.includes(".")) {
				// A dotted IPv4 tail is only valid as the final token; it fills two groups.
				if (index !== tokens.length - 1) return undefined;
				const v4 = parseIPv4(token);
				if (!v4) return undefined;
				groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
				continue;
			}
			if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return undefined;
			groups.push(Number.parseInt(token, 16));
		}
		return groups;
	};

	const head = parseSide(halves[0] ?? "");
	if (!head) return undefined;
	if (halves.length === 1) return head.length === 8 ? head : undefined;

	const tail = parseSide(halves[1] ?? "");
	if (!tail) return undefined;
	const fill = 8 - head.length - tail.length;
	// `::` must stand in for at least one all-zero group.
	if (fill < 1) return undefined;
	return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function blockedIPv6(groups: readonly number[]): string | undefined {
	const g0 = groups[0] ?? 0;
	// IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): validate the embedded IPv4.
	const highZero = groups.slice(0, 5).every((group) => group === 0);
	if (highZero && groups[5] === 0xffff) {
		return blockedIPv4(embeddedIPv4(groups));
	}
	if (
		highZero &&
		groups[5] === 0 &&
		(groups[6] !== 0 || (groups[7] ?? 0) > 1)
	) {
		return blockedIPv4(embeddedIPv4(groups));
	}
	if (groups.every((group) => group === 0)) return "unspecified ::";
	if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
		return "loopback ::1";
	}
	if ((g0 & 0xffc0) === 0xfe80) return "link-local fe80::/10";
	if ((g0 & 0xfe00) === 0xfc00) return "unique-local fc00::/7";
	return undefined;
}

function embeddedIPv4(
	groups: readonly number[],
): [number, number, number, number] {
	const g6 = groups[6] ?? 0;
	const g7 = groups[7] ?? 0;
	return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff];
}
