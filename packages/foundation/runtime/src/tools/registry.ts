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
// (packages/busyclaw/src/registry.ts) — runtime may not depend on @busyclaw/vendors; runtime exports
// only this flow and the domain-verb action constant.

import {
	type AuthzChangeStore,
	asPrincipal,
	configurationError,
	type JsonObject,
	jsonObject,
	type PolicySliceStore,
	type RegisteredToolStore,
	type SourceDiagnostic,
	type SpecRegistrationStore,
	type ToolGovernance,
	validationError,
} from "@busyclaw/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import {
	assertCredentialBindingUnchanged,
	type CredentialBinding,
	credentialBindingOf,
} from "./credential-binding";
import { toolsFromOpenApi } from "./sources/openapi";
import {
	egressPolicySliceName,
	generateEgressPolicy,
} from "./spec-egress-policy";

/** The slug is the address prefix; dots are reserved as the `<source>.<tool>` separator. */
const SOURCE_SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_MAX_DOCUMENT_BYTES = 5_000_000;

/**
 * The action GROUP every operation from one registration belongs to — how a policy names "everything
 * this spec brought in" without enumerating it.
 *
 * Namespaced under `source:` for the reason the extractor already namespaces tags under `tag:`: a
 * document's own vocabulary must not be able to claim a meaning the system assigns. `tag:` stops an
 * uploaded spec claiming `writes`; `source:` stops it claiming membership of a source it was not
 * registered as. The two prefixes cannot collide with each other or with a semantic group.
 *
 * Stamped at REGISTRATION rather than extraction, because the source is not a property of the
 * document. The same file registered twice under two names is two sources, and an extractor that
 * knew the name would be reading a fact it was never given. `SOURCE_SLUG` keeps the result
 * Cedar-safe with no sanitizing.
 *
 * ONE function because the group name has two readers that must agree: the row's governance (here)
 * and the generated egress ceiling that names the group in policy text. A drift between them is a
 * policy that silently matches nothing.
 */
export function sourceActionGroup(source: string): string {
	return `source:${source}`;
}

