import { describe, expect, it, vi } from "vitest";
import type {
	ExecutionResult,
	IsolationPosture,
	Sandbox,
	SandboxInvokeInput,
	SandboxToolInvoker,
} from "../src/core/contracts";
import { executeInSandbox, normalizeCode } from "../src/index";

const POSTURE: IsolationPosture = {
	kind: "wasm",
	network: "blocked",
	filesystem: "none",
	memoryLimit: true,
	wallClockLimit: true,
};

// A fake provider (no wasm): its execute drives the engine-wrapped invoker however the test asks and
// returns whatever ExecutionResult the test supplies.
function fakeProvider(
	run: (invoker: SandboxToolInvoker) => Promise<ExecutionResult>,
): Sandbox {
	return {
		provider: "fake",
		posture: POSTURE,
		execute: async ({ invoker }) => ({ output: await run(invoker) }),
	};
}

const unusedInvoker: SandboxToolInvoker = {
	invoke: async () => {
		throw new Error("invoker should not be called");
	},
};

describe("@busyclaw/sandboxes engine", () => {
	it("normalizeCode strips a single wrapping fence and leaves plain code untouched", () => {
		expect(normalizeCode("```js\nreturn 1 + 1\n```")).toBe("return 1 + 1");
		expect(normalizeCode("```\nfoo()\n```")).toBe("foo()");
		expect(normalizeCode("  return 2  ")).toBe("return 2");
		// A backtick INSIDE the code is not a wrapping fence — left as-is.
		expect(normalizeCode("const a = `x`;\nreturn a")).toBe(
			"const a = `x`;\nreturn a",
		);
	});

	it("returns a denied-like VALUE (not a throw) for a malformed invoke shape", async () => {
		const sandbox = fakeProvider(async (invoker) => ({
			result: await invoker.invoke({
				nope: true,
			} as unknown as SandboxInvokeInput),
		}));

		const { output: res } = await executeInSandbox({
			sandbox,
			code: "",
			invoker: unusedInvoker,
			context: {},
		});

		expect(res.result).toMatchObject({
			status: "denied",
			reasonCode: "SANDBOX_INVOKE_INVALID",
		});
	});

	it("passes a valid invoke through to the host invoker untouched", async () => {
		const raw: SandboxToolInvoker = {
			invoke: async ({ path, args }) => ({
				status: "ok",
				output: { path, args },
			}),
		};
		const sandbox = fakeProvider(async (invoker) => ({
			result: await invoker.invoke({ path: "a.b", args: { v: 1 } }),
		}));

		const { output: res } = await executeInSandbox({
			sandbox,
			code: "",
			invoker: raw,
			context: {},
		});

		expect(res.result).toMatchObject({
			status: "ok",
			output: { path: "a.b", args: { v: 1 } },
		});
	});

	it("replaces an invoker infra defect with an opaque id and hides the original message", async () => {
		const secret = "postgres://user:pw@db.internal/app";
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const raw: SandboxToolInvoker = {
			invoke: async () => {
				throw new Error(secret);
			},
		};
		const sandbox = fakeProvider(async (invoker) => ({
			result: await invoker.invoke({ path: "a", args: {} }),
		}));

		const { output: res } = await executeInSandbox({
			sandbox,
			code: "",
			invoker: raw,
			context: {},
		});

		const serialized = JSON.stringify(res.result);
		expect(serialized).toContain("internal sandbox error [");
		expect(serialized).not.toContain(secret);
		// The original defect is logged host-side, never surfaced to the sandbox.
		expect(spy).toHaveBeenCalledOnce();
		spy.mockRestore();
	});

	it("throws a host-side validationError when the provider result does not match the floor", async () => {
		const sandbox = fakeProvider(
			async () => ({ notResult: true }) as unknown as ExecutionResult,
		);

		await expect(
			executeInSandbox({
				sandbox,
				code: "",
				invoker: unusedInvoker,
				context: {},
			}),
		).rejects.toThrow(/sandbox execution result invalid/);
	});
});
