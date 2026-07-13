import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	ClawEngineFactory,
	ClawEngineHandle,
	ClawRunReadModel,
} from "../src/index";
import { drainWork } from "../src/index";

type RuntimeLike = {
	run: (prompt: string) => Promise<{ prompt: string; status: "ok" }>;
	continueRun: (id: string) => Promise<{ id: string; status: "ok" }>;
};

type WorkResult = {
	processed: number;
	status: "drained";
};

type ExampleHandle = ClawEngineHandle<WorkResult> & {
	kind: "example";
	work: () => Promise<WorkResult>;
};

const runs: ClawRunReadModel = {
	get: async (id) => ({
		id,
		status: "completed",
		input: { prompt: "hello" },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	}),
	events: async (runId) => [
		{
			id: "event-1",
			runId,
			type: "run.completed",
			payload: { ok: true },
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	],
};

function runtimeLike(calls: string[]): RuntimeLike {
	return {
		run: async (prompt) => {
			calls.push(`run:${prompt}`);
			return { prompt, status: "ok" };
		},
		continueRun: async (id) => {
			calls.push(`continue:${id}`);
			return { id, status: "ok" };
		},
	};
}

function exampleEngine(): ClawEngineFactory<RuntimeLike, ExampleHandle> {
	return {
		kind: "example",
		create: (runtime) => ({
			engine: {
				kind: "example",
				startRun: async (input) => {
					await runtime.run(input.prompt);
					return { id: input.run?.id ?? "run-1" };
				},
				continueRun: async (input) => {
					await runtime.continueRun(input.approvalId);
					return { id: input.run?.id ?? "continue-1" };
				},
				work: async () => ({ processed: 1, status: "drained" }),
			},
			runs,
		}),
	};
}

describe("engine-core contract", () => {
	it("keeps engine factories generic over runtime-like objects", async () => {
		const calls: string[] = [];
		const factory = exampleEngine();
		const instance = factory.create(runtimeLike(calls));
		const { engine } = instance;

		expect(factory.kind).toBe("example");
		expect(engine.kind).toBe("example");
		await expect(
			engine.startRun({
				ctx: { team: "acme" },
				prompt: "hello",
				run: { principal: "alice", id: "run-id", team: "acme" },
			}),
		).resolves.toEqual({ id: "run-id" });
		await expect(
			engine.continueRun({
				approvalId: "approval-1",
				ctx: { team: "acme" },
				run: { id: "continue-id" },
			}),
		).resolves.toEqual({ id: "continue-id" });
		await expect(engine.work()).resolves.toEqual({
			processed: 1,
			status: "drained",
		});
		expect(calls).toEqual(["run:hello", "continue:approval-1"]);

		expectTypeOf(factory.kind).toEqualTypeOf<"example">();
		expectTypeOf(engine.work).toEqualTypeOf<() => Promise<WorkResult>>();
		expect(await instance.runs?.get("run-id")).toMatchObject({
			id: "run-id",
			status: "completed",
		});
	});

	it("allows managed engines to omit explicit worker lifecycle", () => {
		const engine: ClawEngineHandle = {
			kind: "managed",
			continueRun: async () => ({ id: "continue-1" }),
			startRun: async () => ({ id: "run-1" }),
		};

		expect(engine.work).toBeUndefined();
	});

	it("drains work until idle or a bounded limit", async () => {
		const queue = [
			{ status: "completed", id: "task-1" },
			{ status: "completed", id: "task-2" },
			{ status: "idle" },
		];

		await expect(
			drainWork({
				work: async () => queue.shift(),
			}),
		).resolves.toEqual({
			processed: 2,
			results: [
				{ status: "completed", id: "task-1" },
				{ status: "completed", id: "task-2" },
			],
			status: "idle",
		});

		let calls = 0;
		await expect(
			drainWork({
				limit: 2,
				work: async () => ({ status: "completed", id: `task-${++calls}` }),
			}),
		).resolves.toMatchObject({ processed: 2, status: "limit" });

		await expect(
			drainWork({ limit: 0, work: async () => ({ status: "idle" }) }),
		).rejects.toThrow(/positive integer/);
	});
});
