import { describe, expect, it, vi } from "vitest";
import type {
	SandboxFetch,
	SandboxInvokeInput,
	SandboxToolInvoker,
} from "../src/core/contracts";
import { executeInSandbox } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

const noInvoke: SandboxToolInvoker = {
	invoke: async () => {
		throw new Error("invoker should not be called");
	},
};

describe("@busyclaw/sandboxes quickjs provider", () => {
	it("runs plain code with a top-level return", async () => {
		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: "return 1 + 1",
			invoker: noInvoke,
			context: {},
		});
		expect(res.result).toBe(2);
		expect(res.error).toBeUndefined();
	});

	it("bridges the tools proxy into the invoker with a dotted path and round-trips the value", async () => {
		const calls: SandboxInvokeInput[] = [];
		const invoker: SandboxToolInvoker = {
			invoke: async (input) => {
				calls.push(input);
				return { echoed: input.args };
			},
		};

		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: 'return await tools.echo.hello({ v: "x" })',
			invoker,
			context: {},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ path: "echo.hello", args: { v: "x" } });
		expect(res.result).toEqual({ echoed: { v: "x" } });
	});

	it("round-trips a denied VALUE without throwing", async () => {
		const invoker: SandboxToolInvoker = {
			invoke: async () => ({ status: "denied", gateId: "g", reason: "no" }),
		};

		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: 'const r = await tools.x.y({}); return r.status === "denied" ? "was-denied" : "other";',
			invoker,
			context: {},
		});

		expect(res.result).toBe("was-denied");
		expect(res.error).toBeUndefined();
	});

	it("blocks fetch by default and injects the governed fetchAdapter when supplied", async () => {
		const { output: blocked } = await executeInSandbox({
			sandbox: quickjs(),
			code: 'return await fetch("https://example.test/")',
			invoker: noInvoke,
			context: {},
		});
		expect(blocked.error).toMatch(/disabled|not supported/i);

		const fetchAdapter: SandboxFetch = async (input) => ({
			ok: true,
			status: 200,
			text: async () => `body:${String(input)}`,
		});
		const { output: allowed } = await executeInSandbox({
			sandbox: quickjs(),
			code: 'const r = await fetch("https://example.test/data"); return await r.text();',
			invoker: noInvoke,
			context: { fetchAdapter },
		});
		expect(allowed.result).toBe("body:https://example.test/data");
	});

	it("kills a runaway loop under the wall-clock limit and returns promptly", async () => {
		const start = Date.now();
		const { output: res } = await executeInSandbox({
			sandbox: quickjs({ timeoutMs: 500 }),
			code: "while (true) {}",
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeDefined();
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("captures console into logs and does not print guest logs to host stdout", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: 'console.log("hi"); return 1;',
			invoker: noInvoke,
			context: {},
		});
		expect(res.result).toBe(1);
		expect(res.logs?.some((line) => line.includes("hi"))).toBe(true);
		const printedHi = spy.mock.calls.some((args) =>
			args.some((a) => typeof a === "string" && a.includes("hi")),
		);
		expect(printedHi).toBe(false);
		spy.mockRestore();
	});

	it("mounts a virtual filesystem only when a tree is supplied", async () => {
		const { output: mounted } = await executeInSandbox({
			sandbox: quickjs(),
			code: [
				'const fs = await import("node:fs");',
				'fs.writeFileSync("/hello.txt", "hi there");',
				'return fs.readFileSync("/hello.txt", "utf8");',
			].join("\n"),
			invoker: noInvoke,
			context: { mountFs: {} },
		});
		expect(mounted.result).toBe("hi there");

		const { output: unmounted } = await executeInSandbox({
			sandbox: quickjs(),
			code: [
				'const fs = await import("node:fs");',
				'fs.writeFileSync("/hello.txt", "nope");',
				'return "wrote";',
			].join("\n"),
			invoker: noInvoke,
			context: {},
		});
		expect(unmounted.error).toBeDefined();
		expect(unmounted.result).toBeNull();
	});
});
