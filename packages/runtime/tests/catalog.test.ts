import { govern } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	createToolCatalog,
	lexicalToolDiscovery,
	type ToolEntry,
	toolEntriesFromTools,
} from "../src/catalog";

function e(
	address: string,
	name: string,
	description: string,
	extra?: Partial<ToolEntry>,
): ToolEntry {
	return { address, name, description, ...extra };
}

// A realistic mixed-depth catalog: github deep (3 levels), gmail/fs shallow
// (2 levels), and one flat root leaf.
const entries: ToolEntry[] = [
	e("github.issues.create", "create", "Open a new issue", {
		inputSchema: { type: "object", properties: { title: { type: "string" } } },
	}),
	e("github.issues.list", "list", "List issues in a repo"),
	e("github.issues.get", "get", "Get one issue"),
	e("github.issues.update", "update", "Edit an issue"),
	e("github.repos.list", "list", "List repositories"),
	e("github.repos.get", "get", "Get a repository"),
	e("github.repos.create", "create", "Create a repository"),
	e("github.pulls.list", "list", "List pull requests"),
	e("github.pulls.merge", "merge", "Merge a pull request"),
	e("gmail.send", "send", "Send an email message"),
	e("gmail.list", "list", "List email messages"),
	e("fs.read", "read", "Read a file"),
	e("fs.write", "write", "Write a file"),
	e("ping", "ping", "Health check"),
];

describe("tool catalog — tree traversal", () => {
	it("lists sources at the root (branches first, then leaves)", () => {
		const catalog = createToolCatalog(entries);
		const root = catalog.list();
		const branches = root.children.filter((c) => c.kind === "branch");
		const leaves = root.children.filter((c) => c.kind === "leaf");
		expect(branches.map((b) => (b.kind === "branch" ? b.label : ""))).toEqual([
			"fs",
			"github",
			"gmail",
		]);
		expect(leaves.map((l) => (l.kind === "leaf" ? l.tool.name : ""))).toEqual([
			"ping",
		]);
	});

	it("narrows a provider to its resources with child counts", () => {
		const catalog = createToolCatalog(entries);
		const github = catalog.list("github");
		const byLabel = new Map(
			github.children.map((c) => [c.kind === "branch" ? c.label : "", c]),
		);
		expect(github.children.every((c) => c.kind === "branch")).toBe(true);
		const issues = byLabel.get("issues");
		const repos = byLabel.get("repos");
		const pulls = byLabel.get("pulls");
		expect(issues?.kind === "branch" && issues.childCount).toBe(4);
		expect(repos?.kind === "branch" && repos.childCount).toBe(3);
		expect(pulls?.kind === "branch" && pulls.childCount).toBe(2);
	});

	it("narrows a resource to its operations (leaves, alphabetical)", () => {
		const catalog = createToolCatalog(entries);
		const issues = catalog.list("github.issues");
		expect(issues.children.every((c) => c.kind === "leaf")).toBe(true);
		expect(
			issues.children.map((c) => (c.kind === "leaf" ? c.tool.name : "")),
		).toEqual(["create", "get", "list", "update"]);
	});

	it("returns no children for a leaf address", () => {
		const catalog = createToolCatalog(entries);
		expect(catalog.list("github.issues.create").children).toEqual([]);
	});

	it("returns no children for an unknown path", () => {
		const catalog = createToolCatalog(entries);
		expect(catalog.list("nope").children).toEqual([]);
	});
});

describe("tool catalog — describe", () => {
	it("returns full detail (with schema) for a known tool", () => {
		const catalog = createToolCatalog(entries);
		const detail = catalog.describe("github.issues.create");
		expect(detail).not.toBeNull();
		expect(detail?.inputSchema).toMatchObject({
			type: "object",
			properties: { title: { type: "string" } },
		});
	});

	it("returns null for an unknown tool", () => {
		const catalog = createToolCatalog(entries);
		expect(catalog.describe("nope")).toBeNull();
	});

	it("list/search are schema-lazy (no inputSchema on summaries)", () => {
		const catalog = createToolCatalog(entries);
		const issues = catalog.list("github.issues");
		const leaf = issues.children.find(
			(c): c is Extract<(typeof issues.children)[number], { kind: "leaf" }> =>
				c.kind === "leaf" && c.tool.name === "create",
		);
		expect(leaf).toBeDefined();
		expect("inputSchema" in (leaf?.tool ?? {})).toBe(false);
	});
});

