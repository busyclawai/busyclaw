# @busyclaw/egress

The outbound egress safety floor — the layer BENEATH policy. Authorization ("may this actor reach
this destination?") is `@busyclaw/authz` + Cedar over `context.server`; this package is the
non-negotiable network-safety guard that runs regardless of any policy:

- `assertEgressAllowed` — https-only (with an `allowInsecure` opt for localhost/tests), reject
  loopback / private (RFC1918) / link-local / unique-local / CGNAT / unspecified ranges (IPv4 and
  IPv6, incl. IPv4-mapped IPv6), and resolve-once-and-PIN so the block decision and the connection
  target are the same resolution (the check-then-connect / DNS-rebinding gap is closed within the
  floor). The standard guard against being used as an SSRF pivot.
- `blockedAddressReason` — the IP-range predicate the floor is built on. Exported for direct testing
  of the range logic.

**Node-free by design.** This package ships NO default DNS resolver — a named host requires the
caller to inject `lookup` (the runtime binds `node:dns`; tests inject a fake). A named host with no
injected `lookup` fails loud, never silently skips the SSRF check. IP-literal targets need no
resolver at all. This is what lets a plugin (sandboxes) apply the floor without importing the
runtime.
