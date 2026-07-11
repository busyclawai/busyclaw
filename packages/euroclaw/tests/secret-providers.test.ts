// Plugins can contribute secret PROVIDERS (resolvers, never values) via the declared
// `plugin.secrets.providers` field. The assembly reads them STATICALLY off the raw plugin list and
// merges them into the same one-door reader every subsystem resolves through, over the assembly's
// zero-config `[env()]` base. This proves: a plugin provider resolves via the one door; a duplicate
// name across the chain fails loud; and the env base survives a GENERIC plugin contribution (the
// secrets() base-owner, which replaces env, is covered in the secrets-plugin tests).
// See docs/plans/secrets-provider-registry.md § Providers from plugins.

import type {
	EuroclawPlugin,
	SecretProvider,
	Secrets,
} from "@euroclaw/contracts";
import { env } from "@euroclaw/secrets";
import { secrets } from "@euroclaw/secrets-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaw } from "../src/index";
import { textModel } from "./fixtures";

/** A get-only stub provider that resolves one known ref to a token; everything else is a miss. */
function stubProvider(overrides: Partial<SecretProvider> = {}): SecretProvider {
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
			secrets: { providers: [stubProvider()] },
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

	it("(2) a duplicate provider name across the secrets() base and a plugin fails loud", () => {
		// secrets([env()]) contributes "env"; a generic plugin reuses that name → buildSecrets rejects it.
		expect(() =>
			createClaw({
				model: textModel("done"),
				plugins: [
					secrets([env()]),
					{
						id: "dup-provider",
						secrets: { providers: [stubProvider({ name: "env" })] },
					},
				],
			}),
		).toThrow(/duplicate secret provider name/);
	});

	it("(3) with no secrets() base plugin: the env default AND a generic plugin provider both resolve", async () => {
		vi.stubEnv("ENV_BACKED", "from-env");
		const capture = captureSecrets();
		const providerPlugin: EuroclawPlugin = {
			id: "stub-provider",
			secrets: { providers: [stubProvider()] },
		};

		// No base-owner plugin ⇒ the assembly's `[env()]` base stays; a generic plugin's providers ADD.
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

	it("(4) zero config: the assembly's env base resolves with no secrets plugin at all", async () => {
		vi.stubEnv("ZERO_CONF", "from-env");
		const capture = captureSecrets();
		createClaw({ model: textModel("done"), plugins: [capture.plugin] });
		expect(await capture.read().get("ZERO_CONF")).toEqual({
			kind: "token",
			value: "from-env",
		});
	});

	it("(5) secrets([provider]) REPLACES the env base — its provider reaches the chain, env does not", async () => {
		vi.stubEnv("ENV_ONLY", "from-process-env");
		const capture = captureSecrets();
		createClaw({
			model: textModel("done"),
			plugins: [secrets([stubProvider()]), capture.plugin],
		});
		const reader = capture.read();
		// the secrets() base provider reaches the one-door chain
		expect(await reader.get("STUB_SECRET")).toEqual({
			kind: "token",
			value: "stub-token",
		});
		// …and env is REPLACED — a process.env-only name no longer resolves
		expect(await reader.get("ENV_ONLY")).toBeNull();
	});

	it("(6) secrets([env(), provider]) keeps env explicitly alongside the base provider", async () => {
		vi.stubEnv("ENV_ONLY", "from-process-env");
		const capture = captureSecrets();
		createClaw({
			model: textModel("done"),
			plugins: [secrets([env(), stubProvider()]), capture.plugin],
		});
		const reader = capture.read();
		expect(await reader.get("ENV_ONLY")).toEqual({
			kind: "token",
			value: "from-process-env",
		});
		expect(await reader.get("STUB_SECRET")).toEqual({
			kind: "token",
			value: "stub-token",
		});
	});
});
