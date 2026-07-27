import type {
	AuthzChangeRecord,
	AuthzChangeStore,
	JsonObject,
	RegisteredToolRecord,
	RegisteredToolStore,
	SpecRegistrationRecord,
	SpecRegistrationStore,
} from "@busyclaw/contracts";
import { memoryAdapter } from "@busyclaw/storage-core";
import {
	createRegistryStores,
	type RegistryStores,
} from "@busyclaw/storage-durable";
import { describe, expect, it, vi } from "vitest";
import { createSpecRegistry } from "../src/tools/registry";
import type { OpenApiExtraction } from "../src/tools/sources/openapi";

// The registry's address-uniqueness guard is unreachable through a real source — the OpenAPI
// extractor already keeps the first of a colliding pair and reports the loser — which is precisely
// why the guard is an assertion about SOURCE code rather than about an uploaded document. Reaching
// it means standing in a source that breaks the contract, so the extractor module delegates to the
// real one unless a test installs an override.
const extractor = vi.hoisted(() => ({
	override: undefined as OpenApiExtraction | undefined,
}));
vi.mock("../src/tools/sources/openapi", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/tools/sources/openapi")>();
	return {
		...actual,
		toolsFromOpenApi: (document: JsonObject) =>
			extractor.override ?? actual.toolsFromOpenApi(document),
	};
});

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
		async count(ref) {
			return changes.filter((c) => c.scopeId === ref.scopeId).length;
		},
		async listForScope(ref) {
			return changes.filter((c) => c.scopeId === ref.scopeId);
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
		async listBySource(ref, source) {
			return [...tools.values()].filter(
				(row) => row.scopeId === ref.scopeId && row.source === source,
			);
		},
		async listForScope(ref) {
			return [...tools.values()].filter((row) => row.scopeId === ref.scopeId);
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
			const key = `${input.scopeId}:${input.source}`;
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
		async get(ref, source) {
			return specs.get(`${ref.scopeId}:${source}`) ?? null;
		},
		async listForScope(ref) {
			return [...specs.values()].filter((row) => row.scopeId === ref.scopeId);
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
		// A `servers:` entry is now REQUIRED to register: it is the origin each row's credential is
		// pinned to, and a spec with no destination has nothing to approve. Previously a serverless spec
		// registered fine and failed at the first tool call instead.
		servers: [{ url: "https://api.petstore.example/v1" }],
		paths,
	} satisfies JsonObject;
};

describe("createSpecRegistry — governed openapi registration", () => {
	it("first registration adds every operation", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const report = await registry.registerOpenApiSpec({
			scope: "organization",
			scopeId: "org-a",
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
		const stored = await stores.specRegistrations.get(
			{ scope: "organization", scopeId: "org-a" },
			"petstore",
		);
		expect(stored?.contentVersion).toBe(report.contentVersion);
		expect(stored?.registeredBy).toBe("user:alice");
	});

	it("re-registration with an operation removed DELETES exactly that row (fail-closed)", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const input = {
			scope: "organization",
			scopeId: "org-a",
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
			scope: "organization",
			scopeId: "org-a",
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
			scope: "organization",
			scopeId: "org-a",
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
				scope: "organization",
				scopeId: "org-a",
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
				scope: "organization",
				scopeId: "org-a",
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
			scope: "organization",
			scopeId: "org-a",
			source: "petstore",
			document: petstore(),
			registeredBy: "user:alice",
		});
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(1);
		expect(changes[0]).toMatchObject({
			kind: "spec_registered",
			scope: "organization",
			scopeId: "org-a",
			summary: { source: "petstore", contentVersion: report.contentVersion },
			by: "user:alice",
		});
	});

	it("registers fine without a change log (authzChanges optional)", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores); // no authzChanges
		const report = await registry.registerOpenApiSpec({
			scope: "organization",
			scopeId: "org-a",
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
			servers: [{ url: "https://api.dup.example" }],
			paths: {
				"/a": { get: { operationId: "dup" } },
				"/b": { get: { operationId: "dup" } },
			},
		} satisfies JsonObject;
		const report = await registry.registerOpenApiSpec({
			scope: "organization",
			scopeId: "org-a",
			source: "svc",
			document,
			registeredBy: "user:alice",
		});
		expect(report.added).toEqual(["svc.dup"]);
		expect(report.skipped).toHaveLength(1);
		expect(report.skipped[0]?.reason).toContain("already taken");
		// The loser neither overwrote the winner nor doubled the address: ONE row, and it is /a's.
		expect(stores.tools.size).toBe(1);
		expect([...stores.tools.values()][0]?.binding).toMatchObject({
			path: "/a",
		});
	});

	it("refuses an extraction whose tools collide on one address, writing nothing", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const twin = {
			name: "dup",
			inputSchema: { type: "object", properties: {} },
			governance: { access: "read" },
			binding: { method: "get", path: "/a", parameters: [] },
		} satisfies OpenApiExtraction["tools"][number];
		extractor.override = { tools: [twin, twin], skipped: [], warnings: [] };
		try {
			await expect(
				registry.registerOpenApiSpec({
					scope: "organization",
					scopeId: "org-a",
					source: "svc",
					document: petstore(),
					registeredBy: "user:alice",
				}),
			).rejects.toThrow("duplicate registered tool address");
			expect(stores.tools.size).toBe(0);
			expect(stores.specs.size).toBe(0);
		} finally {
			extractor.override = undefined;
		}
	});

	// H-05, at the door the attack actually walks through. `register` is idempotent on the source name
	// and rotates every row in place, so replacing the document under an existing source was a full
	// redirect of that source's established credential — same name, same tool addresses, new host.
	it("refuses a re-registration that moves the source's origin", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const input = {
			scope: "organization",
			scopeId: "org-a",
			source: "petstore",
			registeredBy: "user:alice",
		};
		await registry.registerOpenApiSpec({ ...input, document: petstore() });
		const before = [...stores.tools.values()].map((row) => ({
			address: row.address,
			credentialOrigin: row.credentialOrigin,
		}));

		const moved = petstore();
		moved.servers = [{ url: "https://attacker.example/v1" }];
		await expect(
			registry.registerOpenApiSpec({ ...input, document: moved }),
		).rejects.toThrow(/different origin/);

		// Refused BEFORE the first write — the registration is a diff that deletes and rotates rows, so
		// a half-applied one is worse than a rejected one.
		expect(
			[...stores.tools.values()].map((row) => ({
				address: row.address,
				credentialOrigin: row.credentialOrigin,
			})),
		).toEqual(before);
	});

	it("refuses a re-registration that relocates where the credential is placed", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const input = {
			scope: "organization",
			scopeId: "org-a",
			source: "petstore",
			registeredBy: "user:alice",
		};
		const withScheme = (scheme: JsonObject) => {
			const document = petstore() as JsonObject & {
				components?: JsonObject;
				security?: unknown;
			};
			document.components = { securitySchemes: { main: scheme } };
			document.security = [{ main: [] }];
			return document;
		};
		await registry.registerOpenApiSpec({
			...input,
			document: withScheme({ type: "apiKey", in: "header", name: "X-Api-Key" }),
		});
		// Same host, same credential — but now it rides in the query string, where it lands in the
		// destination's access logs. The caller who approved the header placement never saw this one.
		await expect(
			registry.registerOpenApiSpec({
				...input,
				document: withScheme({ type: "apiKey", in: "query", name: "api_key" }),
			}),
		).rejects.toThrow(/place this source's credential differently/);
	});

	it("registers the same document twice without complaint", async () => {
		const stores = fakeStores();
		const registry = createSpecRegistry(stores);
		const input = {
			scope: "organization",
			scopeId: "org-a",
			source: "petstore",
			registeredBy: "user:alice",
		};
		await registry.registerOpenApiSpec({ ...input, document: petstore() });
		// The pin must not make ordinary re-registration (a rotate, a schema edit) fail — only a MOVE.
		const second = await registry.registerOpenApiSpec({
			...input,
			document: petstore(),
		});
		expect(second.removed).toEqual([]);
		expect(
			[...stores.tools.values()].every(
				(row) => row.credentialOrigin === "https://api.petstore.example",
			),
		).toBe(true);
	});

	// M-07. A registration is not one write: it inserts, updates and DELETES tool rows, replaces the
	// spec row, and appends the change that bumps the org's bundle version. Committed separately, a
	// crash between the rows and the append leaves the surface changed and the version stale — so the
	// router keeps serving a bundle that still names a tool the new spec removed, and the fail-closed
	// delete stops being fail-closed until something unrelated bumps the version.
	//
	// Real stores over a real adapter transaction, not a hand-rolled rollback: the memory adapter works
	// on a snapshot and only replaces state on success, so a throw genuinely un-does the writes.
	it("applies nothing when a later write in the registration fails", async () => {
		const adapter = memoryAdapter();
		const real = createRegistryStores(adapter);
		const boom = async (): Promise<never> => {
			throw new Error("bundle version append failed");
		};
		// The LAST write in the sequence, and the one a crash most plausibly interrupts.
		const failing = (bundle: RegistryStores) => ({
			...bundle,
			authzChanges: { ...bundle.authzChanges, append: boom },
		});
		const registry = createSpecRegistry({
			...failing(real),
			transaction: (fn) => {
				const run = real.transaction;
				if (!run) throw new Error("expected a transactional adapter");
				return run((tx) => fn(failing(tx)));
			},
		});

		await expect(
			registry.registerOpenApiSpec({
				scope: "organization",
				scopeId: "org-a",
				source: "petstore",
				document: petstore(),
				registeredBy: "user:alice",
			}),
		).rejects.toThrow(/bundle version append failed/);

		// Nothing landed. Before the transaction the tool rows were written and only the append was
		// lost — the worst shape, because the surface changed while the version governing it did not.
		expect(
			await real.registeredTools.listBySource(
				{ scope: "organization", scopeId: "org-a" },
				"petstore",
			),
		).toEqual([]);
		expect(
			await real.specRegistrations.get(
				{ scope: "organization", scopeId: "org-a" },
				"petstore",
			),
		).toBeNull();
	});

	it("commits every write when the registration succeeds", async () => {
		const real = createRegistryStores(memoryAdapter());
		const registry = createSpecRegistry(real);
		const report = await registry.registerOpenApiSpec({
			scope: "organization",
			scopeId: "org-a",
			source: "petstore",
			document: petstore(),
			registeredBy: "user:alice",
		});
		expect(report.added).toHaveLength(4);
		expect(
			await real.registeredTools.listBySource(
				{ scope: "organization", scopeId: "org-a" },
				"petstore",
			),
		).toHaveLength(4);
		// …including the append that bumps the bundle version, inside the same unit.
		expect(
			await real.authzChanges.count({
				scope: "organization",
				scopeId: "org-a",
			}),
		).toBe(1);
	});
});
