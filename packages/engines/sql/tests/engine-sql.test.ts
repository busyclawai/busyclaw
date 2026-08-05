import type { RunStreamChunk, RunStreamPort } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import {
	createRuntime,
	type Runtime,
	type RuntimeModel,
} from "@busyclaw/runtime";
import { memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	createSqlEngineStore,
	createSqlEngineWorker,
	RUNTIME_CONTINUE_RUN_TASK,
	RUNTIME_RESUME_RUN_TASK,
	RUNTIME_RUN_TASK,
	sqlEngine,
	sqlEngineModels,
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

/**
 * A `Runtime` for the engine, completed with the doors the engine must never open.
 *
 * The engine drives `generate` and `continueRun`; every stub here supplied only those and was
 * accepted because nothing typechecked the tests. Filling the rest with throws keeps the stub honest
 * about what the engine uses AND turns "the engine reached for something else" into a failure the
 * test reports, instead of a method that is quietly absent at runtime.
 */
function engineRuntime(parts: Partial<Runtime>): Runtime {
	const unreachable = (door: string) => () => {
		throw new Error(`the engine must not call runtime.${door}`);
	};
	return {
		generate: unreachable("generate"),
		stream: unreachable("stream"),
		continueRun: unreachable("continueRun"),
		resumeRun: unreachable("resumeRun"),
		catalog: { tools: [], find: unreachable("catalog.find") },
		...parts,
	} as Runtime;
}

describe("@busyclaw/engine-sql", () => {
	// THE SPLIT, from this side. `sqlEngineSchema` still names all five so a hand-wired host keeps
	// working, but only three of them are THIS ENGINE'S to declare — the other two are core, because
	// `run` is the governance record (authz parent, tenancy anchor, control latch) that any engine
	// needs, not scheduling state. `models` is what `getBusyclawTables` reads off the factory.
	it("declares only its own scheduling tables on the factory", () => {
		expect(Object.keys(sqlEngineModels).sort()).toEqual([
			"idempotency_key",
			"lease",
			"runtime_task",
		]);
		// Declaring `run` here would collide with the core model and throw at assembly — the fork this
		// split exists to prevent.
		expect(Object.keys(sqlEngineModels)).not.toContain("run");
		// …while the full set a SQL deployment ends up with still reads as five.
		expect(Object.keys(sqlEngineSchema).sort()).toEqual([
			"idempotency_key",
			"lease",
			"run",
			"run_event",
			"runtime_task",
		]);
	});

	it("derives its storage schema from entity fields", () => {
		expect(sqlEngineSchema.run?.fields.input).toMatchObject({
			type: "json",
			required: true,
		});
		expect(sqlEngineSchema.runtime_task?.fields.status).toMatchObject({
			type: "string",
			required: true,
			index: true,
		});
		expect(sqlEngineSchema.idempotency_key?.fields.responseBody).toMatchObject({
			type: "json",
			required: true,
		});
	});

	it("claims, heartbeats, and completes a task with a single-use lease token", async () => {
		let current = "2026-01-01T00:00:00.000Z";
		const store = createSqlEngineStore(memoryAdapter(), { now: () => current });
		const run = await store.createRun({
			input: { prompt: "hello" },
			principal: userPrincipal("alice"),
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
		const run = await store.createRun({
			principal: userPrincipal("alice"),
		});

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
			scope: "organization",
			scopeId: "organization-1",
			principal: userPrincipal("alice"),
			requestHash,
			responseStatus: 202,
			responseBody: { runId: run.id },
		});

		const replay = await store.getIdempotency({
			key: "idem-1",
			method: "POST",
			path: "/runs",
			scope: "organization",
			scopeId: "organization-1",
			principal: userPrincipal("alice"),
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
				scope: "organization",
				scopeId: "organization-1",
				principal: userPrincipal("alice"),
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
			principal: userPrincipal("alice"),
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
		const runtime = engineRuntime({
			generate: async (_prompt, _ctx, options) => {
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
		});
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
		// M-08 changed what a failed task RECORDS. `lastError` is durable plaintext — it outlives the
		// run, rides into the `task.failed` event, and erasure can never reach it — so an unauthored
		// exception must not travel in it. A driver error carrying SQL, or a provider failure echoing
		// the content it choked on, would otherwise be written to the database verbatim.
		const dead = await store.getTask(task.id);
		expect(dead).toMatchObject({ status: "dead" });
		expect(dead?.lastError).toMatch(/^internal error \[/);
		expect(dead?.lastError).not.toContain("provider down");
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

	/**
	 * `model` and `runMode` ride the RUN ROW, and the worker reads them back on every claim.
	 *
	 * `runMode` is the one that fails silently if this regresses, which is why it is asserted here
	 * rather than left to the door's tests. `authz/src/system-posture.ts` grants a system-posture
	 * write an exemption when `runMode == "interactive"`; the worker leaving it unset defaults the
	 * run to `autonomous`, so a chat turn routed through the engine would quietly lose that exemption
	 * and writes that used to pass would begin demanding confirmation. That fails CLOSED, so nothing
	 * would report it — the turn would just start behaving differently.
	 */
	it("worker drives a run with the model and runMode from its row", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		let seen: { model?: unknown; runMode?: unknown } | undefined;
		const runtime = engineRuntime({
			generate: async (_prompt, _ctx, options) => {
				seen = {
					model: (options as { model?: unknown } | undefined)?.model,
					runMode: (options as { runMode?: unknown } | undefined)?.runMode,
				};
				return { status: "completed", text: "ok", steps: 1 };
			},
		});
		const worker = createSqlEngineWorker({
			store,
			runtime,
			workerId: "worker-1",
		});
		const run = await store.createRun({
			input: { prompt: "hello" },
			model: "fast",
			runMode: "interactive",
		});
		await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
			maxAttempts: 1,
		});

		await worker.tick();

		// Without the row→options wiring both read `undefined`, and the runtime defaults runMode to
		// "autonomous" — the silent downgrade this test exists to catch.
		expect(seen).toEqual({ model: "fast", runMode: "interactive" });
		expect(await store.getRun(run.id)).toMatchObject({
			model: "fast",
			runMode: "interactive",
		});
	});

	/**
	 * A ZOMBIE AND ITS SUCCESSOR WRITE THE SAME LOG, and the watcher can still tell them apart.
	 *
	 * The stream buffer sits OUTSIDE the lease fence — every durable write is fenced by
	 * `validateLease`, a KV handle is not — so a driver whose lease lapsed keeps appending its own
	 * generation while the replica that took the run appends the real one. Without a discriminator
	 * those interleave into one visible sentence built from two different answers.
	 *
	 * The fix is a tag, not a partition: `{runId, attempt}` on every chunk plus a `superseded`
	 * lifecycle from the successor. A client keeps the highest attempt per run and drops the rest,
	 * which is also the honest rendering — the answer really did restart.
	 */
	it("marks a second attempt superseded so a lapsed driver's chunks can be dropped", async () => {
		let current = "2026-01-01T00:00:00.000Z";
		const store = createSqlEngineStore(memoryAdapter(), { now: () => current });
		const appended: Array<{ key: string; chunk: RunStreamChunk }> = [];
		const runStream: RunStreamPort = {
			append: async (key, chunk) => {
				appended.push({ key, chunk });
				return appended.length;
			},
			read: async () => ({ chunks: [], cursor: "0", stale: false }),
		};
		const worker = createSqlEngineWorker({
			store,
			runtime: engineRuntime({
				generate: async () => ({
					status: "completed",
					text: "the real answer",
					steps: 1,
				}),
			}),
			workerId: "worker-2",
			runStream,
		});

		const run = await store.createRun({ input: { prompt: "hello" } });
		await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
			maxAttempts: 3,
		});
		// Driver one takes it and then freezes past its lease — the case the heartbeat cannot see.
		await store.claimDueTask({ workerId: "worker-1", leaseTtlMs: 1_000 });
		current = "2026-01-01T00:00:02.000Z";
		await store.reapExpiredLeases();
		current = "2026-01-01T00:00:03.000Z";

		// The SUCCESSOR drives it, on attempt 2.
		await worker.tick();

		// It announced the restart BEFORE any of its own text, which is the ordering a client needs:
		// drop everything below this attempt for this run, then render forward.
		const superseded = appended.findIndex(
			(entry) =>
				entry.chunk.kind === "lifecycle" && entry.chunk.event === "superseded",
		);
		const firstText = appended.findIndex(
			(entry) => entry.chunk.kind === "text",
		);
		expect(superseded).toBeGreaterThanOrEqual(0);
		expect(firstText).toBeGreaterThan(superseded);
		// And every chunk it wrote is tagged with the attempt that produced it, so a zombie still
		// appending as attempt 1 is separable rather than spliced.
		expect(appended.every((entry) => entry.chunk.attempt === 2)).toBe(true);
		expect(appended.every((entry) => entry.chunk.runId === run.id)).toBe(true);
	});

	it("worker validates runtime results before persisting them", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = engineRuntime({
			generate: async () => ({ status: "wat", text: "", steps: 1 }) as never,
			continueRun: async () => null,
		});
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
			"runtime.generate result invalid",
		);
	});

	it("worker parks a run when runtime.run waits for approval", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = engineRuntime({
			generate: async () => ({
				status: "waiting_approval",
				text: "",
				steps: 1,
				approvalIds: ["ap1"],
			}),
			continueRun: async () => null,
		});
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
		const runtime = engineRuntime({
			generate: async () => ({ status: "completed", text: "", steps: 1 }),
			continueRun: async (id) => {
				resumed = id;
				return { status: "completed", text: "sent", steps: 2 };
			},
		});
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
		const runtime = engineRuntime({
			generate: async () => ({ status: "completed", text: "done", steps: 1 }),
			continueRun: async () => null,
			resumeRun: async () => null,
		});
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
		const runtime = engineRuntime({
			generate: async () => ({
				status: "yielded",
				text: "",
				steps: 1,
				checkpointId: "cp-1",
			}),
			continueRun: async () => null,
			resumeRun: async () => null,
		});
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
		const runtime = engineRuntime({
			generate: async () => ({ status: "completed", text: "", steps: 1 }),
			continueRun: async () => null,
			resumeRun: async (checkpointId) => {
				resumedFrom = checkpointId;
				return { status: "completed", text: "done", steps: 3 };
			},
		});
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

	// Was: "worker fails a continuation whose checkpoint is not consumable" — which asserted the kill.
	// A null from resumeRun means the checkpoint is held by a live attempt or already retired by one.
	// Neither is THIS run's failure, and treating it as one dead-lettered the task and rewrote a
	// healthy run as `failed`. The task is retired; the run is left for whoever actually owns it.
	it("worker SKIPS a resume whose checkpoint is claimed or spent, leaving the run alone", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const runtime = engineRuntime({
			generate: async () => ({ status: "completed", text: "", steps: 1 }),
			continueRun: async () => null,
			resumeRun: async () => null,
		});
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

		expect(result.status).toBe("skipped");
		// THE DECISIVE ASSERTION: the run is not condemned. This is what shipped as `failed`, on a run
		// whose transcript was intact and whose only crime was being named by a duplicate task.
		expect((await store.getRun(run.id))?.status).not.toBe("failed");
		// The task itself is retired rather than left to be re-claimed forever.
		expect((await store.getTask(task.id))?.status).toBe("completed");
		expect((await store.getTask(task.id))?.lastError).toBeUndefined();

		// The claim moved a non-terminal run to `running`, which is correct and stays. What it no longer
		// does is move a TERMINAL one — see "a claim never resurrects a run that already finished".
		expect((await store.getRun(run.id))?.status).toBe("running");
	});

	// `claimDueTask` used to end with an UNCONDITIONAL `updateRun(runId, "running")` that never looked
	// at the run. A task claimed after its run had finished — a duplicate, a late arm, a stop that
	// landed mid-claim — wrote `completed` back to `running` and left it there, contradicting the run's
	// own event stream. Worse for cancellation: a cancelled run silently went back to work.
	it("a claim never resurrects a run that already finished", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
		});
		// The run finishes while this task is still sitting pending.
		await store.updateRun(run.id, { status: "completed" });

		expect(await store.claimDueTask({ workerId: "worker-1" })).toBeNull();
		// The run keeps the status it earned…
		expect((await store.getRun(run.id))?.status).toBe("completed");
		// …and the task is retired rather than left to be re-claimed forever.
		expect((await store.getTask(task.id))?.status).toBe("dead");
	});

	it("updateRunIfStatus is a CAS — it returns null and writes nothing when the run moved on", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const run = await store.createRun({ input: { prompt: "hello" } });
		await store.updateRun(run.id, { status: "cancelled" });

		expect(
			await store.updateRunIfStatus(run.id, {
				from: ["queued", "running", "waiting"],
				patch: { status: "running" },
			}),
		).toBeNull();
		expect((await store.getRun(run.id))?.status).toBe("cancelled");

		// …and it DOES write when the run is still in one of `from`.
		await store.updateRun(run.id, { status: "queued" });
		expect(
			await store.updateRunIfStatus(run.id, {
				from: ["queued", "running", "waiting"],
				patch: { status: "running" },
			}),
		).toMatchObject({ status: "running" });
	});
});

