import { type Adapter, memoryAdapter } from "@euroclaw/storage-core";
import { kyselyAdapter } from "@euroclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistryStores } from "../src/registry";

const specInput = (organizationId: string, source = "petstore") => ({
	organizationId,
	source,
	specBlob: { openapi: "3.1.0", paths: { "/pets": { get: {} } } },
	contentVersion: "spec-v1",
	report: {
		added: [`${source}.addPet`],
		updated: [],
		removed: [],
		skipped: [],
		warnings: [],
	},
	registeredBy: "user:alice",
});

const toolInput = (
	organizationId: string,
	name = "addPet",
	source = "petstore",
) => ({
	organizationId,
	source,
	name,
	address: `${source}.${name}`,
	description: "Create a pet",
	inputSchema: { type: "object", properties: { name: { type: "string" } } },
	governance: { access: "write", groups: ["creates", "tag:pets"] },
	binding: { method: "post", path: "/pets" },
	contentVersion: "tool-v1",
});

const overlayInput = (
	organizationId: string,
	actionId = "petstore.addPet",
) => ({
	organizationId,
	actionId,
	access: "read" as const,
	groups: ["audited"],
	resource: "Pet",
	audit: true,
	updatedBy: "user:alice",
});

const stamps = () => {
	let n = 0;
	return () => `2026-01-01T00:00:0${n++}Z`;
};

describe("createRegistryStores over memory adapter", () => {
	it("spec_registration round-trips the blob and report through storage", async () => {
		const { specRegistrations } = createRegistryStores(memoryAdapter());
		const created = await specRegistrations.upsert(specInput("org-a"));
		expect(created.id).toMatch(/^[0-9a-f]{32}$/);
		const read = await specRegistrations.get("org-a", "petstore");
		expect(read?.specBlob).toEqual(specInput("org-a").specBlob); // parsed back, not a string
		expect(read?.report).toEqual(specInput("org-a").report);
		expect(read?.registeredBy).toBe("user:alice");
	});

	it("spec_registration upsert REPLACES by (organizationId, source), id preserved", async () => {
		const { specRegistrations } = createRegistryStores(memoryAdapter(), {
			now: stamps(),
		});
		const first = await specRegistrations.upsert(specInput("org-a"));
		const second = await specRegistrations.upsert({
			...specInput("org-a"),
			contentVersion: "spec-v2",
			registeredBy: "user:bob",
		});
		expect(second.id).toBe(first.id); // replace-in-place
		expect(second.createdAt).toBe(first.createdAt); // createdAt preserved
		expect(second.updatedAt).not.toBe(first.updatedAt); // updatedAt bumped
		const all = await specRegistrations.listByOrganization("org-a");
		expect(all).toHaveLength(1); // one row per (org, source)
		expect(all[0]?.contentVersion).toBe("spec-v2");
		expect(all[0]?.registeredBy).toBe("user:bob");
	});

	it("registered_tool round-trips schema/governance/binding and updates in place", async () => {
		const { registeredTools } = createRegistryStores(memoryAdapter());
		const created = await registeredTools.create(toolInput("org-a"));
		const listed = await registeredTools.listBySource("org-a", "petstore");
		expect(listed).toHaveLength(1);
		expect(listed[0]?.governance).toEqual(toolInput("org-a").governance);
		expect(listed[0]?.inputSchema).toEqual(toolInput("org-a").inputSchema);
		expect(listed[0]?.binding).toEqual(toolInput("org-a").binding);

		const patched = await registeredTools.update(created.id, {
			governance: { access: "read" },
			contentVersion: "tool-v2",
		});
		expect(patched?.governance).toEqual({ access: "read" });
		expect(patched?.contentVersion).toBe("tool-v2");
		expect(patched?.address).toBe("petstore.addPet"); // untouched columns preserved
	});

	it("registered_tool deleteById removes the row (fail-closed diff primitive)", async () => {
		const { registeredTools } = createRegistryStores(memoryAdapter());
		const created = await registeredTools.create(toolInput("org-a"));
		await registeredTools.deleteById(created.id);
		expect(await registeredTools.listBySource("org-a", "petstore")).toEqual([]);
	});

	it("facts_overlay round-trips access/groups/audit", async () => {
		const { factsOverlay } = createRegistryStores(memoryAdapter());
		await factsOverlay.upsert(overlayInput("org-a"));
		const listed = await factsOverlay.listByOrganization("org-a");
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			actionId: "petstore.addPet",
			access: "read",
			groups: ["audited"],
			resource: "Pet",
			audit: true,
		});
	});

	it("facts_overlay upsert REPLACES by (organizationId, actionId) — omitted facts are CLEARED", async () => {
		const { factsOverlay } = createRegistryStores(memoryAdapter());
		await factsOverlay.upsert(overlayInput("org-a")); // access read, groups ["audited"]
		await factsOverlay.upsert({
			organizationId: "org-a",
			actionId: "petstore.addPet",
			access: "write",
			updatedBy: "user:bob",
		});
		const listed = await factsOverlay.listByOrganization("org-a");
		expect(listed).toHaveLength(1); // one row per (org, actionId)
		expect(listed[0]?.access).toBe("write");
		expect(listed[0]?.groups).toBeUndefined(); // the earlier override's groups were cleared
		expect(listed[0]?.resource).toBeUndefined();
	});

	it("facts_overlay deleteById removes the row", async () => {
		const { factsOverlay } = createRegistryStores(memoryAdapter());
		const created = await factsOverlay.upsert(overlayInput("org-a"));
		await factsOverlay.deleteById(created.id);
		expect(await factsOverlay.listByOrganization("org-a")).toEqual([]);
	});

	it("lists are scoped by organizationId — org A rows never leak into org B", async () => {
		const stores = createRegistryStores(memoryAdapter());
		await stores.specRegistrations.upsert(specInput("org-a"));
		await stores.specRegistrations.upsert(specInput("org-b"));
		await stores.registeredTools.create(toolInput("org-a"));
		await stores.registeredTools.create(toolInput("org-b"));
		await stores.factsOverlay.upsert(overlayInput("org-a"));
		await stores.factsOverlay.upsert(overlayInput("org-b"));

		expect(
			await stores.specRegistrations.listByOrganization("org-a"),
		).toHaveLength(1);
		const aSpecs = await stores.specRegistrations.listByOrganization("org-a");
		expect(aSpecs.every((r) => r.organizationId === "org-a")).toBe(true);
		const aTools = await stores.registeredTools.listByOrganization("org-a");
		expect(aTools.every((r) => r.organizationId === "org-a")).toBe(true);
		expect(
			await stores.registeredTools.listBySource("org-b", "petstore"),
		).toHaveLength(1);
		const aOverlays = await stores.factsOverlay.listByOrganization("org-a");
		expect(aOverlays.every((r) => r.organizationId === "org-a")).toBe(true);
	});

	it("rejects a malformed stored spec_registration row (required blob missing)", async () => {
		const adapter = memoryAdapter();
		const { specRegistrations } = createRegistryStores(adapter);
		await adapter.create({
			model: "spec_registration",
			data: {
				id: "bad",
				organizationId: "org-bad",
				source: "x",
				contentVersion: "v",
				registeredBy: "user:a",
				createdAt: "t",
				updatedAt: "t",
			},
		});
		await expect(
			specRegistrations.listByOrganization("org-bad"),
		).rejects.toThrow("spec_registration record invalid");
	});

	it("rejects a malformed stored registered_tool row (required governance missing)", async () => {
		const adapter = memoryAdapter();
		const { registeredTools } = createRegistryStores(adapter);
		await adapter.create({
			model: "registered_tool",
			data: {
				id: "bad",
				organizationId: "org-bad",
				source: "x",
				name: "y",
				address: "x.y",
				inputSchema: JSON.stringify({ type: "object" }),
				binding: JSON.stringify({ method: "get" }),
				contentVersion: "v",
				createdAt: "t",
				updatedAt: "t",
			},
		});
		await expect(registeredTools.listByOrganization("org-bad")).rejects.toThrow(
			"registered_tool record invalid",
		);
	});
});

