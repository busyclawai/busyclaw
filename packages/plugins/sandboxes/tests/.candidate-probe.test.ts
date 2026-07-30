import { describe, expect, it, vi } from "vitest";
import type { SandboxToolInvoker } from "../src/core/contracts";
import { executeInSandbox } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

const noInvoke: SandboxToolInvoker = { invoke: async () => null };

async function runFs(
	code: string,
	options?: { bytes?: number; entries?: number },
) {
	return executeInSandbox({
		sandbox: quickjs({
			maxFsBytes: options?.bytes ?? 16,
			maxFsEntries: options?.entries ?? 1,
		}),
		code,
		invoker: noInvoke,
		context: { mountFs: { a: "x" } },
	});
}

describe("bounded candidate probes", () => {
	it("truncate and ftruncate cross a tiny byte quota", async () => {
		const truncated = await runFs(
			'const fs=await import("node:fs"); fs.truncateSync("/a",64); return fs.statSync("/a").size;',
		);
		expect(truncated.output).toMatchObject({ result: 64 });

		const ftruncated = await runFs(
			'const fs=await import("node:fs"); const fd=fs.openSync("/a","r+"); fs.ftruncateSync(fd,64); fs.closeSync(fd); return fs.statSync("/a").size;',
		);
		expect(ftruncated.output).toMatchObject({ result: 64 });
	});

	it("mkdtemp crosses a one-entry quota", async () => {
		const result = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 16, maxFsEntries: 1 }),
			code: 'const fs=await import("node:fs"); fs.mkdtempSync("/t"); fs.mkdtempSync("/t"); return fs.readdirSync("/").filter(x=>x.startsWith("t")).length;',
			invoker: noInvoke,
			context: { mountFs: {} },
		});
		expect(result.output).toMatchObject({ result: 2 });
	});

	it("copy, link, rename, and symlink do not account for destinations", async () => {
		const copied = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 6, maxFsEntries: 1 }),
			code: 'const fs=await import("node:fs"); fs.copyFileSync("/a","/b"); fs.copyFileSync("/a","/c"); return fs.readdirSync("/").filter(x=>["a","b","c"].includes(x)).length;',
			invoker: noInvoke,
			context: { mountFs: { a: "xxxx" } },
		});
		expect(copied.output).toMatchObject({ result: 3 });

		const linked = await runFs(
			'const fs=await import("node:fs"); fs.linkSync("/a","/b"); fs.linkSync("/a","/c"); return fs.readdirSync("/").filter(x=>["a","b","c"].includes(x)).length;',
		);
		expect(linked.output).toMatchObject({ result: 3 });

		const renamed = await runFs(
			'const fs=await import("node:fs"); fs.renameSync("/a","/"+"d".repeat(64)); return fs.readdirSync("/").find(x=>x.startsWith("d")).length;',
			{ bytes: 8 },
		);
		expect(renamed.output).toMatchObject({ result: 64 });

		const symlinked = await executeInSandbox({
			sandbox: quickjs({ maxFsBytes: 16, maxFsEntries: 1 }),
			code: 'const fs=await import("node:fs"); fs.symlinkSync("/target","/s1"); fs.symlinkSync("/target","/s2"); return fs.readdirSync("/").filter(x=>x.startsWith("s")).length;',
			invoker: noInvoke,
			context: { mountFs: {} },
		});
		expect(symlinked.output).toMatchObject({ result: 2 });
	});

	it("createWriteStream reachability is characterized safely", async () => {
		const streamed = await runFs(
			'const fs=await import("node:fs"); const s=fs.createWriteStream("/s"); await new Promise((resolve,reject)=>{s.on("error",reject); s.on("finish",resolve); s.end("12345678901234567890123456789012");}); return fs.statSync("/s").size;',
			{ bytes: 8 },
		);
		expect(streamed.output).toBeDefined();
		console.info("createWriteStream probe", streamed.output);
	});

	it("alternate console methods reach the ambient host console", async () => {
		const count = vi
			.spyOn(console, "count")
			.mockImplementation(() => undefined);
		try {
			const result = await executeInSandbox({
				sandbox: quickjs(),
				code: 'console.count("SAFE_MARKER"); return 1;',
				invoker: noInvoke,
				context: {},
			});
			expect(result.output.result).toBe(1);
			expect(count).toHaveBeenCalledWith("SAFE_MARKER");
		} finally {
			count.mockRestore();
		}
	});

	it("host nested work outlives the guest timeout", async () => {
		let completed = false;
		const result = await executeInSandbox({
			sandbox: quickjs({ timeoutMs: 5 }),
			code: "await tools.slow({}); return 1;",
			invoker: {
				invoke: async () => {
					await new Promise((resolve) => setTimeout(resolve, 100));
					completed = true;
					return { ok: true };
				},
			},
			context: {},
		});
		expect(result.output.error).toMatch(/time/i);
		expect(completed).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(completed).toBe(true);
	});

	it("host fetch work outlives the guest timeout", async () => {
		let completed = false;
		const result = await executeInSandbox({
			sandbox: quickjs({ timeoutMs: 5 }),
			code: 'await fetch("https://example.test"); return 1;',
			invoker: noInvoke,
			context: {
				fetchAdapter: async () => {
					await new Promise((resolve) => setTimeout(resolve, 100));
					completed = true;
					return { status: 200 };
				},
			},
		});
		expect(result.output.error).toMatch(/time/i);
		expect(completed).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(completed).toBe(true);
	});

	it("a non-JSON nested result exposes its host callable", async () => {
		let called = 0;
		const result = await executeInSandbox({
			sandbox: quickjs(),
			code: 'const r=await tools.x({}); return {type:typeof r.output.call, value:r.output.call("arg")};',
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
		expect(result.output.result).toEqual({
			type: "function",
			value: "host:arg",
		});
		expect(called).toBe(1);
	});
});
