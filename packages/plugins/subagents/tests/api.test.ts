// The host-facing doors, and the two things about them that are not the capability's business.
//
// A stamped tool's parent is the run it is executing inside — pinned by the runtime, unforgeable. A
// host caller has none, so it names one, and a named parent is caller input. These pin what that
// input may and may not buy: it authorizes the call and computes depth and root, and it never names
// the child's identity.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { entityAdapter } from "@busyclaw/storage-core";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createSubagentStore, subagentModels } from "../src/index";
import { spawningClaw } from "./harness";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

async function harness() {
	const sqlite = new Database(":memory:");
	closers.push(() => sqlite.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const adapter: Adapter = kyselyAdapter(kdb);
	const claw = spawningClaw({ adapter });
	const plan = await planMigrations({
		db: kdb,
		schema: claw.$tables as SchemaDeclaration,
		dialect: "sqlite",
		warn: () => undefined,
	});
	await plan.runMigrations();
	return {
		claw,
		store: createSubagentStore(entityAdapter(adapter, subagentModels)),
	};
}

/** The doors as the assembled claw exposes them — `claw.api.agents.*`. */
const agentsOf = (claw: unknown) =>
	(
		claw as {
			api: {
				agents: {
					spawn: (
						i: { parentRunId: string; alias: string; prompt: string },
						c?: { principal?: string },
					) => Promise<{ childRunId: string }>;
					tree: (
						i: { rootRunId: string },
						c?: { principal?: string },
					) => Promise<{
						nodes: { alias: string; depth: number; status: string }[];
					}>;
				};
			};
		}
	).api.agents;

describe("claw.api.agents.spawn", () => {
	it("starts a child under a parent the caller owns", async () => {
		const { claw, store } = await harness();
		const parentRunId = await claw.openRun(userPrincipal("alice"));

		const { childRunId } = await agentsOf(claw).spawn(
			{ parentRunId, alias: "researcher", prompt: "find the thing" },
			{ principal: userPrincipal("alice") },
		);

		expect(await store.edge(childRunId)).toMatchObject({
			parentRunId,
			alias: "researcher",
			depth: 1,
			// STAMPED FROM THE CALLER. The door takes a parent; it never takes a principal, so a caller
			// cannot ask for a child that runs as somebody else.
			principal: userPrincipal("alice"),
		});
	});

	it("is DECIDED, not merely handled — an anonymous call is refused", async () => {
		// `assertAuthzCoverage` refuses to boot on a plugin method the PEP cannot decide, so the
		// interesting question is not whether a route exists but whether it denies. An `endpoints()`
		// namespace built over `route.input(…).authz(…)` is what makes that true; a plain object of
		// functions would carry no metadata and deny every call instead.
		const { claw } = await harness();
		const parentRunId = await claw.openRun(userPrincipal("alice"));

		await expect(
			agentsOf(claw).spawn({
				parentRunId,
				alias: "researcher",
				prompt: "find the thing",
			}),
		).rejects.toThrow(/app-authz denied/);
	});

	it("refuses a parent the caller does not manage", async () => {
		// You may graft a child onto a run you already manage and onto no other — which is what stops
		// a caller pointing a spawn at somebody else's run to have a child created inside their claw.
		const { claw } = await harness();
		const alicesRun = await claw.openRun(userPrincipal("alice"));

		await expect(
			agentsOf(claw).spawn(
				{ parentRunId: alicesRun, alias: "researcher", prompt: "go" },
				{ principal: userPrincipal("mallory") },
			),
			// THE PEP, specifically. `startRun` has its own rule — a parent must already run as you —
			// and it would refuse this too, so an assertion that accepted either message would pass
			// with the door's authz declaration deleted entirely. A mutation proved exactly that.
		).rejects.toThrow(/app-authz denied/);
	});
});

describe("claw.api.agents.tree", () => {
	it("answers with the whole subtree in one query, at any depth", async () => {
		// `rootRunId` is denormalized onto every edge at spawn precisely so this is one indexed read
		// rather than a recursive walk over a tree whose depth nothing bounds at read time.
		const { claw } = await harness();
		const root = await claw.openRun(userPrincipal("alice"));
		const caller = { principal: userPrincipal("alice") };
		const agents = agentsOf(claw);

		const first = await agents.spawn(
			{ parentRunId: root, alias: "a", prompt: "go" },
			caller,
		);
		await agents.spawn(
			{ parentRunId: first.childRunId, alias: "b", prompt: "go" },
			caller,
		);

		const { nodes } = await agents.tree({ rootRunId: root }, caller);
		expect(nodes.map((node) => [node.alias, node.depth])).toEqual([
			["a", 1],
			["b", 2],
		]);
		// The status comes from each RUN, not mirrored onto the edge — one writer for one fact.
		expect(nodes.every((node) => node.status !== "unknown")).toBe(true);
	});

	it("is refused to a caller who cannot read the root run", async () => {
		const { claw } = await harness();
		const root = await claw.openRun(userPrincipal("alice"));
		await expect(
			agentsOf(claw).tree(
				{ rootRunId: root },
				{ principal: userPrincipal("mallory") },
			),
		).rejects.toThrow(/app-authz denied/);
	});
});
