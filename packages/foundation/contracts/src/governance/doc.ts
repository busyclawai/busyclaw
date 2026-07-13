// The euroclaw doc META CHANNEL (docs/plans/claw-client-plan.md, final doc-channel amendment).
// `.describe()` stays dual-use in arktype — validation error text + terse summary — so schema
// documentation that DIVERGES from the error message rides the NAMESPACED meta key
// `{ euroclaw: { doc } }`, authored as plain typed `.configure({ euroclaw: { doc } })` through the
// global ArkEnv augmentation below (`euroclaw` as the key name is what makes global merging safe:
// the collision hazard was an ownerless key). Every doc consumer reads through the ONE `docOf`
// below — per-consumer readers would drift. This module is BARREL-ONLY on purpose: the wire
// subpaths (`./claw-api`, `./governance/endpoints`) never load it, so the augmentation ships with
// server-side consumers and stays out of the client's module graph.

declare global {
	interface ArkEnv {
		meta(): {
			/** euroclaw's documentation channel — read by doc consumers (OpenAPI, CLI help,
			 *  tool catalog) via `docOf`; never part of validation error messages.
			 *  ADDITIVE-ONLY across euroclaw versions: mixed-version node_modules trees merge
			 *  these declarations, so a key may gain siblings but never change shape. */
			euroclaw?: { doc?: string };
		};
	}
}

/** What `docOf` reads, structurally — any arktype Type fits (its `meta` bag carries USER-AUTHORED
 *  keys only: `{}` when nothing was configured) without this module importing arktype. */
export type DocSource = {
	readonly meta?: {
		readonly description?: string;
		readonly euroclaw?: { readonly doc?: string };
	};
};

/**
 * The ONE doc reader, precedence built in: the rich `euroclaw.doc` channel wins, the `.describe()`
 * text is the fallback summary, and `undefined` means the schema carries no user-authored prose.
 * Reads `meta.description` (authored), never `Type.description` — arktype SYNTHESIZES the latter
 * from the type structure ("a string"), which is error-message rendering, not documentation.
 * Accepts unknown alongside the structural shape because route tables type their validators as
 * loose callables; a value carrying no meta simply reads as undocumented.
 */
export function docOf(source: DocSource | unknown): string | undefined {
	if (source === null) return undefined;
	if (typeof source !== "object" && typeof source !== "function") {
		return undefined;
	}
	const { meta } = source as DocSource;
	if (meta === null || typeof meta !== "object") return undefined;
	const doc = meta.euroclaw?.doc;
	if (typeof doc === "string") return doc;
	return typeof meta.description === "string" ? meta.description : undefined;
}
