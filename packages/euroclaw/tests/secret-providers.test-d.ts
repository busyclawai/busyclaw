// Type tests (vitest typecheck mode). A passing run means the `@ts-expect-error` produced the
// intended compile-time error — `SecretProviderPlugin` requires a NON-EMPTY `secrets.providers`, and a
// valid one stays assignable to the base `EuroclawPlugin` (an intersection, not a union, so the
// plugin list stays homogeneous). See docs/plans/secrets-provider-registry.md § Providers from plugins.
import type {
	EuroclawPlugin,
	SecretProvider,
	SecretProviderPlugin,
} from "@euroclaw/contracts";
import { describe, test } from "vitest";

declare const provider: SecretProvider;

describe("SecretProviderPlugin", () => {
	test("an empty secrets.providers is a type error — a provider plugin must provide something", () => {
		// @ts-expect-error — secrets.providers must be a non-empty tuple
		const bad: SecretProviderPlugin = { id: "bad", secrets: { providers: [] } };
		void bad;
	});

	test("a non-empty provider plugin assigns to EuroclawPlugin", () => {
		const good: SecretProviderPlugin = {
			id: "good",
			secrets: { providers: [provider] },
		};
		// Assignable to the base — the container field stays optional/wide.
		const asBase: EuroclawPlugin = good;
		void asBase;
	});
});