// R-M10. A continuation used to CREATE a run, unconditionally — so a resumed run got a SECOND engine
// row while the runtime restored the original `runId` from the checkpoint. Two identities for one
// logical run: "what did run X do?" had two answers depending on which id you held, and the row that
// recorded the park was not the row that recorded the resume, so neither told the whole story.
describe("a continuation continues the run that parked (R-M10)", () => {
	const engineOver = (store: ReturnType<typeof createSqlEngineStore>) =>
		sqlEngine({ store }).create(
			engineRuntime({
				generate: async () => ({ status: "completed", text: "ok", steps: 1 }),
				continueRun: async () => null,
			}),
		).engine;

	it("enqueues against the ORIGINAL run rather than forking a second identity", async () => {
		const store = createSqlEngineStore(memoryAdapter());
		const engine = engineOver(store);

		const parked = await store.createRun({ input: { prompt: "hello" } });
		const handle = await engine.proceedRun({
			runId: parked.id,
			proceed: { kind: "approval", approvalId: "appr-1" },
		});

		// SAME id — not a new row beside it.
		expect(handle.id).toBe(parked.id);
		// …and it is queued again, so a worker picks it up rather than seeing work already in flight.
		expect((await store.getRun(parked.id))?.status).toBe("queued");
	});

	// Delivered twice, it finds what the first left and adds work to it — it does not fork a third.
	// It must also not schedule the work TWICE: the task id is derived from (runId, kind, approvalId)
	// so the second insert loses at the database. Before that, each call minted its own id; the first
	// task consumed the approval, the second found it spent, threw, dead-lettered under maxAttempts 1,
	// and rewrote a correctly-resumed run as `failed`. Two clicks on one approve button.
	it("is idempotent in run identity AND schedules exactly one slice", async () => {
		const inner = memoryAdapter();
		const store = createSqlEngineStore(inner);
		const engine = engineOver(store);
		const parked = await store.createRun({ input: { prompt: "hello" } });

		const first = await engine.proceedRun({
			runId: parked.id,
			proceed: { kind: "approval", approvalId: "appr-1" },
		});
		const second = await engine.proceedRun({
			runId: parked.id,
			proceed: { kind: "approval", approvalId: "appr-1" },
		});
		expect(first.id).toBe(parked.id);
		expect(second.id).toBe(parked.id);

		const tasks = await inner.findMany({
			model: "runtime_task",
			where: [{ field: "runId", value: parked.id }],
		});
		expect(tasks).toHaveLength(1);
	});

	// A different approval on the same run is different work and gets its own task — the derived id
	// must dedupe the repeat, not collapse two genuine continuations into one.
	it("a second APPROVAL on the same run schedules its own slice", async () => {
		const inner = memoryAdapter();
		const store = createSqlEngineStore(inner);
		const engine = engineOver(store);
		const parked = await store.createRun({ input: { prompt: "hello" } });

		await engine.proceedRun({
			runId: parked.id,
			proceed: { kind: "approval", approvalId: "appr-1" },
		});
		await engine.proceedRun({
			runId: parked.id,
			proceed: { kind: "approval", approvalId: "appr-2" },
		});

		const tasks = await inner.findMany({
			model: "runtime_task",
			where: [{ field: "runId", value: parked.id }],
		});
		expect(tasks).toHaveLength(2);
	});

	// Resetting a finished run to `queued` resurrects it, and the slice that follows can only fail —
	// so a stale continuation could turn `completed` into `failed`. Refuse loudly instead.
	it("refuses to continue a run that is already terminal", async () => {
		const store = createSqlEngineStore(memoryAdapter());
		const engine = engineOver(store);
		const done = await store.createRun({ input: { prompt: "hello" } });
		await store.updateRun(done.id, { status: "completed" });

		await expect(
			engine.proceedRun({
				runId: done.id,
				proceed: { kind: "approval", approvalId: "appr-1" },
			}),
		).rejects.toThrow("already terminal");
		// …and the run keeps the status it earned.
		expect((await store.getRun(done.id))?.status).toBe("completed");
	});

	// CHANGED, deliberately. A continuation that could not find its run used to CREATE one — the last
	// residue of the R-M10 fork, since the runtime would then restore the original id from the record
	// and the run that recorded the resume was not the run that recorded the park. There is nothing to
	// continue when there is no run, so say so.
	it("refuses to proceed a run that does not exist, rather than inventing one", async () => {
		const store = createSqlEngineStore(memoryAdapter());
		await expect(
			engineOver(store).proceedRun({
				runId: "no-such-run",
				proceed: { kind: "approval", approvalId: "appr-1" },
			}),
		).rejects.toThrow("no such run");
	});
});

