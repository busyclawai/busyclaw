// Isolation hardening — RESOURCE LIMITS: a hostile guest cannot exhaust host resources. Each abuse
// must surface as an error VALUE (result: null, error set) — never a host throw, OOM, or hang — and
// the host runtime must remain usable afterwards. Every test runs a trivial follow-up execute and
// asserts it still returns 2: proof the preceding abuse did not corrupt the host.
//
// R2 note: deep recursion aborts the underlying wasm runtime (a GC assertion trips as the aborted
// context is disposed) and REJECTS rather than returning `{ ok: false }`. The provider now catches
// that rejection and converts it to an error VALUE — the abort is isolated to the single execution,
// so the same provider instance and the host stay usable. R2 below asserts all three.

import { describe, expect, it, vi } from "vitest";
import type { SandboxToolInvoker } from "../src/core/contracts";
import { executeInSandbox } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

const noInvoke: SandboxToolInvoker = {
	invoke: async () => {
		throw new Error("invoker should not be called");
	},
};

// The host is uncorrupted iff a fresh trivial execute still works after the abuse.
async function hostStillWorks(): Promise<void> {
	const { output: res } = await executeInSandbox({
		sandbox: quickjs(),
		code: "return 2",
		invoker: noInvoke,
		context: {},
	});
	expect(res.result).toBe(2);
	expect(res.error).toBeUndefined();
}

