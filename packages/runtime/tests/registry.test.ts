import type {
	AuthzChangeRecord,
	AuthzChangeStore,
	JsonObject,
	RegisteredToolRecord,
	RegisteredToolStore,
	SpecRegistrationRecord,
	SpecRegistrationStore,
} from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { createSpecRegistry } from "../src/tools/registry";

// An in-memory fake of the append-only change log (slice 6b) — the registration flow's optional
// third collaborator; when present, each registration appends a `spec_registered` event.
function fakeAuthzChanges() {
	const changes: AuthzChangeRecord[] = [];
	let seq = 0;
	const store: AuthzChangeStore = {
		async append(input) {
			const record = {
				id: `chg-${seq++}`,
				at: "t",
				...input,
			} as AuthzChangeRecord;
			changes.push(record);
			return record;
		},
		async count(organizationId) {
			return changes.filter((c) => c.organizationId === organizationId).length;
		},
		async listByOrganization(organizationId) {
			return changes.filter((c) => c.organizationId === organizationId);
		},
	};
	return { store, changes };
}

// In-memory fakes of the two store ports (plain Maps) — the registration flow's only collaborators.
function fakeStores() {
	const tools = new Map<string, RegisteredToolRecord>();
	const specs = new Map<string, SpecRegistrationRecord>();
	let seq = 0;

	const registeredTools: RegisteredToolStore = {
		async listBySource(organizationId, source) {
			return [...tools.values()].filter(
				(row) => row.organizationId === organizationId && row.source === source,
			);
		},
		async listByOrganization(organizationId) {
			return [...tools.values()].filter(
				(row) => row.organizationId === organizationId,
			);
		},
		async create(input) {
			const id = `tool-${seq++}`;
			const record = {
				id,
				...input,
				createdAt: "t0",
				updatedAt: "t0",
			} as RegisteredToolRecord;
			tools.set(id, record);
			return record;
		},
		async update(id, patch) {
			const prior = tools.get(id);
			if (!prior) return null;
			const next = { ...prior, ...patch, updatedAt: "t1" };
			tools.set(id, next);
			return next;
		},
		async deleteById(id) {
			tools.delete(id);
		},
	};

	const specRegistrations: SpecRegistrationStore = {
		async upsert(input) {
			const key = `${input.organizationId}:${input.source}`;
			const prior = specs.get(key);
			const record = {
				id: prior?.id ?? `spec-${seq++}`,
				...input,
				createdAt: prior?.createdAt ?? "t0",
				updatedAt: "t1",
			} as SpecRegistrationRecord;
			specs.set(key, record);
			return record;
		},
		async get(organizationId, source) {
			return specs.get(`${organizationId}:${source}`) ?? null;
		},
		async listByOrganization(organizationId) {
			return [...specs.values()].filter(
				(row) => row.organizationId === organizationId,
			);
		},
	};

	return { registeredTools, specRegistrations, tools, specs };
}

const petstore = (
	options: { withRemove?: boolean; addPetWeight?: boolean } = {},
) => {
	const withRemove = options.withRemove ?? true;
	const paths: JsonObject = {
		"/pets": {
			get: { operationId: "listPets", tags: ["pets"] },
			post: {
				operationId: "addPet",
				tags: ["pets"],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									name: { type: "string" },
									...(options.addPetWeight
										? { weight: { type: "integer" } }
										: {}),
								},
								required: ["name"],
							},
						},
					},
				},
			},
		},
		"/pets/{petId}": {
			get: {
				operationId: "getPet",
				tags: ["pets"],
				parameters: [
					{ name: "petId", in: "path", schema: { type: "integer" } },
				],
			},
			...(withRemove
				? {
						delete: {
							operationId: "removePet",
							tags: ["pets", "admin"],
							parameters: [
								{ name: "petId", in: "path", schema: { type: "integer" } },
							],
						},
					}
				: {}),
		},
	};
	return {
		openapi: "3.1.0",
		info: { title: "petstore", version: "1.0.0" },
		paths,
	} satisfies JsonObject;
};

