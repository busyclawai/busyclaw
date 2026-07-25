// The addressing pass: a nested tool record becomes dotted PATHS rooted at the contributor's id,
// and each path projects onto the model-facing NAME the wire accepts. Two ids for one tool, so the
// pure functions that derive them are pinned here, away from the assembly that merges them.

import { describe, expect, it } from "vitest";
import {
	flattenToolTree,
	govern,
	toolDescriptors,
	toolModelName,
} from "../src/index";

const leaf = (label: string) =>
	govern(
		{
			description: `Do ${label}.`,
			inputSchema: { type: "object", properties: {} },
			execute: async () => label,
		},
		{ access: "read" },
	);

describe("flattenToolTree — nested records become rooted paths", () => {
	it("roots every path at the contributor's id, at arbitrary depth", () => {
		const addressed = flattenToolTree("docs", {
			search: leaf("search"),
			admin: { publish: leaf("publish"), audit: { purge: leaf("purge") } },
		});
		expect(addressed.map((tool) => [tool.path, tool.name])).toEqual([
			["docs.search", "docs__search"],
			["docs.admin.publish", "docs__admin__publish"],
			["docs.admin.audit.purge", "docs__admin__audit__purge"],
		]);
	});

	it("carries the definition through by reference — addressing never rewrites a tool", () => {
		const publish = leaf("publish");
		const [addressed] = flattenToolTree("docs", { admin: { publish } });
		expect(addressed?.definition).toBe(publish);
	});

	it("discriminates a group from a definition by the invocation TAG, not by key", () => {
		// A group is free to be named after a definition's own fields; only the tag is a string.
		const addressed = flattenToolTree("docs", {
			invocation: { governance: leaf("odd") },
		});
		expect(addressed.map((tool) => tool.path)).toEqual([
			"docs.invocation.governance",
		]);
	});
});

describe("toolDescriptors — the one place a key becomes a path", () => {
	it("uses the record key when the definition was never addressed", () => {
		expect(toolDescriptors({ readDoc: leaf("read") })[0]?.path).toBe("readDoc");
	});

	it("keeps an already-addressed definition's dotted path", () => {
		const [addressed] = flattenToolTree("docs", {
			admin: { publish: leaf("p") },
		});
		if (addressed === undefined) throw new Error("expected one addressed tool");
		const descriptors = toolDescriptors({
			[addressed.name]: { ...addressed.definition, path: addressed.path },
		});
		expect(descriptors[0]?.path).toBe("docs.admin.publish");
	});
});

describe("toolModelName — the projection the wire accepts", () => {
	it("leaves a flat name alone and joins a path on the reserved separator", () => {
		expect(toolModelName("readDoc")).toBe("readDoc");
		expect(toolModelName("docs.admin.publish")).toBe("docs__admin__publish");
	});
});
