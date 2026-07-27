// Isolation hardening — ESCAPE: a hostile guest cannot reach the network, the host filesystem,
// host process/env globals, or host internals. Every test encodes a boundary that MUST hold; a
// failure here is a genuine finding, not a flaky test. Provider-level (executeInSandbox + a stub
// invoker) so the assertions observe exactly what the guest can reach.

import { describe, expect, it } from "vitest";
import type {
	SandboxInvokeInput,
	SandboxToolInvoker,
} from "../src/core/contracts";
import { executeInSandbox } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

// The wasm module load is memoized per instance; one guest context is still created per execute,
// so a single provider is safe to share across these read-only escape probes.
const sandbox = quickjs();

// A stub that fails the test if the guest reaches the host bridge when it should not.
const noInvoke: SandboxToolInvoker = {
	invoke: async () => {
		throw new Error("invoker should not be called");
	},
};

describe("@busyclaw/sandboxes escape boundary", () => {
	// E1 — there is no working network without a host-supplied adapter: any reachable `fetch` is the
	// wrapper's throwing stub.
	it("E1: exposes no working fetch without an adapter", async () => {
		const { output: res } = await executeInSandbox({
			sandbox,
			code: `
				const out = { fetchType: typeof fetch, globalFetchType: typeof globalThis.fetch };
				try {
					await fetch("https://x.test/");
					out.call = "RESOLVED";
				} catch (e) {
					out.call = String(e);
				}
				return out;
			`,
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeUndefined();
		const out = res.result as {
			fetchType: string;
			globalFetchType: string;
			call: string;
		};
		// `fetch` may be present as a symbol, but invoking it must fail closed — never a live request.
		expect(out.call).not.toBe("RESOLVED");
		expect(out.call).toMatch(/disabled|not supported/i);
	}, 30000);

	// E2 — no alternate network builtins exist. [P0-if-fails]: a working one is an uncontrolled egress
	// channel that bypasses the governed fetch seam entirely.
	it("E2: exposes no alternate network builtins", async () => {
		const { output: res } = await executeInSandbox({
			sandbox,
			code: `return {
				xhr: typeof XMLHttpRequest,
				ws: typeof WebSocket,
				imp: typeof importScripts,
				nav: typeof navigator,
			};`,
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeUndefined();
		expect(res.result).toEqual({
			xhr: "undefined",
			ws: "undefined",
			imp: "undefined",
			nav: "undefined",
		});
	}, 30000);

	// E3 — no host filesystem and no process spawning without a mount. child_process/os must be
	// absent (spawning is [P0-if-fails]); `node:fs` may be importable (memfs) but must NEVER reach the
	// real host disk: unmounted it is disabled, and a probe of a real host path must fail.
	it("E3: grants no working host filesystem or process handle", async () => {
		const { output: res } = await executeInSandbox({
			sandbox,
			code: `
				const out = { require: typeof require };
				async function probe(mod) {
					try { await import(mod); return "IMPORTED"; }
					catch (e) { return String(e); }
				}
				out.childProcess = await probe("node:child_process");
				out.os = await probe("node:os");
				// node:fs may import (memfs); the real test is that it cannot read the host disk.
				try {
					const fs = await import("node:fs");
					out.fsImport = "IMPORTED";
					try {
						fs.readFileSync("/etc/hostname", "utf8");
						out.hostRead = "READ_HOST_FILE";
					} catch (e) {
						out.hostRead = String(e);
					}
				} catch (e) {
					out.fsImport = String(e);
					out.hostRead = "no-fs";
				}
				return out;
			`,
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeUndefined();
		const out = res.result as Record<string, string>;
		// No require, no process spawning.
		expect(out.require).toBe("undefined");
		expect(out.childProcess).not.toBe("IMPORTED");
		expect(out.os).not.toBe("IMPORTED");
		// Even if `node:fs` imports, it must never surface real host-disk contents.
		expect(out.hostRead).not.toBe("READ_HOST_FILE");
		expect(out.hostRead).toMatch(/disabled|no such file|ENOENT|not|error/i);
	}, 30000);

	// E4 — no host environment leakage. [P0-if-fails]: a leaked host secret (a real process.env value)
	// is exfiltration. The injected bridge key is acceptable; a host env var is not.
	it("E4: leaks no host environment variables", async () => {
		const { output: res } = await executeInSandbox({
			sandbox,
			code: `return {
				hasProcess: typeof process,
				envKeys: Object.keys(env),
				procEnvKeys: (typeof process !== "undefined" && process.env) ? Object.keys(process.env) : [],
				procEnvValues: (typeof process !== "undefined" && process.env)
					? Object.values(process.env).filter((v) => typeof v === "string")
					: [],
			};`,
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeUndefined();
		const out = res.result as {
			envKeys: string[];
			procEnvKeys: string[];
			procEnvValues: string[];
		};
		const forbidden = ["PATH", "HOME", "USER", "PWD"];
		for (const keys of [out.envKeys, out.procEnvKeys]) {
			for (const key of keys) {
				expect(forbidden).not.toContain(key);
				expect(key.startsWith("NODE_")).toBe(false);
			}
		}
		// No guest env value equals a real host secret (assert against concrete host values).
		for (const hostValue of [
			process.env.HOME,
			process.env.PATH,
			process.env.USER,
		]) {
			if (hostValue) expect(out.procEnvValues).not.toContain(hostValue);
		}
	}, 30000);

	// E5 — `env` holds only the bridge: nothing that exposes host state.
	it("E5: env exposes only the __invoke bridge", async () => {
		const { output: res } = await executeInSandbox({
			sandbox,
			code: `return Object.keys(env);`,
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeUndefined();
		expect(res.result).toEqual(["__invoke"]);
	}, 30000);

	// E6 — the Function-constructor walk cannot escape the guest heap. [P0-if-fails]. The classic
	// escapes reach only the guest's OWN global (=== globalThis): no host require, no host env, and
	// the reachable fetch is the same throwing guest stub — no additional authority is granted.
	it("E6: the Function-constructor walk reaches only the guest global", async () => {
		const { output: res } = await executeInSandbox({
			sandbox,
			code: `
				const g1 = (function(){}).constructor("return this")();
				const g2 = [].constructor.constructor("return globalThis")();
				return {
					g1SameGlobal: g1 === globalThis,
					g2SameGlobal: g2 === globalThis,
					hasRequire: typeof g1.require,
					fetchSameStub: g1.fetch === globalThis.fetch,
					procEnvKeys: (g1.process && g1.process.env) ? Object.keys(g1.process.env) : [],
				};
			`,
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeUndefined();
		const out = res.result as {
			g1SameGlobal: boolean;
			g2SameGlobal: boolean;
			hasRequire: string;
			fetchSameStub: boolean;
			procEnvKeys: string[];
		};
		// Both walks land on the guest's own global — not a fresh host realm.
		expect(out.g1SameGlobal).toBe(true);
		expect(out.g2SameGlobal).toBe(true);
		// No host require, no host env, no working host fetch surfaced by the walk.
		expect(out.hasRequire).toBe("undefined");
		expect(out.fetchSameStub).toBe(true);
		expect(out.procEnvKeys).toEqual(["__invoke"]);
	}, 30000);

	// E7 — env.__invoke IS the boundary; the `tools` proxy is only sugar. A direct call bypassing the
	// proxy is routed identically (and therefore governed identically): the invoker sees the same
	// { path, args } and its returned VALUE round-trips back to the guest.
	it("E7: a direct env.__invoke call is routed and valued identically to the proxy", async () => {
		const calls: SandboxInvokeInput[] = [];
		const invoker: SandboxToolInvoker = {
			invoke: async (input) => {
				calls.push(input);
				return { echoed: input.args };
			},
		};
		const { output: res } = await executeInSandbox({
			sandbox,
			code: `return await env.__invoke("some.tool", { a: 1 });`,
			invoker,
			context: {},
		});
		expect(res.error).toBeUndefined();
		expect(calls).toEqual([{ path: "some.tool", args: { a: 1 } }]);
		// The invoker's VALUE round-trips to the guest — a direct call grants no extra authority.
		expect(res.result).toEqual({ echoed: { a: 1 } });
	}, 30000);

	// E8 — the bridge leaks no host internals: stringifying the injected function must not expose a
	// host filesystem path, busyclaw source, or subInvoke/handler internals.
	it("E8: the __invoke bridge exposes no host source or internals", async () => {
		const { output: res } = await executeInSandbox({
			sandbox,
			code: `return String(env.__invoke);`,
			invoker: noInvoke,
			context: {},
		});
		expect(res.error).toBeUndefined();
		const str = res.result as string;
		// QuickJS renders host functions as opaque native code — record and assert that shape.
		expect(str).toContain("native code");
		expect(str).not.toMatch(/subInvoke|handleToolCall|invoker\.invoke/);
		expect(str).not.toMatch(/\/Users\/|\/home\/|node_modules|packages\//);
	}, 30000);
});
