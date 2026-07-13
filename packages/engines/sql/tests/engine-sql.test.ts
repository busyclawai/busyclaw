import {
	createRuntime,
	type Runtime,
	type RuntimeModel,
} from "@euroclaw/runtime";
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	createSqlEngineStore,
	createSqlEngineWorker,
	RUNTIME_CONTINUE_RUN_TASK,
	RUNTIME_RESUME_RUN_TASK,
	RUNTIME_RUN_TASK,
	sqlEngine,
	sqlEngineSchema,
} from "../src/index";

function textModel(text: string): RuntimeModel {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			},
			warnings: [],
		}),
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

function failingModel(message: string): RuntimeModel {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error(message);
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

describe("@euroclaw/engine-sql", () => {
	it("derives its storage schema from entity fields", () => {
		expect(sqlEngineSchema.run.fields.input).toMatchObject({
			type: "json",
			required: true,
		});
		expect(sqlEngineSchema.runtime_task.fields.status).toMatchObject({
			type: "string",
			required: true,
			index: true,
		});
		expect(sqlEngineSchema.idempotency_key.fields.responseBody).toMatchObject({
			type: "json",
			required: true,
		});
	});

	it("claims, heartbeats, and completes a task with a single-use lease token", async () => {
		let current = "2026-01-01T00:00:00.000Z";
		const store = createSqlEngineStore(memoryAdapter(), { now: () => current });
		const run = await store.createRun({
			input: { prompt: "hello" },
			principal: "user:alice",
			team: "acme",
		});
		const task = await store.enqueueTask({ runId: run.id, kind: "turn" });

		const claim = await store.claimDueTask({
			workerId: "worker-1",
			leaseTtlMs: 1_000,
		});
		expect(claim?.task.id).toBe(task.id);
		expect(claim?.task.status).toBe("leased");
		expect(claim?.task.attempt).toBe(1);
		expect(await store.claimDueTask({ workerId: "worker-2" })).toBeNull();

		if (!claim) throw new Error("missing claim");
		current = "2026-01-01T00:00:00.500Z";
		expect(
			await store.heartbeatLease({ leaseId: claim.leaseId, leaseToken: "bad" }),
		).toBeNull();
		const heartbeat = await store.heartbeatLease({
			leaseId: claim.leaseId,
			leaseToken: claim.leaseToken,
			leaseTtlMs: 2_000,
		});
		expect(heartbeat?.expiresAt).toBe("2026-01-01T00:00:02.500Z");

		expect(
			await store.completeTask({ taskId: task.id, leaseToken: "bad" }),
		).toBeNull();
		const completed = await store.completeTask({
			taskId: task.id,
			leaseToken: claim.leaseToken,
			output: { ok: true },
		});
		expect(completed?.status).toBe("completed");
		expect(completed?.output).toEqual({ ok: true });
	});

	it("reaps expired leases so tasks become claimable again", async () => {
		let current = "2026-01-01T00:00:00.000Z";
		const store = createSqlEngineStore(memoryAdapter(), { now: () => current });
		const run = await store.createRun();
		const task = await store.enqueueTask({
			runId: run.id,
			kind: "turn",
			maxAttempts: 3,
		});

		const first = await store.claimDueTask({
			workerId: "worker-1",
			leaseTtlMs: 1_000,
		});
		expect(first?.task.id).toBe(task.id);

		current = "2026-01-01T00:00:02.000Z";
		expect(await store.reapExpiredLeases()).toBe(1);
		expect(await store.claimDueTask({ workerId: "worker-2" })).toBeNull();

		current = "2026-01-01T00:00:03.000Z";
		const second = await store.claimDueTask({ workerId: "worker-2" });
		expect(second?.task.id).toBe(task.id);
		expect(second?.task.attempt).toBe(2);
	});

	it("fails leased tasks with retry and then dead-letters after max attempts", async () => {
		let current = "2026-01-01T00:00:00.000Z";
		const store = createSqlEngineStore(memoryAdapter(), { now: () => current });
		const run = await store.createRun();
		const task = await store.enqueueTask({
			runId: run.id,
			kind: "turn",
			maxAttempts: 2,
			retryDelayMs: 1_000,
		});

		const first = await store.claimDueTask({ workerId: "worker-1" });
		if (!first) throw new Error("missing first claim");
		const retry = await store.failTask({
			taskId: task.id,
			leaseToken: first.leaseToken,
			reason: "transient",
		});
		expect(retry?.status).toBe("pending");
		expect(retry?.dueAt).toBe("2026-01-01T00:00:01.000Z");

		current = "2026-01-01T00:00:01.000Z";
		const second = await store.claimDueTask({ workerId: "worker-2" });
		if (!second) throw new Error("missing second claim");
		const dead = await store.failTask({
			taskId: task.id,
			leaseToken: second.leaseToken,
			reason: "still broken",
		});
		expect(dead?.status).toBe("dead");
		expect(dead?.lastError).toBe("still broken");
	});

	it("stores runtime events and organization-scoped idempotency responses", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const run = await store.createRun({ principal: "user:alice", team: "acme" });

		await store.appendEvent({
			runId: run.id,
			type: "run.created",
			payload: { actor: "alice" },
		});
		expect(await store.events(run.id)).toMatchObject([
			{ type: "run.created", payload: { actor: "alice" } },
		]);

		const requestHash = store.requestHash({ prompt: "hello" });
		const saved = await store.saveIdempotency({
			key: "idem-1",
			method: "POST",
			path: "/runs",
			organizationId: "organization-1",
			actor: "alice",
			requestHash,
			responseStatus: 202,
			responseBody: { runId: run.id },
		});

		const replay = await store.getIdempotency({
			key: "idem-1",
			method: "POST",
			path: "/runs",
			organizationId: "organization-1",
			actor: "alice",
			requestHash,
		});
		expect(replay?.responseStatus).toBe(202);
		expect(replay?.id).toBe(saved.id);
		expect(replay?.responseBody).toEqual({ runId: run.id });
		await expect(
			store.saveIdempotency({
				key: "idem-1",
				method: "POST",
				path: "/runs",
				organizationId: "organization-1",
				actor: "alice",
				requestHash: store.requestHash({ prompt: "different" }),
				responseStatus: 202,
				responseBody: { runId: run.id },
			}),
		).rejects.toThrow(/different request body/);
	});

	it("validates persisted SQL engine rows after JSON decode", async () => {
		const adapter = memoryAdapter();
		const store = createSqlEngineStore(adapter);
		await adapter.create({
			model: "run",
			data: {
				id: "bad-run",
				status: "queued",
				input: "[]",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		// decoded through the entity layer, then rejected by its read validator (input must be an object)
		await expect(store.getRun("bad-run")).rejects.toThrow(/run record invalid/);
	});

	it("rejects non-JSON SQL engine inputs before serialization", async () => {
		const store = createSqlEngineStore(memoryAdapter());

		// the json payload is parsed at the write seam, before the record ever assembles
		await expect(
			store.createRun({ input: { amount: Number.NaN } }),
		).rejects.toThrow(/run input invalid/);
		await expect(
			store.enqueueTask({
				runId: "run-1",
				kind: "turn",
				payload: { nested: { fn: () => "nope" } } as never,
			}),
		).rejects.toThrow(/task payload invalid/);
	});

	it("worker claims a runtime.run task, executes runtime, and completes the run", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = createRuntime({ model: textModel("done") });
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({
			input: { prompt: "hello" },
			principal: "user:alice",
			team: "acme",
		});
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello", ctx: { team: "acme" } },
		});

		const result = await worker.tick();

		expect(result.status).toBe("completed");
		expect(await store.getRun(run.id)).toMatchObject({ status: "completed" });
		expect(await store.getTask(task.id)).toMatchObject({
			status: "completed",
			output: { result: { text: "done", steps: 1 } },
		});
		expect((await store.events(run.id)).map((event) => event.type)).toEqual([
			"run.started",
			"run.completed",
		]);
	});

	it("host bounded drain loop processes multiple queued SQL engine runs", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = createRuntime({ model: textModel("done") });
		const { engine, runs: readModel } = sqlEngine({
			store,
			workerId: "worker-1",
		}).create(runtime);
		const runs = await Promise.all([
			engine.startRun({ prompt: "first" }),
			engine.startRun({ prompt: "second" }),
			engine.startRun({ prompt: "third" }),
		]);
		const statuses: string[] = [];

		for (let i = 0; i < 10; i++) {
			const result = await engine.work();
			statuses.push(result.status);
			if (result.status === "idle") break;
		}

		expect(statuses).toEqual(["completed", "completed", "completed", "idle"]);
		await expect(store.getRun(runs[0].id)).resolves.toMatchObject({
			status: "completed",
		});
		await expect(store.getRun(runs[1].id)).resolves.toMatchObject({
			status: "completed",
		});
		await expect(store.getRun(runs[2].id)).resolves.toMatchObject({
			status: "completed",
		});
		await expect(readModel?.events(runs[0].id)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "run.completed" }),
			]),
		);
	});

	it("host bounded drain loop stops cleanly when SQL engine is idle", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = createRuntime({ model: textModel("done") });
		const { engine } = sqlEngine({ store, workerId: "worker-1" }).create(
			runtime,
		);
		let iterations = 0;
		let finalStatus = "not-run";

		for (let i = 0; i < 10; i++) {
			iterations++;
			const result = await engine.work();
			finalStatus = result.status;
			if (result.status === "idle") break;
		}

		expect(iterations).toBe(1);
		expect(finalStatus).toBe("idle");
	});

	it("worker aborts runtime and skips terminal persistence when heartbeat is lost", async () => {
		const baseStore = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const store = {
			...baseStore,
			heartbeatLease: async () => null,
		};
		let resolveAbort: () => void = () => {};
		const abortObserved = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		const runtime: Runtime = {
			run: async (_prompt, _ctx, options) => {
				const timers = globalThis as typeof globalThis & {
					setTimeout: (fn: () => void, ms: number) => unknown;
				};
				while (!options?.abortSignal?.aborted) {
					await new Promise<void>((resolve) => {
						timers.setTimeout(resolve, 10);
					});
				}
				resolveAbort();
				return { status: "completed", text: "should not persist", steps: 1 };
			},
			continueRun: async () => null,
		};
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
			leaseTtlMs: 1,
		});
		const run = await baseStore.createRun({ input: { prompt: "hello" } });
		const task = await baseStore.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
		});

		const result = await worker.tick();

		expect(result).toMatchObject({ status: "failed", task: null });
		if (result.status !== "failed") throw new Error("expected failed result");
		expect(result.reason).toContain("task lease lost during runtime execution");
		await abortObserved;
		const stalledTask = await baseStore.getTask(task.id);
		expect(stalledTask).toMatchObject({ status: "leased" });
		// A native record omits an unset optional rather than carrying an explicit `undefined`; no output
		// persisted is what "terminal write skipped" looks like here.
		expect(stalledTask?.output).toBeUndefined();
		expect(await baseStore.getRun(run.id)).toMatchObject({ status: "running" });
		expect((await baseStore.events(run.id)).map((event) => event.type)).toEqual(
			["run.started"],
		);
	});

	it("worker fails runtime.run tasks and dead-letters after max attempts", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = createRuntime({ model: failingModel("provider down") });
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
			maxAttempts: 1,
		});

		const result = await worker.tick();

		expect(result.status).toBe("failed");
		expect(await store.getRun(run.id)).toMatchObject({ status: "failed" });
		expect(await store.getTask(task.id)).toMatchObject({
			status: "dead",
			lastError: "provider down",
		});
		expect((await store.events(run.id)).map((event) => event.type)).toEqual([
			"run.started",
			"task.failed",
			"run.failed",
		]);
	});

	it("worker validates runtime task payloads before executing runtime", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = createRuntime({ model: textModel("should not run") });
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { ctx: { team: "acme" } },
			maxAttempts: 1,
		});

		const result = await worker.tick();

		expect(result.status).toBe("failed");
		expect(await store.getRun(run.id)).toMatchObject({ status: "failed" });
		expect(await store.getTask(task.id)).toMatchObject({
			status: "dead",
		});
		expect((await store.getTask(task.id))?.lastError).toContain(
			"runtime.run task payload invalid",
		);
	});

	it("worker validates runtime results before persisting them", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime: Runtime = {
			run: async () => ({ status: "wat", text: "", steps: 1 }) as never,
			continueRun: async () => null,
		};
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
			maxAttempts: 1,
		});

		const result = await worker.tick();

		expect(result.status).toBe("failed");
		expect(await store.getRun(run.id)).toMatchObject({ status: "failed" });
		expect((await store.getTask(task.id))?.lastError).toContain(
			"runtime.run result invalid",
		);
	});

	it("worker parks a run when runtime.run waits for approval", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime: Runtime = {
			run: async () => ({
				status: "waiting_approval",
				text: "",
				steps: 1,
				approvalIds: ["ap1"],
			}),
			continueRun: async () => null,
		};
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
		});

		const result = await worker.tick();

		expect(result).toMatchObject({
			status: "waiting_approval",
			approvalIds: ["ap1"],
		});
		expect(await store.getRun(run.id)).toMatchObject({ status: "waiting" });
		expect(await store.getTask(task.id)).toMatchObject({
			status: "completed",
			output: { result: { status: "waiting_approval", approvalIds: ["ap1"] } },
		});
		expect((await store.events(run.id)).map((event) => event.type)).toEqual([
			"run.started",
			"run.waiting_approval",
		]);
	});

	it("worker resumes an approved approval task", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		let resumed = "";
		const runtime: Runtime = {
			run: async () => ({ status: "completed", text: "", steps: 1 }),
			continueRun: async (id) => {
				resumed = id;
				return { status: "completed", text: "sent", steps: 2 };
			},
		};
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { approvalId: "ap1" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_CONTINUE_RUN_TASK,
			payload: { approvalId: "ap1" },
		});

		const result = await worker.tick();

		expect(result.status).toBe("completed");
		expect(resumed).toBe("ap1");
		expect(await store.getRun(run.id)).toMatchObject({ status: "completed" });
		expect(await store.getTask(task.id)).toMatchObject({
			status: "completed",
			output: {
				result: {
					status: "completed",
					text: "sent",
					steps: 2,
				},
			},
		});
		expect((await store.events(run.id)).map((event) => event.type)).toEqual([
			"run.started",
			"run.completed",
		]);
	});

	it("SQL engine cron task drains internal engine work", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = createRuntime({ model: textModel("done") });
		const instance = sqlEngine({
			cron: { limit: 2 },
			store,
			workerId: "worker-1",
		}).create(runtime);
		const task = instance.plugins?.[0]?.cron?.[0];
		if (!task) throw new Error("expected cron task");

		await instance.engine.startRun({ prompt: "hello" });
		const result = await task.handler({
			claw: {},
		});

		expect(result).toMatchObject({
			processed: 1,
			status: "idle",
		});
	});

	it("SQL engine can disable cron task contribution", () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = createRuntime({ model: textModel("done") });
		const instance = sqlEngine({ cron: false, store }).create(runtime);

		expect(instance.plugins?.[0]?.cron).toEqual([]);
	});

	it("tick claims nothing past the invocation deadline", async () => {
		// The deadline check reads the store's clock — the engine's single time source.
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:05:00.000Z",
		});
		const runtime: Runtime = {
			run: async () => ({ status: "completed", text: "done", steps: 1 }),
			continueRun: async () => null,
			resumeRun: async () => null,
		};
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
		});

		const result = await worker.tick({
			deadlineAt: "2026-01-01T00:04:00.000Z",
		});

		expect(result).toEqual({ status: "idle", reason: "deadline" });
		expect(await store.getTask(task.id)).toMatchObject({ status: "pending" });

		// The same tick with budget left claims and completes as usual.
		const second = await worker.tick({
			deadlineAt: "2026-01-01T00:06:00.000Z",
		});
		expect(second.status).toBe("completed");
	});

	it("worker completes a yielded slice and enqueues its continuation", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime: Runtime = {
			run: async () => ({
				status: "yielded",
				text: "",
				steps: 1,
				checkpointId: "cp-1",
			}),
			continueRun: async () => null,
			resumeRun: async () => null,
		};
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello", ctx: { team: "acme" } },
		});

		const result = await worker.tick();

		expect(result).toMatchObject({ status: "yielded", checkpointId: "cp-1" });
		expect(await store.getRun(run.id)).toMatchObject({ status: "queued" });
		expect(await store.getTask(task.id)).toMatchObject({ status: "completed" });
		const events = await store.events(run.id);
		expect(events.map((event) => event.type)).toEqual([
			"run.started",
			"run.yielded",
		]);
		expect(events[1]?.payload).toMatchObject({
			checkpointId: "cp-1",
			steps: 1,
		});

		// The continuation: same run, resume kind, original ctx carried forward.
		const claim = await store.claimDueTask({ workerId: "worker-2" });
		expect(claim?.task).toMatchObject({
			kind: RUNTIME_RESUME_RUN_TASK,
			runId: run.id,
			payload: { checkpointId: "cp-1", ctx: { team: "acme" } },
		});
	});

	it("worker executes a continuation task via runtime.resumeRun", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		let resumedFrom = "";
		const runtime: Runtime = {
			run: async () => ({ status: "completed", text: "", steps: 1 }),
			continueRun: async () => null,
			resumeRun: async (checkpointId) => {
				resumedFrom = checkpointId;
				return { status: "completed", text: "done", steps: 3 };
			},
		};
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RESUME_RUN_TASK,
			payload: { checkpointId: "cp-9" },
		});

		const result = await worker.tick();

		expect(result.status).toBe("completed");
		expect(resumedFrom).toBe("cp-9");
		expect(await store.getRun(run.id)).toMatchObject({ status: "completed" });
		expect(await store.getTask(task.id)).toMatchObject({
			status: "completed",
			output: { result: { status: "completed", text: "done", steps: 3 } },
		});
	});

	it("worker fails a continuation whose checkpoint is not consumable", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime: Runtime = {
			run: async () => ({ status: "completed", text: "", steps: 1 }),
			continueRun: async () => null,
			resumeRun: async () => null,
		};
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RESUME_RUN_TASK,
			payload: { checkpointId: "cp-gone" },
			maxAttempts: 1,
		});

		const result = await worker.tick();

		expect(result.status).toBe("failed");
		expect(await store.getRun(run.id)).toMatchObject({ status: "failed" });
		expect((await store.getTask(task.id))?.lastError).toContain(
			"run checkpoint is not consumable",
		);
	});
});
