// The always-on secrets diagnostics the assembly owns: collecting plugin declarations into the
// required-names set, and the warn-only boot coverage probe over the one-door reader. Diagnostics,
// not management — resolution itself is proved in secret-providers/secrets-wiring tests.

import { buildSecrets, env } from "@euroclaw/secrets";
import { describe, expect, it } from "vitest";
import {
	collectSecretDeclarations,
	type SecretBootWarning,
	validateSecretsAtBoot,
} from "../src/index";

describe("collectSecretDeclarations", () => {
	it("dedupes by name across plugins — the first declaration keeps its description", () => {
		const declarations = collectSecretDeclarations([
			{ id: "a", secrets: { expects: [{ name: "X", description: "first" }] } },
			{
				id: "b",
				secrets: {
					expects: [{ name: "X", description: "second" }, { name: "Y" }],
				},
			},
			{ id: "c" },
		]);
		expect(declarations).toEqual([
			{ name: "X", description: "first" },
			{ name: "Y" },
		]);
	});
});

describe("validateSecretsAtBoot — warn-only coverage", () => {
	it("warns on an unresolvable declared name; a resolvable one is covered", async () => {
		const providers = [
			env({
				vars: { DIRECT_HIT: "v", BACKEND: "b" },
				aliases: { INLINE_NAME: "BACKEND" },
			}),
		];
		const warnings: SecretBootWarning[] = [];
		await validateSecretsAtBoot({
			declarations: [
				{ name: "DIRECT_HIT" }, // resolves directly → covered
				{ name: "INLINE_NAME" }, // resolves via the provider's alias remap → covered
				{ name: "UNRESOLVABLE" }, // resolves nowhere → coverage warning
				{ name: "UNRESOLVABLE" }, // duplicate declaration → still one warning
			],
			secrets: buildSecrets(providers),
			warn: (w) => warnings.push(w),
		});
		expect(warnings).toMatchObject([
			{ kind: "coverage", name: "UNRESOLVABLE" },
		]);
	});
});