// A real SQL adapter proves the JSON columns serialize/deserialize through storage, not just memory.
describe("createRegistryStores over kysely (sqlite) — JSON columns round-trip", () => {
	let sqlite: Database.Database | undefined;
	afterEach(() => sqlite?.close());

	function makeAdapter(): Adapter {
		sqlite = new Database(":memory:");
		const db = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		sqlite.exec(
			`CREATE TABLE spec_registration (
				id TEXT PRIMARY KEY, organizationId TEXT, source TEXT, specBlob TEXT,
				contentVersion TEXT, report TEXT, registeredBy TEXT, createdAt TEXT, updatedAt TEXT
			)`,
		);
		sqlite.exec(
			`CREATE TABLE registered_tool (
				id TEXT PRIMARY KEY, organizationId TEXT, source TEXT, name TEXT, address TEXT,
				description TEXT, inputSchema TEXT, governance TEXT, binding TEXT,
				contentVersion TEXT, createdAt TEXT, updatedAt TEXT
			)`,
		);
		return kyselyAdapter(db);
	}

	it("spec_registration + registered_tool survive a real SQL round-trip", async () => {
		const { specRegistrations, registeredTools } = createRegistryStores(
			makeAdapter(),
		);
		await specRegistrations.upsert(specInput("org-a"));
		const spec = await specRegistrations.get("org-a", "petstore");
		expect(spec?.specBlob).toEqual(specInput("org-a").specBlob);
		expect(spec?.report).toEqual(specInput("org-a").report);

		const tool = await registeredTools.create(toolInput("org-a"));
		const listed = await registeredTools.listBySource("org-a", "petstore");
		expect(listed[0]?.governance).toEqual(toolInput("org-a").governance);
		expect(listed[0]?.inputSchema).toEqual(toolInput("org-a").inputSchema);
		expect(tool.address).toBe("petstore.addPet");
	});
});
