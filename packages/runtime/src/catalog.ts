// The tool catalog read-path: a traversable tree + scoped search + describe,
// projected from framework-neutral ToolEntry rows. The tree is NOT stored —
// `list(path)` groups entries by the next address segment, so the hierarchy is
// derived from each tool's dotted address (`<source>.<…>.<tool>`), variable
// depth. A 200-tool provider narrows: list() -> sources, list("github") ->
// resources, list("github.issues") -> operations. See docs/plans/tools-plan.md.
//
// Catalog access is VISIBILITY, not authorization: listing or searching a tool
// never permits calling it — every call still routes through the governance
// chokepoint (handleToolCall). tools-plan.md invariant #8.

import { validationError } from "@euroclaw/contracts";
import { type } from "arktype";

const ADDRESS_SEP = ".";

/** A tool's place in the catalog — a dotted path, variable depth.
 *  e.g. "github.issues.create", "gmail.send", "fs.read". Derived, never stored. */
export type ToolAddress = string;

/** Coarse risk classification, projected from a tool's effect policy. Lets the
 *  catalog surface authority at a glance (the plan's "authority-summary"). */
export const toolRisk = type("'low' | 'medium' | 'high'");
export type ToolRisk = typeof toolRisk.infer;

/** A framework-neutral catalog row. Sources (host tools, MCP, OpenAPI, skills)
 *  adapt into this shape; validated at catalog construction (the trust
 *  boundary) and never importing a framework's tool type. */
export const toolEntry = type({
	address: "string",
	name: "string",
	"description?": "string",
	// Origin: "host" | "mcp" | "skill" | "capability" | <custom>.
	"source?": "string",
	"risk?": toolRisk,
	"inputSchema?": "unknown",
	"outputSchema?": "unknown",
});
export type ToolEntry = typeof toolEntry.infer;

/** Schema-LAZY summary — what list/search return. ToolEntry minus the schemas,
 *  so listing scales with tool count, not schema bytes. */
export const toolSummary = toolEntry.omit("inputSchema", "outputSchema");
export type ToolSummary = typeof toolSummary.infer;

/** Full detail — what describe() returns. Includes the schemas. */
export type ToolDetail = ToolEntry;

/** One node in a listed level: a subtree you can drill into, or a tool leaf. */
export type ToolNode =
	| {
			kind: "branch";
			address: ToolAddress;
			label: string;
			childCount: number;
	  }
	| { kind: "leaf"; address: ToolAddress; tool: ToolSummary };

export type ToolListing = {
	path: ToolAddress;
	children: readonly ToolNode[];
};

export type ToolDiscoveryOptions = {
	/** Scope the search to a subtree (e.g. "github.issues"). */
	path?: ToolAddress;
	/** Max results. Default 12. */
	limit?: number;
};

// ── Discovery seam ─────────────────────────────────────────────────────────

/** Pluggable discovery. v1 ships lexical; a semantic/vector provider slots in
 *  later (post-memory, reusing the Embedder port) behind this seam without the
 *  catalog changing. See tools-plan.md §5 and the retrieval target state. */
export type ToolDiscoveryProvider = {
	search: (
		entries: readonly ToolEntry[],
		query: string,
		opts: { readonly path: ToolAddress | undefined; readonly limit: number },
	) => readonly ToolSummary[];
};

const FIELD_WEIGHTS = { address: 8, name: 10, description: 5 } as const;