describe("createSpecRegistry — governed openapi registration", () => {
	it("first registration adds every operation", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const report = await registry.registerOpenApiSpec({
			organizationId: "org-a",
			source: "petstore",
			document: petstore(),
			registeredBy: "user:alice",
		});
		expect(report.added.sort()).toEqual([
			"petstore.addPet",
			"petstore.getPet",
			"petstore.listPets",
			"petstore.removePet",
		]);
		expect(report.updated).toEqual([]);
		expect(report.removed).toEqual([]);
		expect(stores.tools.size).toBe(4);
		// The blob + report + version were persisted.
		const stored = await stores.specRegistrations.get("org-a", "petstore");
		expect(stored?.contentVersion).toBe(report.contentVersion);
		expect(stored?.registeredBy).toBe("user:alice");
	});

	it("re-registration with an operation removed DELETES exactly that row (fail-closed)", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const input = {
			organizationId: "org-a",
			source: "petstore",
			registeredBy: "user:alice",
		};
		await registry.registerOpenApiSpec({ ...input, document: petstore() });
		const report = await registry.registerOpenApiSpec({
			...input,
			document: petstore({ withRemove: false }),
		});
		expect(report.removed).toEqual(["petstore.removePet"]);
		expect(report.added).toEqual([]);
		expect(report.updated).toEqual([]);
		expect(stores.tools.size).toBe(3);
		const addresses = [...stores.tools.values()].map((r) => r.address);
		expect(addresses).not.toContain("petstore.removePet");
	});

	it("a changed schema UPDATES the row and bumps the version", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const input = {
			organizationId: "org-a",
			source: "petstore",
			registeredBy: "user:alice",
		};
		const first = await registry.registerOpenApiSpec({
			...input,
			document: petstore(),
		});
		const addPetBefore = [...stores.tools.values()].find(
			(r) => r.address === "petstore.addPet",
		);
		const second = await registry.registerOpenApiSpec({
			...input,
			document: petstore({ addPetWeight: true }), // addPet input schema changed
		});
		expect(second.updated).toEqual(["petstore.addPet"]);
		expect(second.added).toEqual([]);
		expect(second.removed).toEqual([]);
		expect(second.contentVersion).not.toBe(first.contentVersion);
		const addPetAfter = [...stores.tools.values()].find(
			(r) => r.address === "petstore.addPet",
		);
		expect(addPetAfter?.contentVersion).not.toBe(addPetBefore?.contentVersion);
		expect(stores.tools.size).toBe(4); // still 4 — updated in place, not duplicated
	});

	it("an unchanged re-registration is a no-op diff with an identical content version", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const input = {
			organizationId: "org-a",
			source: "petstore",
			registeredBy: "user:alice",
			document: petstore(),
		};
		const first = await registry.registerOpenApiSpec(input);
		const second = await registry.registerOpenApiSpec(input);
		expect(second.added).toEqual([]);
		expect(second.updated).toEqual([]);
		expect(second.removed).toEqual([]);
		expect(second.contentVersion).toBe(first.contentVersion);
	});

	it("rejects a bad slug before touching the stores", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		await expect(
			registry.registerOpenApiSpec({
				organizationId: "org-a",
				source: "Bad.Slug",
				document: petstore(),
				registeredBy: "user:alice",
			}),
		).rejects.toThrow("invalid registration source");
		expect(stores.tools.size).toBe(0);
	});

	it("rejects an oversized document before extraction", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores, { maxDocumentBytes: 20 });
		await expect(
			registry.registerOpenApiSpec({
				organizationId: "org-a",
				source: "petstore",
				document: petstore(),
				registeredBy: "user:alice",
			}),
		).rejects.toThrow("too large");
		expect(stores.tools.size).toBe(0);
	});

	it("appends a spec_registered authz change when a change log is provided", async () => {
		const stores = fakeStores();
		const { store: authzChanges, changes } = fakeAuthzChanges();
		const registry = createSpecRegistry({ ...stores, authzChanges });
		const report = await registry.registerOpenApiSpec({
			organizationId: "org-a",
			source: "petstore",
			document: petstore(),
			registeredBy: "user:alice",
		});
		expect(await authzChanges.count("org-a")).toBe(1);
		expect(changes[0]).toMatchObject({
			kind: "spec_registered",
			organizationId: "org-a",
			summary: { source: "petstore", contentVersion: report.contentVersion },
			by: "user:alice",
		});
	});

	it("registers fine without a change log (authzChanges optional)", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores); // no authzChanges
		const report = await registry.registerOpenApiSpec({
			organizationId: "org-a",
			source: "petstore",
			document: petstore(),
			registeredBy: "user:alice",
		});
		expect(report.added).toHaveLength(4); // the append is a no-op; registration still works
	});

	it("passes the extractor's skipped diagnostics through to the report", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		// Two operations share an operationId — the second cannot become a tool and is reported.
		const document = {
			openapi: "3.1.0",
			info: { title: "dup", version: "1.0.0" },
			paths: {
				"/a": { get: { operationId: "dup" } },
				"/b": { get: { operationId: "dup" } },
			},
		} satisfies JsonObject;
		const report = await registry.registerOpenApiSpec({
			organizationId: "org-a",
			source: "svc",
			document,
			registeredBy: "user:alice",
		});
		expect(report.added).toEqual(["svc.dup"]);
		expect(report.skipped).toHaveLength(1);
		expect(report.skipped[0]?.reason).toContain("already taken");
	});
});
