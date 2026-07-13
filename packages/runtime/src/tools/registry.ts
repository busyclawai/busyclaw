// createSpecRegistry — the governed OpenAPI registration flow. An uploaded document becomes an
// organization's governed tool surface: extract (slice 4) → address + content-hash each operation →
// DIFF against the stored rows (added insert, changed update, REMOVED operations delete — fail
// closed: a tool that vanished from the spec must stop being permitted) → persist the raw blob +
// report + content version. Rebuild-on-registration is content-keyed: a registration changes the
// content version, and the next decision's router miss rebuilds the org's bundle (no event bus).
//
// Slug regex + size cap run BEFORE extraction: the slug keeps addresses collision-safe (dots are
// the address separator), and the byte cap is the upload bound the extractor's node budget assumes.
// The authored, agent-facing register_openapi_spec TOOL lives in the assembly package
// (packages/euroclaw/src/registry.ts) — runtime may not depend on @euroclaw/vendors; runtime exports
// only this flow and the domain-verb action constant.

import {
	asPrincipal,
	type AuthzChangeStore,
	type JsonObject,
	jsonObject,
	type RegisteredToolStore,
	type SourceDiagnostic,
	type SpecRegistrationStore,
	type ToolGovernance,
	validationError,
} from "@euroclaw/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import { toolsFromOpenApi } from "./sources/openapi";

/** The slug is the address prefix; dots are reserved as the `<source>.<tool>` separator. */
const SOURCE_SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_MAX_DOCUMENT_BYTES = 5_000_000;

export type SpecRegistrationInput = {
	organizationId: string;
	/** Address prefix; must match /^[a-z][a-z0-9-]{0,63}$/ (dots are the address separator). */
	source: string;
	document: JsonObject;
	registeredBy: string;
};

export type SpecRegistrationReport = {
	/** Addresses (`<source>.<tool>`) inserted this registration. */
	added: string[];
	updated: string[];
	/** Addresses whose rows were DELETED (operation gone from the spec — fail-closed). */
	removed: string[];
	/** Operations extraction did NOT turn into tools, verbatim from the extractor. */
	skipped: SourceDiagnostic[];
	/** Operations extracted with a caveat, verbatim from the extractor. */
	warnings: SourceDiagnostic[];
	contentVersion: string;
};

export type SpecRegistryOptions = {
	/** Upload byte bound (JSON string length). Default 5_000_000. */
	maxDocumentBytes?: number;
};

export type SpecRegistry = {
	registerOpenApiSpec: (
		input: SpecRegistrationInput,
	) => Promise<SpecRegistrationReport>;
};

/**
 * The governed registration verb as an authz action input — typed STRUCTURALLY because runtime does
 * not depend on @euroclaw/authz; the assembly hands this to buildAuthzModel, where AuthzActionInput
 * is enforced. "Who may register" is a policy over this action, never a code path.
 */
export const REGISTER_OPENAPI_SPEC_ACTION: {
	id: string;
	source: "domain";
	governance: { access: "write"; groups: string[] };
} = {
	id: "register_openapi_spec",
	source: "domain",
	governance: { access: "write", groups: ["registry"] },
};

const hashHex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/** Deterministic stringify: object keys sorted recursively so key order never changes the hash. */
function stableStringify(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			out[key] = sortDeep(entry);
		}
		return out;
	}
	return value;
}

/** Validate a produced value is JSON-safe before it becomes a stored column (fail loud, never cast). */
function asJsonObject(value: unknown, label: string): JsonObject {
	const valid = jsonObject(value);
	if (valid instanceof type.errors) {
		throw validationError(`${label} is not a JSON object`, valid.summary);
	}
	return valid;
}

/** The per-row content hash — the diff key: schema/governance/binding/description of one tool. */
function toolContentVersion(input: {
	name: string;
	description: string | undefined;
	inputSchema: JsonObject;
	governance: ToolGovernance;
	binding: unknown;
}): string {
	return hashHex(
		stableStringify({
			name: input.name,
			description: input.description,
			inputSchema: input.inputSchema,
			governance: input.governance,
			binding: input.binding,
		}),
	);
}