function tokenize(value: string): string[] {
	return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** address === path, OR address is nested under path (`path.<…>`). */
function isWithin(address: ToolAddress, path: ToolAddress): boolean {
	return address === path || address.startsWith(path + ADDRESS_SEP);
}

function countUnder(
	entries: readonly ToolEntry[],
	branchAddress: ToolAddress,
): number {
	const prefix = branchAddress + ADDRESS_SEP;
	let n = 0;
	for (const entry of entries) if (entry.address.startsWith(prefix)) n++;
	return n;
}

function scoreEntry(
	entry: ToolEntry,
	queryTokens: readonly string[],
): { score: number; matched: Set<string> } {
	const nameTokens = tokenize(entry.name);
	const addressTokens = tokenize(entry.address);
	const descTokens = entry.description ? tokenize(entry.description) : [];
	const matched = new Set<string>();
	let score = 0;
	const bump = (weight: number, tokens: readonly string[]): void => {
		for (const q of queryTokens) {
			if (tokens.includes(q)) {
				score += weight * 4;
				matched.add(q);
			} else if (q.length >= 2 && tokens.some((t) => t.startsWith(q))) {
				score += weight * 2;
				matched.add(q);
			} else if (tokens.some((t) => t.includes(q))) {
				score += weight;
				matched.add(q);
			}
		}
	};
	bump(FIELD_WEIGHTS.name, nameTokens);
	bump(FIELD_WEIGHTS.address, addressTokens);
	bump(FIELD_WEIGHTS.description, descTokens);
	return { score, matched };
}

function passesCoverage(matchedCount: number, queryCount: number): boolean {
	if (queryCount === 0) return true;
	if (queryCount <= 2) return matchedCount === queryCount;
	return matchedCount / queryCount >= 0.6;
}

/** The default discovery provider: lexical, in-memory, weighted with a coverage
 *  gate. No vector/index — swappable later. */
export const lexicalToolDiscovery: ToolDiscoveryProvider = {
	search(entries, query, opts) {
		// Ignore sub-2-char tokens — they over-match (a 1-char prefix hits almost
		// everything); the coverage gate + sort only partly mask it.
		const queryTokens = tokenize(query).filter((t) => t.length >= 2);
		if (queryTokens.length === 0) return [];
		const scopePath = opts.path;
		const scoped = scopePath
			? entries.filter((e) => isWithin(e.address, scopePath))
			: entries;
		const scored: { summary: ToolSummary; score: number }[] = [];
		for (const entry of scoped) {
			const { score, matched } = scoreEntry(entry, queryTokens);
			if (score > 0 && passesCoverage(matched.size, queryTokens.length)) {
				// Schema-lazy: drop the (multi-KB) schemas so results scale with
				// tool count, not schema bytes.
				const {
					inputSchema: _inputSchema,
					outputSchema: _outputSchema,
					...summary
				} = entry;
				scored.push({ summary, score });
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, opts.limit).map((s) => s.summary);
	},
};

function listChildren(
	entries: readonly ToolEntry[],
	path: ToolAddress,
): ToolNode[] {
	const prefix = path ? path + ADDRESS_SEP : "";
	const byKey = new Map<string, ToolNode>();
	for (const entry of entries) {
		if (path && entry.address === path) continue; // the parent itself is not its own child
		if (!entry.address.startsWith(prefix)) continue;
		const remainder = entry.address.slice(prefix.length);
		const segs = remainder.split(ADDRESS_SEP);
		const key = segs[0];
		if (key === undefined) continue;
		if (segs.length === 1) {
			const {
				inputSchema: _leafInput,
				outputSchema: _leafOutput,
				...tool
			} = entry;
			byKey.set(key, { kind: "leaf", address: entry.address, tool });
		} else if (!byKey.has(key)) {
			byKey.set(key, {
				kind: "branch",
				address: prefix + key,
				label: key,
				childCount: 0,
			});
		}
	}
	const nodes = [...byKey.values()];
	for (const node of nodes) {
		if (node.kind === "branch") {
			node.childCount = countUnder(entries, node.address);
		}
	}
	nodes.sort((a, b) => {
		// branches first (things to drill into), then leaves; alphabetical within.
		if (a.kind !== b.kind) return a.kind === "branch" ? -1 : 1;
		return a.kind === "branch"
			? a.label.localeCompare(b.kind === "branch" ? b.label : "")
			: a.tool.name.localeCompare(b.kind === "leaf" ? b.tool.name : "");
	});
	return nodes;
}

export type ToolCatalogOptions = {
	/** Discovery provider. Defaults to lexical. */
	discovery?: ToolDiscoveryProvider;
};

export type ToolCatalog = {
	/** Children one level below `path` (omit for the root). Branches sort before
	 *  leaves so the caller sees subtrees to drill into first. */
	list: (path?: ToolAddress) => ToolListing;
	/** Lexical (default) or semantic (later) retrieval, optionally scoped. */
	search: (
		query: string,
		opts?: ToolDiscoveryOptions,
	) => readonly ToolSummary[];
	/** Full detail for one tool, or null if unknown. */
	describe: (address: ToolAddress) => ToolDetail | null;
	/** Number of cataloged tools. */
	readonly size: number;
};

function validateAddresses(entries: readonly ToolEntry[]): void {
	const seen = new Set<string>();
	for (const entry of entries) {
		// Invariants the type can't express: non-empty address segments and
		// uniqueness. Row shape is TS-typed today; the arktype schema validates
		// it once untrusted MCP-sourced entries land.
		const segments = entry.address.split(ADDRESS_SEP);
		if (segments.some((s) => s.length === 0)) {
			throw validationError(
				`invalid tool address "${entry.address}" — non-empty segments, no leading/trailing dot`,
				"tool address must be non-empty dot-separated segments",
			);
		}
		if (seen.has(entry.address)) {
			throw validationError(
				`duplicate tool address "${entry.address}" — source-namespaced addresses must be unique`,
				"tool addresses must be unique within a catalog",
			);
		}
		seen.add(entry.address);
	}
}

export function createToolCatalog(
	entries: readonly ToolEntry[],
	opts?: ToolCatalogOptions,
): ToolCatalog {
	validateAddresses(entries);
	const rows = [...entries];
	const discovery = opts?.discovery ?? lexicalToolDiscovery;
	return {
		list: (path) => ({
			path: path ?? "",
			children: listChildren(rows, path ?? ""),
		}),
		search: (query, sopts) =>
			discovery.search(rows, query, {
				path: sopts?.path,
				limit: sopts?.limit ?? 12,
			}),
		describe: (address) => rows.find((e) => e.address === address) ?? null,
		get size() {
			return rows.length;
		},
	};
}

// ── Source adapters ────────────────────────────────────────────────────────

/** Minimal structural shape of an AI-SDK tool — kept structural so the catalog
 *  never imports the `ai` package. A real ToolSet satisfies this. */
type ToolSetLike = Record<
	string,
	{
		// v7 allows context-dependent description FUNCTIONS; the catalog is a static visibility
		// surface, so those render as absent rather than being invoked with a fabricated context.
		description?: string | ((...args: never[]) => string);
		inputSchema?: unknown;
		outputSchema?: unknown;
		euroclaw?: { effect?: { risk?: ToolRisk } };
	}
>;

/**
 * Adapt a host-native AI-SDK ToolSet into catalog entries. Host tools are FLAT
 * (address === name); structured, multi-segment addresses come from sourced
 * tools (MCP servers, OpenAPI tags, skill wrappers) which build their own
 * ToolEntry[] directly. This adapter is the bridge for the existing in-process
 * registry; it does not copy `execute` (the catalog is a read-path, not a
 * dispatcher — execution stays behind handleToolCall). `source` is "host";
 * `risk` is projected from the stamped governance (`govern`'s effect policy).
 */
export function toolEntriesFromToolSet(tools: ToolSetLike): ToolEntry[] {
	return Object.entries(tools).map(([name, t]) => ({
		address: name,
		name,
		source: "host",
		description:
			typeof t.description === "string" ? t.description : undefined,
		inputSchema: t.inputSchema,
		outputSchema: t.outputSchema,
		risk: t.euroclaw?.effect?.risk,
	}));
}
