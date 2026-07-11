// The secrets USABILITY layer the assembly owns: collecting plugin declarations, and the boot
// coverage validation. Resolution itself lives in @euroclaw/secrets (buildSecrets, wired in
// index.ts). See docs/plans/secrets-provider-registry.md.

import type {
	EuroclawPlugin,
	SecretDeclaration,
	Secrets,
} from "@euroclaw/contracts";

/**
 * Collect the required-secret-name declarations across all plugins into a deduped set (first plugin
 * to declare a name keeps its description). Always-on — needs no table.
 */
export function collectSecretDeclarations(
	plugins: readonly EuroclawPlugin[],
): SecretDeclaration[] {
	const byName = new Map<string, SecretDeclaration>();
	for (const plugin of plugins) {
		for (const declaration of plugin.secrets ?? []) {
			if (!byName.has(declaration.name))
				byName.set(declaration.name, declaration);
		}
	}
	return [...byName.values()];
}

/** A boot warning — surfaced (never thrown): a name may still be configured later at runtime. */
export type SecretBootWarning = {
	kind: "coverage";
	name: string;
	message: string;
};

export type ValidateSecretsAtBootInput = {
	/** The collected required-secret names (plugin declarations). */
	declarations: readonly SecretDeclaration[];
	/** The one-door reader — probes resolvability (`has`) across the whole provider chain. */
	secrets: Secrets;
	/** Where warnings go. Defaults to console.warn in the assembly's fire-and-forget boot call. */
	warn?: (warning: SecretBootWarning) => void;
};

/**
 * Boot validation — warn-only, NEVER fails boot (createClaw fires it fire-and-forget). One check:
 * **coverage** — a declared name that resolves NOWHERE (no provider in the chain has a value for
 * it). "Configure a provider or set the env var." Diagnostics only, not management.
 */
export async function validateSecretsAtBoot(
	input: ValidateSecretsAtBootInput,
): Promise<SecretBootWarning[]> {
	const warnings: SecretBootWarning[] = [];
	const emit = (warning: SecretBootWarning): void => {
		warnings.push(warning);
		input.warn?.(warning);
	};

	// coverage — walk the deduped declared names.
	const seenName = new Set<string>();
	for (const declaration of input.declarations) {
		if (seenName.has(declaration.name)) continue;
		seenName.add(declaration.name);
		if (!(await input.secrets.has(declaration.name))) {
			emit({
				kind: "coverage",
				name: declaration.name,
				message: `secret "${declaration.name}" is unresolvable — no provider in the chain has a value for it. Configure a provider or set the env var.`,
			});
		}
	}

	return warnings;
}
