// Plugins can contribute secret PROVIDERS (resolvers, never values) via the declared
// `plugin.secretProviders` field. The assembly reads them STATICALLY off the raw plugin list and
// merges them AFTER `config.secretProviders ?? [env()]`, into the same one-door reader every
// subsystem resolves through. This proves: a plugin provider resolves via the one door; a duplicate
// name across config + plugin fails loud; the env default survives a plugin contribution; and the
// per-org DB-alias layer still wins over a plugin-contributed provider's direct name.
// See docs/plans/secrets-provider-registry.md § Providers from plugins.

import type { EuroclawPlugin, SecretProvider, Secrets } from "@euroclaw/contracts";
import { env } from "@euroclaw/secrets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, textModel } from "./fixtures";

/** A get-only stub provider that resolves one known ref to a token; everything else is a miss. */
function stubProvider(
	overrides: Partial<SecretProvider> = {},
): SecretProvider {
	return {
		name: "stub",
		capability: { manage: false },
		get: async (ref) =>
			ref === "STUB_SECRET" ? { kind: "token", value: "stub-token" } : null,
		...overrides,
	};
}

/** Capture the one-door reader the assembly injects into a plugin's configure context. */
function captureSecrets(): { plugin: EuroclawPlugin; read: () => Secrets } {
	let received: Secrets | undefined;
	return {
		plugin: {
			id: "secrets-capture",
			configure: (context) => {
				received = context.secrets;
				return undefined;
			},
		},
		read: () => {
			if (received === undefined) throw new Error("configure never ran");
			return received;
		},
	};
}

describe("plugin-contributed secret providers (createClaw)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("(1) a plugin-contributed provider resolves via the one door", async () => {
		const capture = captureSecrets();
		const providerPlugin: EuroclawPlugin = {
			id: "stub-provider",
			secretProviders: [stubProvider()],
		};

		createClaw({
			model: textModel("done"),
			plugins: [providerPlugin, capture.plugin],
		});

		// The reader injected into configure sees the plugin's provider in its chain.
		expect(await capture.read().get("STUB_SECRET")).toEqual({
			kind: "token",
			value: "stub-token",
		});
	});

	it("(2) a duplicate provider name across config.secretProviders and a plugin fails loud", () => {
		// The plugin's provider reuses the config provider's name ("env") → buildSecrets rejects it.
		expect(() =>
			createClaw({
				model: textModel("done"),
				secretProviders: [env()],
				plugins: [
					{
						id: "dup-provider",
						secretProviders: [stubProvider({ name: "env" })],
					},
				],
			}),
		).toThrow(/duplicate secret provider name/);
	});

	it("(3) absent config.secretProviders: the env default AND a plugin provider both resolve", async () => {
		vi.stubEnv("ENV_BACKED", "from-env");
		const capture = captureSecrets();
		const providerPlugin: EuroclawPlugin = {
			id: "stub-provider",
			secretProviders: [stubProvider()],
		};

		// No `secretProviders` ⇒ `[env()]` default resolves BEFORE the plugin merge; both coexist.
		createClaw({
			model: textModel("done"),
			plugins: [providerPlugin, capture.plugin],
		});

		const reader = capture.read();
		expect(await reader.get("ENV_BACKED")).toEqual({
			kind: "token",
			value: "from-env",
		});
		expect(await reader.get("STUB_SECRET")).toEqual({
			kind: "token",
			value: "stub-token",
		});
	});

	it("(4) the per-org DB-alias layer wins over a plugin-contributed provider's direct name", async () => {
		const { db, redactor } = durableRedactor();
		const providerPlugin: EuroclawPlugin = {
			id: "stub-provider",
			secretProviders: [
				stubProvider({
					name: "stub",
					// Resolves the canonical name DIRECTLY — the fall-through path when no alias applies.
					get: async (ref) =>
						ref === "SOME_TOKEN"
							? { kind: "token", value: "from-plugin-direct" }
							: null,
				}),
			],
		};

		const claw = createClaw({
			model: textModel("ok"),
			database: db,
			redactor,
			dynamicSecretAliases: { enabled: true },
			secretProviders: [
				env({ source: { VAULT_BACKEND: "resolved-from-alias" } }),
			],
			plugins: [providerPlugin],
		});
		await claw.api.secrets.setAlias({
			organizationId: "org-a",
			name: "SOME_TOKEN",
			provider: "env",
			ref: "VAULT_BACKEND",
		});
		const reader = claw.$context.secrets;
		expect(reader).toBeDefined();

		// org-a has a DB alias → SOME_TOKEN routes to env's VAULT_BACKEND, NOT the plugin's direct value.
		expect(
			await reader?.get("SOME_TOKEN", { organizationId: "org-a" }),
		).toEqual({ kind: "token", value: "resolved-from-alias" });
		// org-b has no alias → the chain falls through and the plugin provider resolves the direct name,
		// proving the plugin provider really is in the merged chain.
		expect(
			await reader?.get("SOME_TOKEN", { organizationId: "org-b" }),
		).toEqual({ kind: "token", value: "from-plugin-direct" });
	});
});
