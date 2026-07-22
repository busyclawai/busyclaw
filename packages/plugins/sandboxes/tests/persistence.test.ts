// Bounded filesystem persistence — the SandboxVolumeStore slice. The model is snapshot-at-the-
// boundary: the engine loads a bounded tree into memfs before the guest runs (sync node:fs), then
// saves the mutated tree after. A byte budget guards BOTH ends because memfs lives in the HOST heap,
// NOT the wasm cap — so a write-bomb would OOM the host without it (T5 is the DoS guard).
//
// T1–T3 drive the full runtime (scripted model → run_code) like e2e/pii; T4–T7 exercise the provider
// and the store directly, where the byte budgets and the envelope contract live.

import { createMemoryAudit } from "@euroclaw/core";
import { createRuntime } from "@euroclaw/runtime";
import type { wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import type {
	ExecutionResult,
	Sandbox,
	SandboxToolInvoker,
	VolumeTree,
} from "../src/core/contracts";
import { executeInSandbox, runCodeTool } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";
import { memoryVolumeStore } from "../src/storages/memory/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

// Emit ONE run_code call carrying `code`, then finish. (The e2e/pii scripted-model fixture.)
function runCodeOnce(code: string): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			const usage = {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			};
			if (step++ === 0) {
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "run_code",
							input: JSON.stringify({ code }),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: { unified: "stop", raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

// Observe-only wrapper (lifted from pii/nested-governance): delegates to a real quickjs provider and
// records the last ExecutionResult, so a runtime-level test can read exactly what the guest returned.
function recordingSandbox(): {
	sandbox: Sandbox;
	last: () => ExecutionResult | undefined;
} {
	const inner = quickjs();
	let captured: ExecutionResult | undefined;
	return {
		last: () => captured,
		sandbox: {
			provider: inner.provider,
			posture: inner.posture,
			validate: inner.validate,
			execute: async (input) => {
				const res = await inner.execute(input);
				captured = res.output;
				return res;
			},
		},
	};
}

const noInvoke: SandboxToolInvoker = {
	invoke: async () => {
		throw new Error("invoker should not be called");
	},
};

const WRITE = (path: string, content: string) =>
	`const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)}); return "wrote";`;
const READ_OR = (path: string, fallback: string) =>
	`const fs = await import("node:fs"); try { return fs.readFileSync(${JSON.stringify(path)}, "utf8"); } catch { return ${JSON.stringify(fallback)}; }`;

describe("@euroclaw/sandboxes bounded filesystem persistence", () => {
	// T1 — round-trip: run 1 writes /data.txt; run 2 with the SAME volumeRef reads it back. Proves the
	// snapshot-out (save) then snapshot-in (load) across two separate run_code calls (conversations).
	it("T1: a file written in one run is readable in the next under the same volumeRef", async () => {
		const store = memoryVolumeStore();
		const ref = () => "conv-1";

		const run1 = createRuntime({
			model: runCodeOnce(WRITE("/data.txt", "PERSISTED")),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: quickjs(), store, volumeRef: ref }),
			},
		});
		expect((await run1.generate("write it")).status).toBe("completed");

		const rec2 = recordingSandbox();
		const run2 = createRuntime({
			model: runCodeOnce(READ_OR("/data.txt", "absent")),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({
					sandbox: rec2.sandbox,
					store,
					volumeRef: ref,
				}),
			},
		});
		expect((await run2.generate("read it")).status).toBe("completed");
		expect(rec2.last()?.result).toBe("PERSISTED");
	}, 30000);

	// T2 — isolation: a write under ref "a" is invisible to a read under ref "b". Different refs are
	// separate volumes.
	it("T2: different volumeRefs are isolated volumes", async () => {
		const store = memoryVolumeStore();

		const runA = createRuntime({
			model: runCodeOnce(WRITE("/data.txt", "IN-A")),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({
					sandbox: quickjs(),
					store,
					volumeRef: () => "a",
				}),
			},
		});
		expect((await runA.generate("write a")).status).toBe("completed");

		const recB = recordingSandbox();
		const runB = createRuntime({
			model: runCodeOnce(READ_OR("/data.txt", "absent")),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({
					sandbox: recB.sandbox,
					store,
					volumeRef: () => "b",
				}),
			},
		});
		expect((await runB.generate("read b")).status).toBe("completed");
		expect(recB.last()?.result).toBe("absent");
	}, 30000);

	// T3 — no regression: runCodeTool WITHOUT a store mounts no filesystem, so a guest write fails
	// exactly as before this slice (fs disabled unless mountFs is supplied directly).
	it("T3: no store means no filesystem (the guest write is disabled)", async () => {
		const rec = recordingSandbox();
		const runtime = createRuntime({
			model: runCodeOnce(WRITE("/nope.txt", "x")),
			audit: createMemoryAudit(),
			tools: { run_code: runCodeTool({ sandbox: rec.sandbox }) },
		});
		expect((await runtime.generate("write with no store")).status).toBe("completed");
		// The write threw inside the guest (file access disabled) → an error VALUE, no result.
		expect(rec.last()?.error).toBeDefined();
		expect(rec.last()?.result).toBeNull();
	}, 30000);

	// T4 — load budget: a store whose load returns an over-budget tree is REFUSED before mounting. The
	// provider throws before the guest runs, so the tree is never pulled into the wasm context.
	it("T4: an over-budget loaded tree is refused and never mounted", async () => {
		const store = memoryVolumeStore();
		await store.save("big", { "big.txt": "x".repeat(200_000) });
		const tree = await store.load("big");

		await expect(
			executeInSandbox({
				sandbox: quickjs({ maxFsBytes: 64 * 1024 }),
				code: "return 1",
				invoker: noInvoke,
				context: { mountFs: tree },
			}),
		).rejects.toThrow(/byte budget/i);
	}, 30000);

	// T5 — write budget (THE DoS GUARD): a guest that loops writing 1MB files past an 8MB cap is
	// stopped by an error VALUE, not a host OOM. Critically the error MUST fire (the write was capped,
	// not silently allowed like the pre-fix probe), and the same provider stays usable afterwards.
	it("T5: a write-bomb is capped as an error value and the host survives", async () => {
		const sandbox = quickjs({ maxFsBytes: 8 * 1024 * 1024 });
		const { output } = await executeInSandbox({
			sandbox,
			code: `const fs = await import("node:fs"); const chunk = "x".repeat(1024 * 1024); let i = 0; for (; i < 100; i++) { fs.writeFileSync("/bomb-" + i + ".txt", chunk); } return i;`,
			invoker: noInvoke,
			context: { mountFs: {} },
		});
		// The cap actually fired — an error VALUE, not a returned count and not a host crash.
		expect(output.error).toBeDefined();
		expect(output.error).toMatch(/quota|budget|exceeded/i);
		expect(output.result).toBeNull();

		// The host (and the shared wasm module) survived — a trivial follow-up still returns 2.
		const { output: after } = await executeInSandbox({
			sandbox,
			code: "return 2",
			invoker: noInvoke,
			context: {},
		});
		expect(after.result).toBe(2);
		expect(after.error).toBeUndefined();
	}, 30000);

	// T6 — the provider hands back the mutated tree: a direct executeInSandbox with a mounted fs and a
	// write returns `fsTree` containing the written file (the envelope contract works at the provider).
	it("T6: the provider returns the mutated fsTree alongside the output", async () => {
		const { output, fsTree } = await executeInSandbox({
			sandbox: quickjs(),
			code: `const fs = await import("node:fs"); fs.writeFileSync("/note.txt", "HELLO"); return "ok";`,
			invoker: noInvoke,
			context: { mountFs: {} },
		});
		expect(output.result).toBe("ok");
		expect(fsTree).toBeDefined();
		expect(fsTree?.["note.txt"]).toBe("HELLO");
	}, 30000);

	// T7 — the memory adapter deep-clones on both load and save, so a caller mutating a loaded (or a
	// just-saved) tree cannot corrupt what the store holds. An unknown ref loads as {}.
	it("T7: the memory store deep-clones and isolates the stored tree", async () => {
		const store = memoryVolumeStore();
		await store.save("k", { "a.txt": "one", dir: { "b.txt": "two" } });

		// Mutating a LOADED tree must not reach back into the store.
		const loaded = await store.load("k");
		loaded["a.txt"] = "MUTATED";
		(loaded.dir as VolumeTree)["b.txt"] = "MUTATED";
		loaded["c.txt"] = "NEW";

		const again = await store.load("k");
		expect(again["a.txt"]).toBe("one");
		expect((again.dir as VolumeTree)["b.txt"]).toBe("two");
		expect(again["c.txt"]).toBeUndefined();

		// Mutating a tree AFTER saving it must not reach into the store either.
		const src: VolumeTree = { "x.txt": "orig" };
		await store.save("s", src);
		src["x.txt"] = "changed";
		expect((await store.load("s"))["x.txt"]).toBe("orig");

		// An unknown ref is a fresh, empty volume — not an error.
		expect(await store.load("unknown")).toEqual({});
	});
});