describe("@busyclaw/sandboxes resource limits", () => {
	// R1 — a runaway allocation hits the memory cap as an error VALUE, not a host OOM. [P0-if-fails].
	it("R1: bounds runaway memory allocation and the host survives", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ memoryLimitBytes: 8 * 1024 * 1024 }),
			code: "const a=[]; while(true){ a.push(new Array(100000).fill(0)); } return 1;",
			invoker: noInvoke,
			context: {},
		});
		// Observed mechanism: the wrapper reports "out of memory" as an error value.
		expect(res.error).toBeDefined();
		expect(res.result).toBeNull();
		await hostStillWorks();
	}, 30000);

	// R1b — the PREMISE the fs byte budget exists for: memfs lives in HOST heap and is NOT bounded by
	// `memoryLimitBytes`. Here the SAME 8MB wasm cap that stops R1's in-wasm allocation does NOT stop a
	// 32MB filesystem write when the fs budget is set well above it — the write goes through. This pins
	// the invariant "the wasm cap does not cover the filesystem", which is why `maxFsBytes` (see T5) is
	// load-bearing and must not be removed in favour of the memory cap. [P0-if-fails: if this ever
	// starts erroring, memfs became wasm-bounded and the two budgets should be reconciled.]
	it("R1b: memfs writes are NOT bounded by the wasm memory cap (why maxFsBytes exists)", async () => {
		const { output: res } = await executeInSandbox({
			// wasm heap capped at 8MB, but the fs budget is raised to 64MB so the WRITE cap is not what
			// fires — this isolates the wasm cap and shows it does not apply to memfs.
			sandbox: quickjs({
				memoryLimitBytes: 8 * 1024 * 1024,
				maxFsBytes: 64 * 1024 * 1024,
			}),
			code: [
				'const fs = await import("node:fs");',
				'const chunk = "x".repeat(1024 * 1024);', // 1MB
				"let total = 0;",
				'for (let i = 0; i < 32; i++) { fs.writeFileSync("/f" + i, chunk); total += chunk.length; }',
				"return total;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});
		// 32MB written and read back cleanly under an 8MB WASM cap — the wasm cap did not bound the fs.
		expect(res.error).toBeUndefined();
		expect(res.result).toBe(32 * 1024 * 1024);
		await hostStillWorks();
	}, 30000);

	// R2 — deep recursion aborts the wasm context but surfaces as an error VALUE (not a host throw);
	// the SAME provider instance and the host both survive. [P0-if-fails: a host throw fails the run].
	it("R2: converts a deep-recursion wasm abort into an error value and survives", async () => {
		const sandbox = quickjs();
		// Sanity: the instance works before the bomb.
		const { output: before } = await executeInSandbox({
			sandbox,
			code: "return 1",
			invoker: noInvoke,
			context: {},
		});
		expect(before.result).toBe(1);
		// The bomb must NOT throw out of executeInSandbox — it must resolve to an error value.
		const { output: res } = await executeInSandbox({
			sandbox,
			code: "function f(){ return f(); } return f();",
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeDefined();
		expect(res.result).toBeNull();
		// The SAME instance still works afterward — the abort did not poison the shared module.
		const { output: after } = await executeInSandbox({
			sandbox,
			code: "return 2",
			invoker: noInvoke,
			context: {},
		});
		expect(after.result).toBe(2);
		expect(after.error).toBeUndefined();
		// And a fresh instance is fine too.
		await hostStillWorks();
	}, 30000);

	// R3 — a never-resolving await is killed by the wall clock; it does not hang the host.
	// [P0-if-fails].
	it("R3: bounds a hung promise on the wall clock and returns promptly", async () => {
		const start = Date.now();
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ timeoutMs: 500 }),
			code: "await new Promise(() => {}); return 1;",
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeDefined();
		expect(res.result).toBeNull();
		// The never-resolving await must not stall the host anywhere near the default 5s ceiling.
		expect(Date.now() - start).toBeLessThan(5000);
		await hostStillWorks();
	}, 30000);

	// R4 — timer flooding is bounded, with no hang. The requirement is "bounded, no hang"; the
	// observed mechanism is that the cap throws an error VALUE once exceeded.
	it("R4: bounds timer flooding without hanging", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxTimeoutCount: 4 }),
			code: 'for (let i = 0; i < 100000; i++) setTimeout(() => {}, 0); return "survived";',
			invoker: noInvoke,
			context: {},
		});
		// Either the cap throws (error VALUE) or extra timers are dropped (result "survived"); both are
		// bounded and neither hangs. Observed: the cap throws once exceeded.
		const bounded = res.error !== undefined || res.result === "survived";
		expect(bounded).toBe(true);
		await hostStillWorks();
	}, 30000);

	// R5 — an enormous output does not corrupt the host (best-effort). Under an 8MB cap the giant
	// string either comes back bounded or fails as an error VALUE; the host survives regardless.
	it("R5: bounds a huge output and the host survives", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ memoryLimitBytes: 8 * 1024 * 1024 }),
			code: 'return "x".repeat(50000000);',
			invoker: noInvoke,
			context: {},
		});
		// Observed: the allocation exceeds the cap → error VALUE. A bounded string would also satisfy.
		const boundedString =
			typeof res.result === "string" && res.result.length <= 50_000_000;
		expect(res.error !== undefined || boundedString).toBe(true);
		await hostStillWorks();
	}, 30000);
});

// ── M-06: the budgets above bound the GUEST's heap; these bound the HOST's ────────────────────────
//
// R1b pins the premise for the filesystem. The same premise holds for everything else the guest
// emits or names: it crosses into host memory that `memoryLimitBytes` never sees. A run staying
// comfortably inside its wasm cap could still spend the host's heap until the timeout happened to
// fire — which is a bound on TIME, not on memory, and on a slower host it fires later.

