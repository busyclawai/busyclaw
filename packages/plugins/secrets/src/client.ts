// The CLIENT half of `secrets(…, { store })` — shipped by the plugin that owns the server half,
// not by the client.
//
// It lived in the client's own `plugins` module, which meant the client imported a plugin it has
// no business knowing about, and that import survived into the client's published `.d.ts`: a
// consumer typechecking against the client alone could not resolve `@busyclaw/secrets-plugin`.
//
// A plugin ships its own client half. This is exactly how `@better-auth/stripe` is arranged — one
// package, `.` and `./client` — and it is why better-auth's own client never hears about stripe.
//
// PURE TYPE, zero runtime: the phantom carries the server plugin's `$Api` so `client.secrets.*` is
// typed even without `typeof claw`, and the calls themselves ride the client's convention proxy
// (`POST /secrets/set`, `POST /secrets/delete`, `GET /secrets/list` — verbs derived from the same
// name rule the server mounts with, so no `pathMethods` is needed).

import type { ClawClientPlugin } from "@busyclaw/contracts";
import type { SecretsStorePlugin } from "./index";

/**
 * Client half of the secrets store plugin. Pass it to `createClawClient({ plugins: [...] })`
 * alongside the server's `secrets(…, { store })` to type `client.secrets.*`.
 */
export function secretsClient() {
	return {
		id: "busyclaw.secrets",
		$InferServerPlugin: {} as SecretsStorePlugin,
	} satisfies ClawClientPlugin;
}