/** Back the registration flow with the registry stores it writes through. `authzChanges` is optional
 *  so callers with only the two tool stores still work; when present, each registration appends a
 *  `spec_registered` event that bumps the org router's count-keyed bundle version (slice 6b). */
export function createSpecRegistry(
	stores: {
		specRegistrations: SpecRegistrationStore;
		registeredTools: RegisteredToolStore;
		authzChanges?: AuthzChangeStore;
	},
	options: SpecRegistryOptions = {},
): SpecRegistry {
	const maxDocumentBytes =
		options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;

	return {
		async registerOpenApiSpec(input) {
			if (!SOURCE_SLUG.test(input.source)) {
				throw validationError(
					"invalid registration source",
					`source must match ${SOURCE_SLUG} (dots are the address separator)`,
					{ source: input.source },
				);
			}
			// Size cap precedes extraction — the upload bound the extractor's node budget assumes.
			const bytes = JSON.stringify(input.document).length;
			if (bytes > maxDocumentBytes) {
				throw validationError(
					"registration document too large",
					`document is ${bytes} bytes, over the ${maxDocumentBytes} cap`,
					{ bytes, maxDocumentBytes },
				);
			}

			// Throws validationError itself on a non-3.x document.
			const extraction = toolsFromOpenApi(input.document);

			const existing = await stores.registeredTools.listBySource(
				input.organizationId,
				input.source,
			);
			const priorByAddress = new Map(existing.map((row) => [row.address, row]));

			const added: string[] = [];
			const updated: string[] = [];
			const seen = new Set<string>();
			const perRowVersions: string[] = [];

			for (const tool of extraction.tools) {
				const address = `${input.source}.${tool.name}`;
				seen.add(address);
				const version = toolContentVersion({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
					governance: tool.governance,
					binding: tool.binding,
				});
				perRowVersions.push(version);
				// governance flows through TYPED — the registry column is schema-first
				// (`field.json(toolGovernance)`), so the store's input schema validates it; only the
				// format-opaque binding still needs the explicit JSON-safety gate before storage.
				const binding = asJsonObject(tool.binding, "registered tool binding");
				const prior = priorByAddress.get(address);
				// Flat literals — the store's entity schemas drop undefined-valued keys, so an
				// absent description stays absent without conditional spreads here.
				if (!prior) {
					await stores.registeredTools.create({
						organizationId: input.organizationId,
						source: input.source,
						name: tool.name,
						address,
						description: tool.description,
						inputSchema: tool.inputSchema,
						governance: tool.governance,
						binding,
						contentVersion: version,
					});
					added.push(address);
				} else if (prior.contentVersion !== version) {
					await stores.registeredTools.update(prior.id, {
						name: tool.name,
						address,
						description: tool.description,
						inputSchema: tool.inputSchema,
						governance: tool.governance,
						binding,
						contentVersion: version,
					});
					updated.push(address);
				}
			}

			// Fail-closed: an operation gone from the spec loses its row (and thus its permission).
			const removed: string[] = [];
			for (const row of existing) {
				if (!seen.has(row.address)) {
					await stores.registeredTools.deleteById(row.id);
					removed.push(row.address);
				}
			}

			const contentVersion = hashHex(
				stableStringify([...perRowVersions].sort()),
			);
			const report = {
				added,
				updated,
				removed,
				skipped: extraction.skipped,
				warnings: extraction.warnings,
			};
			await stores.specRegistrations.upsert({
				organizationId: input.organizationId,
				source: input.source,
				specBlob: input.document,
				contentVersion,
				// Typed through — the report column is schema-first (`field.json(specRegistrationReport)`),
				// so the store's input schema validates the shape; no JSON-laundering needed.
				report,
				registeredBy: input.registeredBy,
			});
			// A registration is an authz-state change — append so the org router's count-keyed bundle
			// version bumps and the newly registered surface takes effect on the next decision.
			await stores.authzChanges?.append({
				organizationId: input.organizationId,
				kind: "spec_registered",
				summary: { source: input.source, contentVersion },
				by: asPrincipal(input.registeredBy),
			});

			return { ...report, contentVersion };
		},
	};
}