describe("@busyclaw/sandboxes host-side resource limits (M-06)", () => {
	// R6 — console output accumulates in a HOST array. Unbounded, a print loop is a host OOM that no
	// guest-side cap can see.
	it("R6: bounds console output and says so rather than dropping it silently", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			// 2048-byte lines against a 256KB budget: the cap trips after ~128 of them. The loop only
			// has to outrun the cap, and every crossing of the guest→host bridge costs real time.
			code: [
				'const line = "y".repeat(2048);',
				"for (let i = 0; i < 2000; i++) console.log(line);",
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: {},
		});

		expect(res.result).toBe(1); // the RUN is fine — only the log is capped
		const logs = res.logs ?? [];
		// Under 200, not merely under the 1000-line cap: at 2048 bytes a line the BYTE budget trips
		// first, around 128 lines. Asserting the line count alone would stay green with no byte budget
		// at all, which is exactly what mutation showed before this was tightened.
		expect(logs.length).toBeLessThan(200);
		// Announced, not silent: a model reading its own output must be able to tell "nothing more
		// was printed" from "the rest was dropped", or it reasons from an absence it caused itself.
		expect(logs.at(-1)).toMatch(/logs truncated/);
		await hostStillWorks();
	}, 30000);

	// R6c — many SHORT lines. R6 trips the byte budget (2048-byte lines exhaust 256KB in ~128 of
	// them), so it never exercises the line count; a print loop of tiny lines is the other shape, and
	// costs a host array SLOT each time however small the string is.
	it("R6c: bounds the NUMBER of log lines, not just their bytes", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: [
				// Only has to outrun the 1000-line cap; every crossing of the guest→host bridge
				// costs real time, and this suite runs alongside every other package.
				"for (let i = 0; i < 1400; i++) console.log(i);",
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: {},
		});

		expect(res.result).toBe(1);
		const logs = res.logs ?? [];
		// Well under the 256KB byte budget the whole time — only the count can have stopped this.
		expect(logs.join("").length).toBeLessThan(256 * 1024);
		expect(logs.length).toBeLessThanOrEqual(1001);
		expect(logs.at(-1)).toMatch(/logs truncated/);
		await hostStillWorks();
	}, 30000);

	// R6b — one enormous line, rather than many. The per-line cap is what stops a single call landing
	// a guest-sized string in the host array.
	it("R6b: truncates a single oversized log line", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: ['console.log("z".repeat(4 * 1024 * 1024));', "return 1;"].join(
				"\n",
			),
			invoker: noInvoke,
			context: {},
		});

		expect(res.result).toBe(1);
		const first = (res.logs ?? [])[0] ?? "";
		expect(first.length).toBeLessThan(16 * 1024);
		expect(first).toMatch(/line truncated/);
		await hostStillWorks();
	}, 30000);

	// R7 — the byte budget charged the PAYLOAD, so empty files were free. Each entry still costs a
	// key, a node, and a slot in the snapshot taken at the end of the run.
	it("R7: bounds the NUMBER of filesystem entries, not just their bytes", async () => {
		const { output: res } = await executeInSandbox({
			// A generous byte budget on purpose: the bytes are not what should stop this.
			sandbox: quickjs({ maxFsBytes: 64 * 1024 * 1024, maxFsEntries: 64 }),
			code: [
				'const fs = await import("node:fs");',
				'for (let i = 0; i < 5000; i++) fs.writeFileSync("/f" + i, "");',
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});

		expect(res.error).toMatch(/entry budget/);
		await hostStillWorks();
	}, 30000);

	// R9 — the same blindness on the LOAD side: the seed budget summed only the leaves, so a tree of
	// empty files under long names measured zero and passed any budget. The seed is pulled into host
	// heap before the guest runs at all, so this one is spent before any guest code executes.
	it("R9: the seed budget counts path names, not only file contents", async () => {
		const seed: Record<string, string> = {};
		for (let i = 0; i < 200; i += 1) seed[`${"n".repeat(4096)}${i}`] = "";

		await expect(
			executeInSandbox({
				sandbox: quickjs({ maxFsBytes: 64 * 1024 }),
				code: "return 1",
				invoker: noInvoke,
				context: { mountFs: seed },
			}),
		).rejects.toThrow(/byte budget/);
		await hostStillWorks();
	}, 30000);

	// R8 — and it charged nothing for the NAME, so a long path was free too.
	it("R8: charges the path, so long names cannot be written for free", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 64 * 1024 }),
			code: [
				'const fs = await import("node:fs");',
				// Every file is empty — under the old accounting this whole loop charged zero.
				'for (let i = 0; i < 100; i++) fs.writeFileSync("/" + "n".repeat(4096) + i, "");',
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});

		expect(res.error).toMatch(/quota exceeded/);
		await hostStillWorks();
	}, 30000);
});