// "The host vanished" and "the work is bad" used to be one row: the reaper spent the same counter a
// real failure did, so a flapping worker exhausted a run's error budget without the run ever having
// failed, and the run was written `failed` with a free-text `lastError` as the only clue which had
// happened. Two counters, two limits, two stories.
describe("a lapse is not a failure", () => {
	/** A clock that always moves forward — every claim has to clear the previous retry delay. */
	function clockAt(startMs: number) {
		let ms = startMs;
		return {
			now: () => new Date(ms).toISOString(),
			advance: (by: number) => {
				ms += by;
			},
		};
	}

	it("a lease lapse spends a CLAIM, leaves the error budget alone, and does not fail the run", async () => {
		const clock = clockAt(0);
		const store = createSqlEngineStore(memoryAdapter(), { now: clock.now });
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
		});

		await store.claimDueTask({ workerId: "w1", leaseTtlMs: 1_000 });
		clock.advance(10_000);
		expect(await store.reapExpiredLeases()).toBe(1);

		const after = await store.getTask(task.id);
		expect(after?.status).toBe("pending"); // requeued, not dead
		expect(after?.attempt).toBe(1); // a claim was spent…
		expect(after?.errorAttempt ?? 0).toBe(0); // …and no error was
		expect((await store.getRun(run.id))?.status).not.toBe("failed");
	});

	it("a REAL failure spends the error budget and dead-letters at maxAttempts", async () => {
		const clock = clockAt(0);
		const store = createSqlEngineStore(memoryAdapter(), { now: clock.now });
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
			maxAttempts: 2,
		});

		for (let i = 0; i < 2; i++) {
			const claim = await store.claimDueTask({ workerId: "w1" });
			if (!claim) throw new Error(`expected a claim on attempt ${i + 1}`);
			await store.failTask({
				taskId: task.id,
				leaseToken: claim.leaseToken,
				reason: "provider down",
			});
			clock.advance(10_000); // clear the retry delay before the next claim
		}
		const dead = await store.getTask(task.id);
		expect(dead?.status).toBe("dead");
		expect(dead?.errorAttempt).toBe(2);
		expect(dead?.lastError).toBe("provider down");
	});

	it("a task that keeps losing its lease is abandoned by CLAIMS, and says so", async () => {
		const clock = clockAt(0);
		const store = createSqlEngineStore(memoryAdapter(), { now: clock.now });
		const run = await store.createRun({ input: { prompt: "hello" } });
		const task = await store.enqueueTask({
			runId: run.id,
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
		});

		// Eight claims, every one lost to a vanished host. No failure is ever reported.
		for (let i = 0; i < 8; i++) {
			const claim = await store.claimDueTask({
				workerId: "w1",
				leaseTtlMs: 1_000,
			});
			if (!claim) throw new Error(`expected a claim on attempt ${i + 1}`);
			clock.advance(10_000); // past the lease
			await store.reapExpiredLeases();
			clock.advance(10_000); // and past the retry delay the reap just set
		}

		const abandoned = await store.getTask(task.id);
		expect(abandoned?.status).toBe("dead");
		expect(abandoned?.errorAttempt ?? 0).toBe(0); // still never failed
		// The reason distinguishes a crash loop from bad work — the whole point of splitting them.
		expect(abandoned?.lastError).toContain("claims without completing");
		expect((await store.getRun(run.id))?.status).toBe("failed");
	});
});

