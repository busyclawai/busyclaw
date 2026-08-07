// `ctx.engine` on the plugin configure context — the substrate a run-orchestrating plugin gets, and
// the one thing it deliberately does NOT get.
//
// A plugin that creates runs (subagents today; a workflows plugin, a scheduler, a batch runner next)
// needs the durable engine. Handing it over raw quietly undid a rule the product api already had:
// `ClawRunView = Omit<EngineRunRecord, "input">`, because the run door stopped being a content door.
// So a plugin could read run inputs the claw's own OWNER cannot get through `getRun` — no `view`
// gate, no `pii.reidentification` audit line. Not a plugin doing anything wrong; a door with one
// rule at the front and another round the side.

import type { BusyclawPluginConfigureContext } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import { owned, textModel } from "./fixtures";

type PluginEngine = {
	startRun: (input: {
		prompt: string;
		ctx?: Record<string, unknown>;
		run?: { principal?: string };
	}) => Promise<{ id: string }>;
	runs?: {
		get: (id: string) => Promise<{
			status: string;
			principal?: string;
			input?: unknown;
		} | null>;
	};
};

/** A plugin that captures the engine thunk, the way subagents does. */
function capture() {
	let resolve: (() => unknown) | undefined;
	let threads: { create: (i: unknown) => Promise<unknown> } | undefined;
	const plugin = {
		id: "keeper",
		configure(ctx: BusyclawPluginConfigureContext) {
			// STORED, NOT CALLED. The handle does not exist yet — the runtime is built from these
			// plugins and the engine from that runtime.
			resolve = ctx.engine;
			// The BOUND store view, not the shared one — this is what stamps the plugin's origin.
			threads = ctx.clawsStore?.threads as typeof threads;
			return undefined;
		},
	};
	const engine = () => {
		if (resolve === undefined) throw new Error("configure never ran");
		return resolve() as PluginEngine;
	};
	return {
		engine,
		plugin,
		sawThunk: () => resolve !== undefined,
		threads: () => threads,
	};
}

function harness() {
	const adapter = memoryAdapter();
	const { engine, plugin, sawThunk, threads } = capture();
	const claw = owned({
		cronHandler: false,
		database: adapter,
		engine: sqlEngine({
			store: createSqlEngineStore(adapter),
			workerId: "w1",
			cron: false,
		}),
		model: textModel("done"),
		// These tests are about the engine handle, not tokenization, so the posture is stated rather
		// than incidental — a database-backed claw must choose one.
		redaction: { posture: "raw" },
		plugins: [plugin],
	} as Parameters<typeof owned>[0]);
	return { claw, engine, sawThunk, threads };
}

describe("a plugin's engine handle", () => {
	it("is a thunk at configure time, and a working engine after", async () => {
		const { engine, sawThunk } = harness();
		expect(sawThunk()).toBe(true);

		const started = await engine().startRun({
			prompt: "go",
			run: { principal: userPrincipal("alice") },
		});
		expect(started.id).toEqual(expect.any(String));
	});

	it("carries the run READ MODEL, not just the verbs", async () => {
		// `runs` lives on the engine INSTANCE and the verbs on the HANDLE. Passing only the handle
		// made `engine.runs?.get()` silently undefined — an optional chain over an absent thing, no
		// throw, and every status a plugin reported read "unknown" forever.
		const { engine } = harness();
		const started = await engine().startRun({
			prompt: "go",
			run: { principal: userPrincipal("alice") },
		});
		expect(await engine().runs?.get(started.id)).not.toBeNull();
	});

	it("keeps the assistant's ANSWER out of the run's event history", async () => {
		// The method that looks like operational history is the one with the most content in it:
		// `run.completed` carries `{ taskId, result }`, and `result` is the terminal RuntimeResult —
		// the answer. `get` was filtered and this was not, so the leak sat behind the one call whose
		// name suggests it holds nothing interesting.
		const { claw, engine } = harness();
		const started = await engine().startRun({
			prompt: "go",
			run: { principal: userPrincipal("alice") },
		});
		// Drive it, so there is a terminal result to leak.
		await (
			claw as unknown as {
				$context: { engine?: { work?: () => Promise<unknown> } };
			}
		).$context.engine?.work?.();

		const events = await (
			engine() as unknown as {
				runs?: { events: (id: string) => Promise<{ payload: unknown }[]> };
			}
		).runs?.events(started.id);

		expect(events?.length ?? 0).toBeGreaterThan(0);
		// `done` is what textModel answers. Operational keys survive; the answer does not.
		expect(JSON.stringify(events)).not.toContain("done");
	});

	it("serves every run FACT and none of its CONTENT", async () => {
		const { engine } = harness();
		const started = await engine().startRun({
			prompt: "go",
			ctx: { secret: "the customer's account number" },
			run: { principal: userPrincipal("alice") },
		});

		const seen = await engine().runs?.get(started.id);

		// The facts a plugin legitimately needs — status, whose authority it runs as.
		expect(seen?.status).toEqual(expect.any(String));
		expect(seen?.principal).toBe(userPrincipal("alice"));
		// And the ctx is gone. EMPTY rather than absent: `input` is required on the record type, so a
		// plugin reading it gets "nothing here" instead of a TypeError on the one path where a ctx
		// happened to be set.
		expect(seen?.input).toEqual({});
		expect(JSON.stringify(seen)).not.toContain("account number");
	});
});

describe("a plugin's threads carry its name", () => {
	it("stamps `core` on a thread the api opened, and the plugin's id on one it opened", async () => {
		const { claw, threads } = harness();
		const agent = (
			claw as unknown as {
				api: {
					createClaw: (i: {
						id: string;
						name: string;
					}) => Promise<{ id: string }>;
					createThread: (i: {
						id: string;
						clawId: string;
					}) => Promise<{ id: string }>;
					listThreads: (i: { clawId: string }) => Promise<{ id: string }[]>;
				};
			}
		).api;
		const made = await agent.createClaw({ id: "claw-t", name: "A" });
		await agent.createThread({ id: "t-core", clawId: made.id });

		// The plugin opens one through its own bound store view — the thing that stamps its id.
		await threads()?.create({ id: "t-plugin", clawId: made.id });

		// The default list is the conversations a person started — the plugin's is not in it.
		const listed = await agent.listThreads({ clawId: made.id });
		expect(listed.map((t) => t.id)).toEqual(["t-core"]);
	});
});