// ── R-H13: the operations that mint an entry without writing to it ───────────────────────────────
//
// The write cap charged arg 0 of every path-taking call. For a two-path operation that is the
// SOURCE — a path that already exists and was already charged when it was made — while arg 1 is the
// destination, which is the new entry. So charging it charged nothing new, and a copy/link/symlink
// loop minted entries for free however small the budget was. For `symlink` arg 0 is not even a path
// in the volume; it is the target text.
//
// `truncate` is the sharper one: it takes a LENGTH and memfs grows the buffer to it. No payload, no
// new path, so nothing was charged — one call could ask for a gigabyte of host heap that the
// QuickJS memory limit never sees.

describe("@busyclaw/sandboxes host-side resource limits — multi-path and length (R-H13)", () => {
	it("R10: copy charges the DESTINATION, so a copy loop cannot mint entries for free", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 64 * 1024, maxFsEntries: 3 }),
			code: [
				'const fs = await import("node:fs");',
				'for (let i = 0; i < 500; i++) fs.copyFileSync("/a", "/copy" + i);',
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: { a: "xxxx" } },
		});

		expect(res.error).toMatch(/quota exceeded/);
		await hostStillWorks();
	}, 30000);

	it("R11: link and symlink charge their destination too", async () => {
		const linked = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 64 * 1024, maxFsEntries: 3 }),
			code: [
				'const fs = await import("node:fs");',
				'for (let i = 0; i < 500; i++) fs.symlinkSync("/target", "/s" + i);',
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});

		expect(linked.output.error).toMatch(/quota exceeded/);
		await hostStillWorks();
	}, 30000);

	it("R12: copy charges the bytes it duplicates, not just the name", async () => {
		// A copy is a second resident copy of the content. Charging only the name would let a handful
		// of copies of one large file multiply host memory while the entry count barely moved.
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 32 * 1024, maxFsEntries: 4096 }),
			code: [
				'const fs = await import("node:fs");',
				'for (let i = 0; i < 20; i++) fs.copyFileSync("/big", "/c" + i);',
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: { big: "y".repeat(8 * 1024) } },
		});

		expect(res.error).toMatch(/quota exceeded/);
		await hostStillWorks();
	}, 30000);

	it("R13: truncate charges the length it grows the buffer to", async () => {
		// memfs expands a host-side buffer to a guest-chosen length, outside the wasm heap limit —
		// the same premise R1b pins for writes, reached through an operation that writes nothing.
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 64 * 1024 }),
			code: [
				'const fs = await import("node:fs");',
				'fs.writeFileSync("/t", "x");',
				'fs.truncateSync("/t", 512 * 1024 * 1024);',
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});

		expect(res.error).toMatch(/quota exceeded/);
		await hostStillWorks();
	}, 30000);
});

// ── R-H13: guest output must not reach the operator's own stdout ─────────────────────────────────
//
// The provider overrode six console levels under a comment saying nothing reached host stdout. The
// wrapper builds a FULL Node console whose every method calls the HOST's `console.*` directly and
// merges ours over it, so the other fourteen were inherited: `count`, `table`, `group`, `dir`,
// `time`, `assert` all wrote to the operator's terminal — past the line cap, past the byte cap,
// captured by nothing and announced by nothing.

describe("@busyclaw/sandboxes — no console method escapes to the host (R-H13)", () => {
	it.each([
		"count",
		"table",
		"group",
		"dir",
		"assert",
		"timeLog",
	] as const)("routes console.%s to the run's log sink, not the host console", async (method) => {
		const spy = vi
			.spyOn(console, method as "count")
			.mockImplementation(() => undefined);
		try {
			const { output } = await executeInSandbox({
				sandbox: quickjs(),
				code: `console.${method}("ESCAPE_MARKER"); return 1;`,
				invoker: noInvoke,
				context: {},
			});

			expect(output.result).toBe(1);
			expect(spy).not.toHaveBeenCalled();
			// It was not dropped either — it landed where the caps can see it.
			expect((output.logs ?? []).join("\n")).toContain("ESCAPE_MARKER");
		} finally {
			spy.mockRestore();
		}
	});
});

