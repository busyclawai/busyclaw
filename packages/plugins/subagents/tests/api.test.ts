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
						nodes: {
							alias: string;
							depth: number;
							status: string;
							threadId?: string;
						}[];
					}>;
					cancelTree: (
						i: { rootRunId: string },
						c?: { principal?: string },
					) => Promise<{ runs: number; cancelled: number; joins: number }>;
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
		//
		// THE ONLY PLACE THIS IS DECIDED. An earlier version also checked, inside `startRun`, that the
		// parent ran as the caller — stricter, and wrong: `manage` is grantable, so that check refused
		// a caller who had been given exactly the authority this door asks for. One rule, at the door.
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
		// WITH a claw: a child's thread lives in its parent's, so a claw-less parent has children
		// with no transcript — which the walk reports honestly as an absent `threadId`.
		const root = await claw.openRun(userPrincipal("alice"), "claw-tree");
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
		// AND the door onto each child's answer. Derived from the run, not stored on the edge — one
		// deterministic function, so a second copy could only ever disagree by being wrong.
		expect(nodes.every((node) => typeof node.threadId === "string")).toBe(true);
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

describe("claw.api.agents.cancelTree", () => {
	it("stops the root as well as its children", async () => {
		// THE ROOT IS NOT IN ITS OWN TREE — `agent_edge` holds children, and the root is somebody's
		// parent rather than somebody's child. Cancelling every descendant and leaving the run that
		// started them going is the shape of this that looks right and is not.
		const { claw } = await harness();
		const alice = userPrincipal("alice");
		const rootRunId = await claw.openRun(alice);
		await agentsOf(claw).spawn(
			{ parentRunId: rootRunId, alias: "a", prompt: "go" },
			{ principal: alice },
		);
		await agentsOf(claw).spawn(
			{ parentRunId: rootRunId, alias: "b", prompt: "go" },
			{ principal: alice },
		);

		const result = await agentsOf(claw).cancelTree(
			{ rootRunId },
			{ principal: alice },
		);

		expect(result.runs).toBe(3);
		expect(result.cancelled).toBe(3);
	});

	it("closes the barrier the cancelled parent was waiting on", async () => {
		// Otherwise the join outlives every run in it. Its children are stopping, so no arrival will
		// ever meet the threshold; the reconciler keeps examining it every tick until the deadline
		// finally times it out, and then tries to wake a run that is already terminal.
		const { claw, store } = await harness();
		const alice = userPrincipal("alice");
		const rootRunId = await claw.openRun(alice);
		await agentsOf(claw).spawn(
			{ parentRunId: rootRunId, alias: "a", prompt: "go" },
			{ principal: alice },
		);
		const waiting = await claw
			.capability({ principal: alice, parentRunId: rootRunId, step: 0 })
			.awaitChildren({});
		expect(waiting.status).toBe("waiting");
		expect(await store.openJoins(10)).toHaveLength(1);

		const result = await agentsOf(claw).cancelTree(
			{ rootRunId },
			{ principal: alice },
		);

		expect(result.joins).toBe(1);
		expect(await store.openJoins(10)).toEqual([]);
	});

	it("is DECIDED — an anonymous call is refused", async () => {
		const { claw } = await harness();
		const rootRunId = await claw.openRun(userPrincipal("alice"));
		await expect(agentsOf(claw).cancelTree({ rootRunId })).rejects.toThrow(
			/app-authz denied/,
		);
	});

	it("refuses a stranger outright", async () => {
		const { claw } = await harness();
		const rootRunId = await claw.openRun(userPrincipal("alice"));
		await expect(
			agentsOf(claw).cancelTree(
				{ rootRunId },
				{ principal: userPrincipal("mallory") },
			),
		).rejects.toThrow(/app-authz denied/);
	});

	it("refuses a caller who may SEE the tree but not manage it", async () => {
		// THE LEVEL, pinned. A stranger is denied at every level, so a test using one cannot tell
		// `manage` from `read` — and this door being a read would let anyone entitled to watch a
		// subtree stop it. Bob is granted `read` explicitly: he gets the tree and not the cancel.
		const { claw } = await harness();
		const alice = userPrincipal("alice");
		const bob = userPrincipal("bob");
		const rootRunId = await claw.openRun(alice);
		await agentsOf(claw).spawn(
			{ parentRunId: rootRunId, alias: "a", prompt: "go" },
			{ principal: alice },
		);
		await (
			claw as unknown as {
				api: {
					shareResource: (
						i: {
							resourceKind: string;
							resourceId: string;
							principalRef: string;
							permission: string;
						},
						c: { principal: string },
					) => Promise<unknown>;
				};
			}
		).api.shareResource(
			{
				resourceKind: "run",
				resourceId: rootRunId,
				principalRef: bob,
				permission: "read",
			},
			{ principal: alice },
		);

		// He can read it …
		await expect(
			agentsOf(claw).tree({ rootRunId }, { principal: bob }),
		).resolves.toMatchObject({ nodes: [{ alias: "a" }] });
		// … and stopping it is a different question.
		await expect(
			agentsOf(claw).cancelTree({ rootRunId }, { principal: bob }),
		).rejects.toThrow(/app-authz denied/);
	});
});