describe("tool catalog — search", () => {
	it("finds by intent across providers", () => {
		const catalog = createToolCatalog(entries);
		const results = catalog.search("email");
		expect(results.map((r) => r.address).sort()).toEqual([
			"gmail.list",
			"gmail.send",
		]);
	});

	it("scopes search to a subtree", () => {
		const catalog = createToolCatalog(entries);
		const results = catalog.search("list", { path: "github" });
		expect(results.map((r) => r.address).sort()).toEqual([
			"github.issues.list",
			"github.pulls.list",
			"github.repos.list",
		]);
	});

	it("searches globally when unscoped", () => {
		const catalog = createToolCatalog(entries);
		const results = catalog.search("list");
		expect(results.map((r) => r.address).sort()).toEqual([
			"github.issues.list",
			"github.pulls.list",
			"github.repos.list",
			"gmail.list",
		]);
	});

	it("returns nothing for a query with no coverage", () => {
		const catalog = createToolCatalog(entries);
		expect(catalog.search("zzzznotpresent")).toEqual([]);
	});

	it("respects the limit option", () => {
		const catalog = createToolCatalog(entries);
		expect(catalog.search("list", { limit: 2 }).length).toBe(2);
	});
});

describe("tool catalog — scale (lots of tools per provider)", () => {
	const big: ToolEntry[] = [];
	for (let r = 0; r < 20; r++) {
		for (let o = 0; o < 10; o++) {
			big.push(
				e(`big.r${r}.op${o}`, `op${o}`, `operation ${o} on resource ${r}`),
			);
		}
	}

	it("collapses 200 tools into one source at the root, then 20 resources, then 10 ops", () => {
		const catalog = createToolCatalog(big);
		expect(catalog.size).toBe(200);

		const root = catalog.list();
		expect(root.children).toHaveLength(1);
		const only = root.children[0];
		expect(only?.kind === "branch" && only.label).toBe("big");
		expect(only?.kind === "branch" && only.childCount).toBe(200);

		const resources = catalog.list("big");
		expect(resources.children).toHaveLength(20);
		expect(resources.children.every((c) => c.kind === "branch")).toBe(true);
		const r0 = resources.children[0];
		expect(r0?.kind === "branch" && r0.childCount).toBe(10);

		const ops = catalog.list("big.r0");
		expect(ops.children).toHaveLength(10);
		expect(ops.children.every((c) => c.kind === "leaf")).toBe(true);
	});
});

describe("tool catalog — construction guards", () => {
	it("rejects duplicate addresses", () => {
		expect(() =>
			createToolCatalog([
				e("github.issues.list", "list", "List issues"),
				e("github.issues.list", "list", "List issues again"),
			]),
		).toThrow(/duplicate tool address/);
	});

	it("rejects malformed addresses", () => {
		expect(() => createToolCatalog([e("github..issues", "x", "bad")])).toThrow(
			/invalid tool address/,
		);
		expect(() => createToolCatalog([e(".leading", "x", "bad")])).toThrow(
			/invalid tool address/,
		);
	});
});

describe("tool catalog — descriptor adapter", () => {
	it("adapts host descriptors to flat entries (address === name), carrying schema, omitting execute", () => {
		const entries = toolEntriesFromTools({
			send_email: govern(
				{
					description: "Send an email.",
					inputSchema: {
						type: "object",
						properties: { to: { type: "string" } },
					},
					execute: async () => ({}),
				},
				{ effect: { risk: "high" } },
			),
			ping: govern(
				{
					description: "Health check.",
					inputSchema: {},
					execute: async () => ({}),
				},
				{},
			),
		});
		expect(entries).toHaveLength(2);
		const byName = new Map(entries.map((en) => [en.name, en]));
		expect(byName.get("send_email")?.address).toBe("send_email");
		expect(byName.get("send_email")?.description).toBe("Send an email.");
		expect(byName.get("send_email")?.inputSchema).toMatchObject({
			type: "object",
		});
		expect(byName.get("send_email")?.source).toBe("host");
		expect(byName.get("send_email")?.risk).toBe("high");
		expect(byName.get("ping")?.source).toBe("host");
		expect(byName.get("ping")?.risk).toBeUndefined();
		// The catalog is a read-path, not a dispatcher — execute never crosses into it.
		for (const en of entries) expect("execute" in en).toBe(false);
	});

	it("the default catalog uses the lexical discovery provider", () => {
		// Sanity: lexicalToolDiscovery is exported and usable standalone.
		const results = lexicalToolDiscovery.search(entries, "merge", {
			path: undefined,
			limit: 5,
		});
		expect(results.map((r) => r.address)).toEqual(["github.pulls.merge"]);
	});
});
