// A parent run spawns children, and each property that makes that safe is asserted here rather than
// argued in a comment.
//
// Against SQLite, not the memory adapter: every fence in this package is a primary-key insert, and
// `memoryAdapter` declares `enforcesUnique: false` with a pre-check — so the losing branch of every
// conflict is unreachable there and a green test would prove nothing.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { entityAdapter } from "@busyclaw/storage-core";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
	agentLinkId,
	childRunId,
	createSubagentStore,
	subagentModels,
} from "../src/index";
import { spawningClaw } from "./harness";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

async function harness(options: Parameters<typeof spawningClaw>[0] = {}) {
	const sqlite = new Database(":memory:");
	closers.push(() => sqlite.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const adapter: Adapter = kyselyAdapter(kdb);
	const claw = spawningClaw({ ...options, adapter });
	const plan = await planMigrations({
		db: kdb,
		schema: claw.$tables as SchemaDeclaration,
		dialect: "sqlite",
		warn: () => undefined,
	});
	await plan.runMigrations();
	// The SAME wrap the assembly hands the plugin: `entityView` refuses a bare adapter, because a
	// read that is not validated against the model is not the read the plugin thinks it is.
	const entities = entityAdapter(adapter, subagentModels);
	return { adapter: entities, claw, store: createSubagentStore(entities) };
}

describe("a spawn creates a real run, and an edge that describes it", () => {
	it("starts a child run carrying the PARENT's principal", async () => {
		// The child's `run.principal` is what the tool floor reads. A child stamped
		// `system:anonymous` — which is what `startRun` writes when the caller is absent — would be
		// refused by the floor at its first tool call, and it would look like a policy bug.
		const { claw, store } = await harness();
		const parentRunId = await claw.openRun(userPrincipal("alice"));
		const parent = await claw.spawnFrom({
			parentRunId,
			principal: userPrincipal("alice"),
			alias: "researcher",
			prompt: "find the thing",
		});

		// WITH A CALLER. The product PEP has a principal floor, so an anonymous read is denied — which
		// is the api behaving correctly and worth reading the test as confirming.
		const child = await claw.api.getRun(
			{ id: parent.childRunId },
			{ principal: userPrincipal("alice") },
		);
		expect(child?.principal).toBe(userPrincipal("alice"));

		const edge = await store.edge(parent.childRunId);
		expect(edge).toMatchObject({
			parentRunId: parent.parentRunId,
			rootRunId: parent.parentRunId,
			depth: 1,
			alias: "researcher",
			principal: userPrincipal("alice"),
		});
	});

	it("introduces the two runs to each other, in both directions", async () => {
		const { claw, store } = await harness();
		const parent = await claw.openRun(userPrincipal("alice"));
		const { parentRunId, childRunId: child } = await claw.spawnFrom({
			parentRunId: parent,
			principal: userPrincipal("alice"),
			alias: "researcher",
			prompt: "find the thing",
		});

		// The parent knows the child by the alias it chose…
		expect(await store.resolve(parentRunId, "researcher")).toEqual({
			peerRunId: child,
			relation: "child",
		});
		// …and the child knows its parent by the one reserved name.
		expect(await store.resolve(child, "parent")).toEqual({
			peerRunId: parentRunId,
			relation: "parent",
		});
		// A run may address only peers it was introduced to.
		expect(await store.resolve(child, "researcher")).toBeNull();
	});
});

describe("a replayed spawn asks for the child it already has", () => {
	it("derives the same id from replay-stable state, not from the tool call id", async () => {
		// The durable replay this exists to survive is `resumeRun`, which reloads the checkpoint and
		// re-calls the tool — with a NEW provider `toolCallId`. Keyed on that, a resumed parent would
		// derive a different child and spend the model twice.
		const first = childRunId({ parentRunId: "run-1", alias: "researcher" });
		expect(childRunId({ parentRunId: "run-1", alias: "researcher" })).toBe(
			first,
		);
		// A different alias is a different child; a different parent is too.
		expect(childRunId({ parentRunId: "run-1", alias: "writer" })).not.toBe(
			first,
		);
		expect(childRunId({ parentRunId: "run-2", alias: "researcher" })).not.toBe(
			first,
		);
		// And the NUL join keeps that unambiguous: under a printable separator these collide.
		expect(childRunId({ parentRunId: "a b", alias: "c" })).not.toBe(
			childRunId({ parentRunId: "a", alias: "b c" }),
		);
	});

	it("does not start a second run when the same spawn runs twice", async () => {
		const { claw, store } = await harness();
		const parent = await claw.openRun(userPrincipal("alice"));
		const spawn = {
			parentRunId: parent,
			principal: userPrincipal("alice"),
			alias: "researcher",
			prompt: "find the thing",
			step: 2,
		};
		const first = await claw.spawnFrom(spawn);
		// The SAME parent run, the same step, the same alias — a replay.
		const again = await claw.spawnFrom({
			...spawn,
			parentRunId: first.parentRunId,
		});

		// Same id back, ONE edge, and the run row is the one the first spawn created — a second
		// `startRun` on a pinned id conflicts at the database and is swallowed as the retry it is.
		expect(again.childRunId).toBe(first.childRunId);
		expect(await store.countChildren(first.parentRunId)).toBe(1);
		expect(
			await claw.api.getRun(
				{ id: first.childRunId },
				{ principal: userPrincipal("alice") },
			),
		).not.toBeNull();
	});
});

describe("two spawns in one step are two different children", () => {
	it("separates them by ALIAS, which is the only thing that survives a replay", async () => {
		// One capability instance spawning twice is what the script layer does. The first version of
		// this keyed on a per-instance ordinal, and this test passed with the ordinal removed — because
		// the alias was already doing the work. Worse, the ordinal restarts at zero on a replay, so a
		// retried second spawn would have derived the FIRST child's id.
		const { claw, store } = await harness();
		const parentRunId = await claw.openRun(userPrincipal("alice"));
		const agent = claw.capability({
			principal: userPrincipal("alice"),
			parentRunId,
			step: 0,
		});
		const first = await agent.spawnChild({ alias: "a", prompt: "go" });
		const second = await agent.spawnChild({ alias: "b", prompt: "go" });

		expect(second.childRunId).not.toBe(first.childRunId);
		expect(await store.countChildren(parentRunId)).toBe(2);
	});
});

describe("a derived id is exactly-once but not authenticated", () => {
	it("REFUSES an id somebody else already holds, rather than adopting it", async () => {
		// The hash is unsalted over values a peer can often guess, and `startRun` lets any
		// authenticated principal pin a run id. Adopting whatever is already there would let a peer
		// pre-create a run the parent then treats as its own child.
		const { claw, store, adapter } = await harness();
		const parentRunId = await claw.openRun(userPrincipal("alice"));
		const id = childRunId({ parentRunId, alias: "researcher" });
		// Somebody else got there first, with a different owner.
		const stamp = new Date().toISOString();
		await createSubagentStore(adapter).createEdge({
			id,
			parentRunId: "somebody-elses-run",
			rootRunId: "somebody-elses-run",
			depth: 1,
			alias: "researcher",
			principal: userPrincipal("mallory"),
			containerKind: "run",
			containerId: id,
			createdAt: stamp,
			updatedAt: stamp,
		});

		await expect(
			claw.spawnFrom({
				principal: userPrincipal("alice"),
				alias: "researcher",
				prompt: "find the thing",
				parentRunId,
			}),
		).rejects.toThrow(/already holds this id/);

		// And the squatted row is untouched — the refusal did not overwrite it either.
		expect((await store.edge(id))?.principal).toBe(userPrincipal("mallory"));
	});
});

describe("the claw follows the tree, and only from a parent you own", () => {
	it("copies the parent's claw onto the child, server-side", async () => {
		// D7's ⚠. `clawId` is stamped from a recording, and a subagent has none — so without this the
		// child reaches Cedar with the fact ABSENT, and an absent attribute base-errors: the policy is
		// SKIPPED, so an unguarded `forbid` written against `clawId` fails OPEN.
		const { claw } = await harness();
		const parentRunId = await claw.openRun(userPrincipal("alice"), "claw-1");
		const { childRunId: child } = await claw.spawnFrom({
			parentRunId,
			principal: userPrincipal("alice"),
			alias: "researcher",
			prompt: "go",
		});

		const childRun = await claw.api.getRun(
			{ id: child },
			{ principal: userPrincipal("alice") },
		);
		expect(childRun?.clawId).toBe("claw-1");
		// And no thread: it belongs to the claw without writing into anyone's conversation.
		expect(childRun?.threadId).toBeUndefined();
	});

	it("REFUSES a parent that does not already run as the caller", async () => {
		// The child's claw is copied off the parent row, so naming somebody else's run would be
		// choosing their authz parent and their PII namespace — which is exactly what `input: false`
		// on the column exists to prevent. The caller names a parent, never a claw, and the parent
		// must be theirs.
		const { claw } = await harness();
		const someoneElses = await claw.openRun(userPrincipal("bob"));
		await expect(
			claw.spawnFrom({
				parentRunId: someoneElses,
				principal: userPrincipal("mallory"),
				alias: "researcher",
				prompt: "go",
			}),
		).rejects.toThrow(/already runs as you/);
	});
});

describe("the prompt crosses into the CHILD's container", () => {
	it("translates it, rather than handing over a placeholder the child cannot resolve", async () => {
		// The parent tokenized this prompt in ITS container. A placeholder means nothing outside the
		// container that minted it, so handing it over unchanged reaches the child's tools as the
		// literal `{{pii:…}}` text — with nothing thrown, which is why it needs a test rather than a
		// comment.
		const crossings: { value: unknown; toRunId: string }[] = [];
		const { claw } = await harness({
			translate: async <T>(
				value: T,
				to: { runId: string; subjectIds?: readonly string[] },
			) => {
				crossings.push({ value, toRunId: to.runId });
				return `translated:${String(value)}` as T;
			},
		});

		const { childRunId: child } = await claw.spawnFrom({
			parentRunId: await claw.openRun(userPrincipal("alice")),
			principal: userPrincipal("alice"),
			alias: "researcher",
			prompt: "write to {{pii:parent-token}}",
		});

		// It went through, and it was addressed to the CHILD — not re-minted in the parent's own
		// container, which would be a no-op wearing the shape of a crossing.
		expect(crossings).toEqual([
			{ value: "write to {{pii:parent-token}}", toRunId: child },
		]);
	});
});

describe("the ceilings hold in the database, not in a JS integer", () => {
	it("refuses past maxDepth, and says how deep it is", async () => {
		const { claw } = await harness({ maxDepth: 1 });
		const parent = await claw.openRun(userPrincipal("alice"));
		const first = await claw.spawnFrom({
			parentRunId: parent,
			principal: userPrincipal("alice"),
			alias: "a",
			prompt: "go",
		});
		// The child spawning its own child is depth 2, past the cap.
		await expect(
			claw.spawnFrom({
				principal: userPrincipal("alice"),
				alias: "b",
				prompt: "go",
				parentRunId: first.childRunId,
			}),
		).rejects.toThrow(/depth limit/);
	});

	it("refuses past maxChildren, counting rows a resumed parent never saw", async () => {
		// A parent resumed in another worker has no memory of what it spawned before the park, which
		// is exactly why this is a count over rows rather than a counter in the capability.
		const { claw } = await harness({ maxChildren: 2 });
		const parentRunId = await claw.openRun(userPrincipal("alice"));
		await claw.spawnFrom({
			principal: userPrincipal("alice"),
			alias: "a",
			prompt: "go",
			parentRunId,
			step: 0,
		});
		await claw.spawnFrom({
			principal: userPrincipal("alice"),
			alias: "b",
			prompt: "go",
			parentRunId,
			step: 1,
		});
		await expect(
			claw.spawnFrom({
				principal: userPrincipal("alice"),
				alias: "c",
				prompt: "go",
				parentRunId,
				step: 2,
			}),
		).rejects.toThrow(/fan-out limit/);
	});

	it("refuses the reserved parent alias", async () => {
		const { claw } = await harness();
		const parentRunId = await claw.openRun(userPrincipal("alice"));
		await expect(
			claw.spawnFrom({
				parentRunId,
				principal: userPrincipal("alice"),
				alias: "parent",
				prompt: "go",
			}),
		).rejects.toThrow(/reserved alias/);
	});
});

describe("the address book is keyed so one alias cannot become two rows", () => {
	it("derives one id per (owner, alias), unambiguously", async () => {
		// The NUL join is not decoration: under a printable separator `("a b", "c")` and
		// `("a", "b c")` hash alike, and two different peers would share one address-book row.
		expect(agentLinkId("a b", "c")).not.toBe(agentLinkId("a", "b c"));
	});
});