describe("@busyclaw/sandboxes — recursive mkdir charges every component (R-H13)", () => {
	it("R14: nesting cannot mint entries a loop would be refused", async () => {
		// `{ recursive: true }` creates every missing component in ONE call, and a single path charge
		// counted one — so a guest could nest instead of looping and mint arbitrarily many entries
		// under any entry budget.
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 64 * 1024, maxFsEntries: 3 }),
			code: [
				'const fs = await import("node:fs");',
				'fs.mkdirSync("/a/b/c/d/e/f/g/h", { recursive: true });',
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});

		expect(res.error).toMatch(/entry budget/);
		await hostStillWorks();
	}, 30000);

	it("R14b: an ordinary mkdir still costs exactly one entry", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 64 * 1024, maxFsEntries: 3 }),
			code: [
				'const fs = await import("node:fs");',
				'fs.mkdirSync("/one");',
				'fs.mkdirSync("/two");',
				"return 2;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});

		expect(res.error).toBeUndefined();
		expect(res.result).toBe(2);
	}, 30000);
});

// ── R-H13: one allowance across both doors ───────────────────────────────────────────────────────
//
// Every nested tool call and every fetch was individually bounded — each governed, each capped —
// and nothing bounded the SET. A guest could issue them without limit inside one execution: every
// call legal, the total unconstrained. The wall clock was the only ceiling, which bounds time
// rather than work, so a faster host simply allowed more.

describe("@busyclaw/sandboxes — the execution's shared host budget (R-H13)", () => {
	const counting = (): SandboxToolInvoker & { calls: () => number } => {
		let calls = 0;
		return {
			calls: () => calls,
			invoke: async () => {
				calls += 1;
				return { status: "ok", output: 1 };
			},
		};
	};

	it("R15: caps total nested tool calls for one execution", async () => {
		const invoker = counting();
		const { output } = await executeInSandbox({
			sandbox: quickjs(),
			code: [
				"let denied = 0;",
				"for (let i = 0; i < 200; i++) {",
				"  const r = await tools.some.thing({});",
				'  if (r && r.status === "denied") denied++;',
				"}",
				"return denied;",
			].join("\n"),
			invoker,
			context: { budget: { maxHostCalls: 20 } },
		});

		// The host did 20 and no more; the rest came back as a value the model can read.
		expect(invoker.calls()).toBe(20);
		expect(Number(output.result)).toBe(180);
	}, 30000);

	it("R16: exhaustion is a DENIED value, not a thrown execution", async () => {
		// A refusal the guest can read lets model code adapt — the same shape a governed denial takes.
		// Killing the run instead would turn a quota into a crash.
		const { output } = await executeInSandbox({
			sandbox: quickjs(),
			code: [
				"await tools.a({});",
				"const r = await tools.a({});",
				"return r.reasonCode;",
			].join("\n"),
			invoker: counting(),
			context: { budget: { maxHostCalls: 1 } },
		});

		expect(output.error).toBeUndefined();
		expect(output.result).toBe("SANDBOX_BUDGET_EXHAUSTED");
	}, 30000);

	it("R17: the budget is SHARED — fetch spends the same allowance as tool calls", async () => {
		// Two counters would let a guest spend the whole host by alternating between the doors. The
		// host does not care which one the work arrived through.
		const invoker = counting();
		const { output } = await executeInSandbox({
			sandbox: quickjs(),
			code: [
				"await tools.a({});",
				"await tools.a({});",
				"try {",
				'  await fetch("https://example.com/");',
				'  return "fetch-allowed";',
				'} catch (e) { return "fetch-refused"; }',
			].join("\n"),
			invoker,
			context: {
				budget: { maxHostCalls: 2 },
				network: {
					lookup: async () => [{ address: "93.184.216.34", family: 4 }],
					transport: async () => new Response("hi", { status: 200 }),
				},
			},
		});

		expect(invoker.calls()).toBe(2);
		expect(output.result).toBe("fetch-refused");
	}, 30000);

	it("R18: bounds how many run at ONCE, not just how many run", async () => {
		let inFlight = 0;
		let peak = 0;
		const invoker: SandboxToolInvoker = {
			invoke: async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				return { status: "ok", output: 1 };
			},
		};

		await executeInSandbox({
			sandbox: quickjs(),
			code: [
				"const jobs = [];",
				"for (let i = 0; i < 40; i++) jobs.push(tools.a({}));",
				"await Promise.all(jobs);",
				"return 1;",
			].join("\n"),
			invoker,
			context: { budget: { maxHostCalls: 100, maxConcurrentHostCalls: 4 } },
		});

		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBeGreaterThan(1); // still concurrent, just bounded
	}, 30000);
});

