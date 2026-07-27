// Isolation hardening — CROSS-EXECUTION ISOLATION: one execution cannot affect the next. Each test
// deliberately shares ONE provider instance across two executes; the guarantee under test is that a
// FRESH guest context per execute prevents any state (globals, prototypes, filesystem) from leaking
// between them. A leak here is one organization's script reading or corrupting another's — [P0-if-fails].
//
// I4 (whether the host CAN intentionally persist fs across executes) is a report-only investigation,
// not a pass/fail property — its findings live in the suite report, not in an assertion here.

import { describe, expect, it } from "vitest";
import type { SandboxToolInvoker } from "../src/core/contracts";
import { executeInSandbox } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

const noInvoke: SandboxToolInvoker = {
	invoke: async () => {
		throw new Error("invoker should not be called");
	},
};

describe("@busyclaw/sandboxes cross-execution isolation", () => {
	// I1 — a global set in one execution does not persist into the next. [P0-if-fails].
	it("I1: globalThis mutations do not persist across executions", async () => {
		const sandbox = quickjs();
		const { output: first } = await executeInSandbox({
			sandbox,
			code: 'globalThis.__leak = 42; return "ok";',
			invoker: noInvoke,
			context: {},
		});
		expect(first.result).toBe("ok");

		const { output: second } = await executeInSandbox({
			sandbox,
			code: "return typeof globalThis.__leak;",
			invoker: noInvoke,
			context: {},
		});
		expect(second.result).toBe("undefined");
	}, 30000);

	// I2 — prototype pollution in one execution does not persist into the next. [P0-if-fails].
	it("I2: prototype pollution does not persist across executions", async () => {
		const sandbox = quickjs();
		const { output: first } = await executeInSandbox({
			sandbox,
			code: 'Object.prototype.__p = 1; return "ok";',
			invoker: noInvoke,
			context: {},
		});
		expect(first.result).toBe("ok");

		const { output: second } = await executeInSandbox({
			sandbox,
			code: 'return ({}).__p ?? "clean";',
			invoker: noInvoke,
			context: {},
		});
		expect(second.result).toBe("clean");
	}, 30000);

	// I3 — a file written to the mounted fs in one execution is absent in the next: each execute gets
	// a fresh memfs seeded only from its own mountFs. [P0-if-fails].
	it("I3: mounted filesystem writes do not persist across executions", async () => {
		const sandbox = quickjs();
		const { output: first } = await executeInSandbox({
			sandbox,
			code: 'const fs = await import("node:fs"); fs.writeFileSync("/a.txt", "one"); return "wrote";',
			invoker: noInvoke,
			context: { mountFs: {} },
		});
		expect(first.result).toBe("wrote");

		const { output: second } = await executeInSandbox({
			sandbox,
			code: 'const fs = await import("node:fs"); try { return fs.readFileSync("/a.txt","utf8"); } catch { return "absent"; }',
			invoker: noInvoke,
			context: { mountFs: {} },
		});
		expect(second.result).toBe("absent");
	}, 30000);
});