export type SpecRegistrationInput = {
	scope: string;
	scopeId: string;
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
 * not depend on @busyclaw/authz; the assembly hands this to buildAuthzModel, where AuthzActionInput
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
/** The stores a registration writes through — and, when the adapter can, a way to write them as one. */
export type SpecRegistryStores = {
	specRegistrations: SpecRegistrationStore;
	registeredTools: RegisteredToolStore;
	authzChanges?: AuthzChangeStore;
	/** Where the generated egress CEILING is written. Optional like `authzChanges`: a caller with only
	 *  the two tool stores registers exactly as it did before, and gets no ceiling. */
	policySlices?: PolicySliceStore;
	/** Rebinds these stores to a transaction. Absent ⇒ the adapter has none, and the work runs
	 *  unwrapped exactly as it did before. */
	transaction?: <R>(
		fn: (stores: SpecRegistryStores) => Promise<R>,
	) => Promise<R>;
};

export function createSpecRegistry(
	stores: SpecRegistryStores,
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

			// One row per address is this flow's own invariant — the diff below tells rows apart by
			// address, and the address IS the Cedar action id, so a repeat would leave a policy naming
			// it governing whichever row won. Extraction owns the untrusted document (the OpenAPI
			// source reports a colliding operationId into `skipped` and keeps the first), so a repeat
			// arriving HERE is a SOURCE breaking its output contract: code, like the plugin-tool
			// collisions that throw, not the org data the per-run merge skips. Loud, before any write.
			const seen = new Set<string>();
			for (const tool of extraction.tools) {
				const address = `${input.source}.${tool.name}`;
				if (seen.has(address)) {
					throw configurationError(
						"duplicate registered tool address in one extraction",
						{ address, source: input.source },
					);
				}
				seen.add(address);
			}

			// EVERY write below is one unit when the adapter can give us one. A registration inserts,
			// updates and DELETES tool rows, replaces the spec row, and appends the change that bumps
			// the org's bundle version — and a crash between the rows and the append leaves the surface
			// changed while the router keeps serving a bundle that still names a tool the spec removed.
			// The fail-closed delete stops being fail-closed until something unrelated bumps the version.
			return stores.transaction
				? stores.transaction((tx) => writeRegistration(tx))
				: writeRegistration(stores);

			async function writeRegistration(
				txStores: SpecRegistryStores,
			): Promise<SpecRegistrationReport> {
				const existing = await txStores.registeredTools.listBySource(
					{ scope: input.scope, scopeId: input.scopeId },
					input.source,
				);
				const priorByAddress = new Map(
					existing.map((row) => [row.address, row]),
				);

				// WHERE each operation's credential may go — derived from the freshly extracted bindings and
				// checked against what the source already had, ENTIRELY before the first write. A spec that
				// moves one operation's origin must leave the whole registration untouched: half-applying it
				// would delete rows and rotate others while the caller reads a thrown error.
				const credentialBindings = new Map<string, CredentialBinding>();
				// R-H05. The origins this SOURCE has already had approved — the union across its rows.
				//
				// Origin continuity was checked per OPERATION ADDRESS, and a new address has no prior
				// row, so nothing was checked at all: an updated spec could add an operation (or rename
				// one, which is the same thing) carrying its own `servers:` entry, and that origin was
				// recorded as approved on first sight. The credential, meanwhile, is resolved by SOURCE
				// — so the next invocation fetched the existing source credential and sent it to an
				// origin nobody approved. Renaming was the quiet version: the old row is deleted and the
				// new one is a first sighting.
				//
				// Where a credential may go is a property of the CREDENTIAL, not of whichever operations
				// happen to exist when a spec is uploaded. The first registration establishes the set;
				// later ones may rearrange operations within it and may not extend it.
				const approvedOrigins = new Set(
					existing.map((row) => row.credentialOrigin),
				);
				for (const tool of extraction.tools) {
					const address = `${input.source}.${tool.name}`;
					// Throws when the spec names no server: an operation with no approvable destination must
					// not become a row, because a row with no pinned origin is one whose credential could
					// later be sent anywhere.
					const next = credentialBindingOf(tool.binding, {
						source: input.source,
						address,
					});
					const prior = priorByAddress.get(address);
					// A re-registration may rotate anything about an operation EXCEPT where its credential
					// goes and how it is placed.
					if (prior) {
						assertCredentialBindingUnchanged(prior, next, {
							source: input.source,
							address,
						});
					} else if (
						existing.length > 0 &&
						!approvedOrigins.has(next.credentialOrigin)
					) {
						// A NEW operation on an ESTABLISHED source. It may live at any origin the source
						// already reaches; it may not introduce one. `existing.length > 0` is what makes
						// the first registration the approval rather than a check against nothing.
						throw configurationError(
							"registered spec adds an operation at an origin this source has not approved",
							{
								source: input.source,
								address,
								origin: next.credentialOrigin,
								approvedOrigins: [...approvedOrigins],
							},
						);
					}
					credentialBindings.set(address, next);
				}
				/** Present for every extracted address — the pre-pass above filled the map. */
				const requireCredentialBinding = (
					address: string,
				): CredentialBinding => {
					const binding = credentialBindings.get(address);
					if (!binding) {
						throw configurationError(
							"registered tool has no credential binding",
							{ address, source: input.source },
						);
					}
					return binding;
				};

				const added: string[] = [];
				const updated: string[] = [];
				const perRowVersions: string[] = [];

				for (const tool of extraction.tools) {
					const address = `${input.source}.${tool.name}`;
					// The source group joins the extractor's own groups here, BEFORE the content version
					// is taken. Stamping it after would leave the version blind to it: rows registered
					// before this existed would hash identically, the update branch would skip them, and
					// they would sit ungrouped until something unrelated changed the operation. A
					// governance fact the version cannot see is one a re-registration cannot repair.
					const governance = {
						...tool.governance,
						groups: [
							...new Set([
								...(tool.governance.groups ?? []),
								sourceActionGroup(input.source),
							]),
						].sort(),
					};
					const version = toolContentVersion({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
						governance,
						binding: tool.binding,
					});
					perRowVersions.push(version);
					// governance flows through TYPED — the registry column is schema-first
					// (`field.json(toolGovernance)`), so the store's input schema validates it; only the
					// format-opaque binding still needs the explicit JSON-safety gate before storage.
					const binding = asJsonObject(tool.binding, "registered tool binding");
					const prior = priorByAddress.get(address);
					const credentialBinding = requireCredentialBinding(address);
					// Flat literals — the store's entity schemas drop undefined-valued keys, so an
					// absent description stays absent without conditional spreads here.
					if (!prior) {
						await txStores.registeredTools.create({
							scope: input.scope,
							scopeId: input.scopeId,
							source: input.source,
							name: tool.name,
							address,
							description: tool.description,
							inputSchema: tool.inputSchema,
							governance: governance,
							binding,
							...credentialBinding,
							contentVersion: version,
						});
						added.push(address);
					} else if (prior.contentVersion !== version) {
						await txStores.registeredTools.update(prior.id, {
							name: tool.name,
							address,
							description: tool.description,
							inputSchema: tool.inputSchema,
							governance: governance,
							binding,
							...credentialBinding,
							contentVersion: version,
						});
						updated.push(address);
					}
				}

				// Fail-closed: an operation gone from the spec loses its row (and thus its permission).
				const removed: string[] = [];
				for (const row of existing) {
					if (!seen.has(row.address)) {
						await txStores.registeredTools.deleteById(row.id);
						removed.push(row.address);
					}
				}

				const contentVersion = hashHex(
					stableStringify([...perRowVersions].sort()),
				);

				// The generated egress CEILING, written inside the same unit as the rows it describes.
				// Outside it, a crash between the two leaves rows governed by a ceiling for a spec that
				// no longer exists — the fail-closed delete above stops being fail-closed.
				//
				// Origins come from the credential bindings computed in the pre-pass, which is the SAME
				// `normalizeOrigin(binding.server)` the floor stamps `context.server` from. The ceiling
				// and the fact it tests cannot disagree about where an operation reaches.
				const ceilingWarnings: SourceDiagnostic[] = [];
				if (txStores.policySlices) {
					const sliceName = egressPolicySliceName(input.source);
					const cedar = generateEgressPolicy({
						source: input.source,
						operations: [...credentialBindings].map(([address, binding]) => ({
							address,
							origin: binding.credentialOrigin,
						})),
					});
					const managedBy = `spec:${input.source}`;
					const priorSlice = (
						await txStores.policySlices.listForScope({
							scope: input.scope,
							scopeId: input.scopeId,
						})
					).find((slice) => slice.name === sliceName);

					if (priorSlice && priorSlice.managedBy !== managedBy) {
						// DETACHED (or a name a person claimed first). The row is theirs now, so the
						// generator does not touch it — but silence here would be the same overwrite with
						// extra steps: what the operator needs to know is that the ceiling they own no
						// longer follows the spec it was generated from. Say it where they are standing,
						// in the report of the registration that caused the divergence.
						ceilingWarnings.push({
							subject: sliceName,
							reason:
								`the egress ceiling "${sliceName}" is detached (managedBy ${priorSlice.managedBy ?? "unset"}), so this registration did not regenerate it — ` +
								"it may now permit or refuse origins this spec no longer declares",
						});
					} else if (cedar !== undefined) {
						await txStores.policySlices.upsert({
							scope: input.scope,
							scopeId: input.scopeId,
							name: sliceName,
							cedar,
							// `enforce`, not `shadow`: the ceiling restates the origin invariant this very
							// flow already enforces on the rows, so it cannot refuse a call the invoker
							// would have allowed. Shadow-first is for generated PERMITS, and there are none.
							mode: "enforce",
							plane: "tool",
							managedBy,
							updatedBy: asPrincipal(input.registeredBy),
						});
					} else if (priorSlice) {
						// The spec extracted nothing this time. Its ceiling described operations that are
						// gone, so it goes with them — a ceiling outliving the thing it bounded is a rule
						// nobody can trace back to a source.
						await txStores.policySlices.delete(
							{ scope: input.scope, scopeId: input.scopeId },
							priorSlice.id,
						);
					}
				}

				const report = {
					added,
					updated,
					removed,
					skipped: extraction.skipped,
					warnings: [...extraction.warnings, ...ceilingWarnings],
				};
				await txStores.specRegistrations.upsert({
					scope: input.scope,
					scopeId: input.scopeId,
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
				await txStores.authzChanges?.append({
					scope: input.scope,
					scopeId: input.scopeId,
					kind: "spec_registered",
					summary: { source: input.source, contentVersion },
					by: asPrincipal(input.registeredBy),
				});

				return { ...report, contentVersion };
			}
		},
	};
}