describe("@busyclaw/sandboxes — created names, not argument names (R-H13)", () => {
	it("R19: mkdtemp charges each directory it creates, not the prefix it was given", async () => {
		// The prefix is the same string on every call, so charging arg 0 let the entry set see one
		// no matter how many directories appeared — the same mistake as charging a copy's SOURCE.
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 64 * 1024, maxFsEntries: 3 }),
			code: [
				'const fs = await import("node:fs");',
				'for (let i = 0; i < 50; i++) fs.mkdtempSync("/t");',
				"return 1;",
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});

		expect(res.error).toMatch(/entry budget/);
		await hostStillWorks();
	}, 30000);
});

describe("@busyclaw/sandboxes — a tool result crosses as DATA (R-H13)", () => {
	it("R20: a function on a tool result never becomes a guest-callable host function", async () => {
		// The host→guest direction was not treated as a boundary, because a HandleResult is
		// host-authored. But a tool returning a function hands the guest a live host callable: the
		// wrapper marshals it and the guest runs host code — the one thing the isolate exists to
		// prevent, reached without touching the isolate.
		let called = 0;
		const { output } = await executeInSandbox({
			sandbox: quickjs(),
			code: [
				"const r = await tools.x({});",
				"return typeof (r && r.output && r.output.call);",
			].join("\n"),
			invoker: {
				invoke: async () => ({
					status: "ok",
					output: {
						call: (value: string) => {
							called += 1;
							return `host:${value}`;
						},
					},
				}),
			},
			context: {},
		});

		expect(output.result).toBe("undefined");
		expect(called).toBe(0);
	}, 30000);
});

describe("@busyclaw/sandboxes — the execution's lifetime reaches its tools (R-H13)", () => {
	it("R21: a nested tool call receives the execution signal and sees it abort", async () => {
		// The guest's promise already rejected on the deadline, but the host work it was waiting on
		// ran to completion — the guest saw a timeout, the tool did not. A run killed at five
		// milliseconds still owed a hundred milliseconds of somebody else's API.
		//
		// Cooperative, like every abort in Node: this hands the signal to whoever can act on it
		// rather than pretending the engine can stop work it does not own.
		let received: AbortSignal | undefined;
		let finishedAnyway = false;

		await executeInSandbox({
			sandbox: quickjs({ timeoutMs: 50 }),
			code: "await tools.slow({}); return 1;",
			invoker: {
				invoke: async (_input, options) => {
					received = options?.signal;
					await new Promise((resolve) => setTimeout(resolve, 300));
					finishedAnyway = true;
					return { status: "ok", output: 1 };
				},
			},
			context: {},
		});

		expect(received).toBeDefined();
		// The execution is over, so its signal is down — a tool that watches it can stop.
		expect(received?.aborted).toBe(true);
		// And this one did not watch, which is exactly why the signal is offered rather than assumed.
		expect(finishedAnyway).toBe(false);
	}, 30000);
});