// R-M10. The reaper CONSUMED the lease first — deleted it — and transitioned the task after. A
// process dying between those two left the task `leased` with a `leaseId` pointing at a row that no
// longer existed: no lease left to expire, and the claim query only looks at `pending`, so the task
// was stranded forever. Recovery state destroyed before the successor state was durable.
describe("the lease reaper does not destroy recovery state first (R-M10)", () => {
	const expiredLease = async (
		store: ReturnType<typeof createSqlEngineStore>,
		maxAttempts = 1,
	) => {
		const run = await store.createRun({ input: { prompt: "hello" } });
		await store.enqueueTask({
			kind: RUNTIME_RUN_TASK,
			payload: { prompt: "hello" },
			runId: run.id,
			maxAttempts,
		});
		// Claimed with a lease that has already lapsed by the time it is swept.
		const claimed = await store.claimDueTask({
			workerId: "w1",
			leaseTtlMs: -1,
		});
		if (!claimed) throw new Error("expected a claim");
		return claimed;
	};

	it("returns the task to the queue when it reaps, and drops the lease after", async () => {
		const inner = memoryAdapter();
		const store = createSqlEngineStore(inner);
		// maxAttempts 2, so an expired first attempt is retryable rather than terminal.
		const claimed = await expiredLease(store, 2);

		expect(await store.reapExpiredLeases()).toBe(1);

		// Back in the queue — `pending`, no lease, and due again after its retry delay. That is what a
		// stranded task never became: it stayed `leased` pointing at a row that no longer existed, and
		// the claim query only ever looks at `pending`.
		const task = (await inner.findOne({
			model: "runtime_task",
			where: [{ field: "id", value: claimed.task.id }],
		})) as { status: string; leaseId: string | null } | null;
		expect(task?.status).toBe("pending");
		expect(task?.leaseId).toBeNull();
		// …and the lease row went AFTER the transition, not before it.
		const leases = await inner.findMany({ model: "lease", where: [] });
		expect(leases.map((row) => (row as { id: string }).id)).not.toContain(
			claimed.leaseId,
		);
	});

	// The CAS is what keeps two reapers from both retiring one lease — and what keeps a reaper from
	// retiring a lease whose task has already moved on. Consuming the lease first meant the loser had
	// already destroyed the evidence before discovering it had lost.
	it("does no work when the task no longer names the lease it is reaping", async () => {
		const inner = memoryAdapter();
		const store = createSqlEngineStore(inner);
		const claimed = await expiredLease(store, 2);

		// Somebody else got there first: the task no longer points at this lease.
		await inner.update({
			model: "runtime_task",
			where: [{ field: "id", value: claimed.task.id }],
			update: { status: "pending", leaseId: null },
		});

		expect(await store.reapExpiredLeases()).toBe(0);
		// …and the LEASE SURVIVES. This is the property, not the count: consuming it first meant a
		// reaper that lost the race had already destroyed the evidence before discovering it had lost.
		const leases = await inner.findMany({ model: "lease", where: [] });
		expect(leases).toHaveLength(1);
	});
});
