// The QuickJS provider: model-authored JavaScript in an in-process WebAssembly interpreter, wrapping
// `@sebastianwessel/quickjs` (sync variant) with euroclaw's audited hardening posture. The wasm
// dependency is imported at module top HERE ONLY — this subpath keeps it out of the root import
// graph (channels subpath-isolation precedent).

import { configurationError } from "@euroclaw/contracts";
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import {
	createVirtualFileSystem,
	loadQuickJs,
	type SandboxOptions,
} from "@sebastianwessel/quickjs";
import type { IFs, NestedDirectoryJSON, Volume } from "memfs";
import type {
	ExecutionContext,
	ExecutionResult,
	IsolationPosture,
	Sandbox,
	SandboxExecution,
	SandboxToolInvoker,
	VolumeTree,
} from "../../core/contracts";

export type QuickJsConfig = {
	/** Hard memory cap in bytes. POSITIVE only (0/-1 mean unbounded in the wrapper). Default 64MB. */
	memoryLimitBytes?: number;
	/** Max stack bytes. Default 1MB. */
	maxStackSizeBytes?: number;
	/** Wall-clock kill. Default 5000ms. */
	timeoutMs?: number;
	/** Timer caps (the wrapper's host-backed timers cannot be disabled; cap them low). Default 4 each. */
	maxTimeoutCount?: number;
	maxIntervalCount?: number;
	/** Byte budget for a mounted filesystem — enforced at BOTH the seed (load) and cumulative writes.
	 *  memfs lives in the HOST heap and is NOT bounded by `memoryLimitBytes`, so this cap is the only
	 *  thing standing between a write-bomb and a host OOM. Default 16MB. */
	maxFsBytes?: number;
};

const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TIMER_COUNT = 4;
const DEFAULT_MAX_FS_BYTES = 16 * 1024 * 1024;

// Host globals not ambiently typed here (this package builds without a node lib) — cast like
// engine.ts's globalThis cast. Buffer gives an exact utf8 byte length for a write payload.
const host = globalThis as typeof globalThis & {
	Buffer: { byteLength: (input: string, encoding?: string) => number };
};

// Byte size of a single write payload: a string is measured as utf8; a typed array / ArrayBuffer by
// its byteLength. This is the unit both budgets count in.
function byteSizeOf(data: unknown): number {
	if (typeof data === "string") return host.Buffer.byteLength(data);
	if (data instanceof Uint8Array) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	if (data instanceof ArrayBuffer) return data.byteLength;
	return host.Buffer.byteLength(String(data));
}

// Total byte size of a seed tree — the LOAD budget's measure. Recurses the nested dirs and sums the
// string/binary leaves; ignores the keys (path names) themselves, which the budget need not bound.
function treeByteSize(node: unknown): number {
	if (node === null || node === undefined) return 0;
	if (
		typeof node === "string" ||
		node instanceof Uint8Array ||
		ArrayBuffer.isView(node)
	) {
		return byteSizeOf(node);
	}
	if (typeof node !== "object") return 0;
	let total = 0;
	for (const value of Object.values(node as Record<string, unknown>)) {
		total += treeByteSize(value);
	}
	return total;
}

// Extract the mutated user tree from the volume. memfs `toJSON()` is FLAT (`{ "/a/b.txt": "..." }`)
// and includes the provider-managed `/node_modules` plus an auto-added empty `/src` sentinel — strip
// both, then rebuild the nested NestedDirectoryJSON shape the store round-trips as a VolumeTree.
function extractTree(vol: Volume): VolumeTree {
	const flat = vol.toJSON();
	const tree: VolumeTree = {};
	for (const [path, content] of Object.entries(flat)) {
		if (path === "/node_modules" || path.startsWith("/node_modules/")) continue;
		if (content === null) continue; // empty-directory sentinel (e.g. the wrapper's /src)
		const segments = path.split("/").filter((s) => s.length > 0);
		if (segments.length === 0) continue;
		let node = tree;
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i] ?? "";
			const next = node[seg];
			// A leaf (string/binary) at a directory path is replaced by a fresh dir — same rule for
			// both leaf kinds (previously a binary leaf would have been descended into as a tree).
			if (
				next !== undefined &&
				typeof next === "object" &&
				!(next instanceof Uint8Array)
			) {
				node = next;
			} else {
				const created: VolumeTree = {};
				node[seg] = created;
				node = created;
			}
		}
		const leaf = segments[segments.length - 1] ?? "";
		node[leaf] = content;
	}
	return tree;
}

// Cap cumulative bytes written to a memfs IFs DURING the run. The wall-clock timeout is too weak
// here: memfs is HOST heap, so a tight `writeFileSync` loop OOMs the host process before the timer
// fires. Each capped method checks the running total BEFORE the real write, so an over-budget write
// never reaches host memory; the throw surfaces as a normal error VALUE (the runSandboxed catch
// converts it) that the model reads as "quota exceeded" and adapts to. The guest bridge (the
// wrapper's provideFs) calls these by name on this exact IFs, so a name-keyed override is invoked.
function capWrites(fs: IFs, maxBytes: number): void {
	let written = 0;
	const charge = (bytes: number): void => {
		if (written + bytes > maxBytes) {
			throw new Error(
				`filesystem quota exceeded: ${maxBytes}-byte budget for this run`,
			);
		}
		written += bytes;
	};
	// Blessed seam cast: memfs types each write method as a heavy overload set; the cap overrides the
	// write surface uniformly as string-keyed functions.
	const surface = fs as unknown as Record<
		string,
		((...args: unknown[]) => unknown) | undefined
	>;
	const cap = (name: string, payloadIndex: number): void => {
		const original = surface[name];
		if (typeof original !== "function") return;
		const bound = original.bind(fs);
		surface[name] = (...args: unknown[]) => {
			charge(byteSizeOf(args[payloadIndex]));
			return bound(...args);
		};
	};
	// writeFile/appendFile(path, data, …) and fd write(fd, data, …): the payload is arg 1.
	for (const name of [
		"writeFileSync",
		"writeFile",
		"appendFileSync",
		"appendFile",
		"writeSync",
		"write",
	]) {
		cap(name, 1);
	}
	// mkdir(path, …): no file bytes, but charge the path length so a mkdir-bomb is bounded too (arg 0).
	for (const name of ["mkdirSync", "mkdir"]) {
		cap(name, 0);
	}
}

// The guest prelude: builds a `tools` proxy over the env-injected `__invoke`. Property access
// appends a path segment; calling it invokes `__invoke(segments.join("."), args)` and returns its
// (host-bridged) promise. Dependency-free guest JS — no TypeScript.
const PRELUDE = `
const __invoke = env.__invoke;
const __seg = (path) => new Proxy(function () {}, {
	get: (_t, key) => __seg([...path, String(key)]),
	apply: (_t, _self, args) => __invoke(path.join("."), args[0]),
});
const tools = new Proxy({}, { get: (_t, top) => __seg([String(top)]) });
`;

// The wrapper evaluates the body as a module: wrap the model's code in an async IIFE so top-level
// `return` works, and export the awaited result. Model code that needs a module (e.g. node:fs) uses
// dynamic `import()`, which is a valid expression inside the IIFE.
function guestBody(code: string): string {
	return `${PRELUDE}\nexport default await (async () => {\n${code}\n})();\n`;
}

function render(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

// Build an ExecutionResult whose properties are all JSON-safe and never undefined-VALUED: the
// runtime's tool.completed validation rejects undefined-valued properties, so `error`/`logs` are
// absent-if-empty and a missing `result` collapses to null.
function toExecutionResult(input: {
	result: unknown;
	logs: string[];
	error?: string;
}): ExecutionResult {
	return {
		result: input.result === undefined ? null : input.result,
		...(input.logs.length > 0 ? { logs: input.logs } : {}),
		...(input.error !== undefined ? { error: input.error } : {}),
	};
}

// Static per-provider baseline. The per-execution injections (fetchAdapter, mountFs) are visible in
// the ExecutionContext; posture reporting becomes dynamic when the selection registry lands.
const POSTURE: IsolationPosture = {
	kind: "wasm",
	network: "blocked",
	filesystem: "none",
	memoryLimit: true,
	wallClockLimit: true,
};

export function quickjs(config: QuickJsConfig = {}): Sandbox {
	const memoryLimit = config.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
	if (memoryLimit <= 0) {
		throw configurationError("quickjs memoryLimitBytes must be positive", {
			memoryLimitBytes: config.memoryLimitBytes,
			reason:
				"the wrapper treats 0 and -1 as unbounded — a positive cap is required",
		});
	}
	const maxStackSize = config.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES;
	const executionTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxTimeoutCount = config.maxTimeoutCount ?? DEFAULT_TIMER_COUNT;
	const maxIntervalCount = config.maxIntervalCount ?? DEFAULT_TIMER_COUNT;
	const maxFsBytes = config.maxFsBytes ?? DEFAULT_MAX_FS_BYTES;
	if (maxFsBytes <= 0) {
		throw configurationError("quickjs maxFsBytes must be positive", {
			maxFsBytes: config.maxFsBytes,
		});
	}

	// loadQuickJs is resource-intensive → load once, lazily, per provider instance.
	let loaded: ReturnType<typeof loadQuickJs> | undefined;
	const load = () => {
		loaded ??= loadQuickJs(variant);
		return loaded;
	};

	return {
		provider: "quickjs",
		posture: POSTURE,

		validate() {
			// Startup validation = "the wasm variant module is present"; a load failure surfaces on
			// first execute.
			if (!variant) {
				throw configurationError("quickjs wasm variant is unavailable", {
					reason: "install @jitl/quickjs-ng-wasmfile-release-sync",
				});
			}
		},

		async execute(input: {
			code: string;
			invoker: SandboxToolInvoker;
			context: ExecutionContext;
		}): Promise<SandboxExecution> {
			const { runSandboxed } = await load();
			const logs: string[] = [];
			const capture =
				(level: string) =>
				(...params: unknown[]) => {
					logs.push(`${level}: ${params.map(render).join(" ")}`);
				};

			// Filesystem, default-absent. When a tree is mounted we seed a memfs volume OURSELVES via
			// the wrapper's own builder (it adds the /node_modules shims that back `node:fs`), enforce
			// the LOAD budget on the seed, and cap writes on the returned IFs. We then hand that guarded
			// IFs to the wrapper's `mountFs` slot: setupFileSystem detects an IFs and uses it verbatim
			// (skipping its own seeding), so provideFs's write bridge calls OUR capped methods. We hold
			// the `vol` to snapshot the mutated tree out via toJSON() after the run.
			let vol: Volume | undefined;
			let mountedFs: IFs | undefined;
			if (input.context.mountFs) {
				// LOAD budget: never pull an unbounded tree into host heap — refuse before seeding.
				const seedBytes = treeByteSize(input.context.mountFs);
				if (seedBytes > maxFsBytes) {
					throw configurationError(
						"mounted filesystem exceeds the byte budget",
						{ seedBytes, maxFsBytes },
					);
				}
				const built = createVirtualFileSystem({
					mountFs: input.context.mountFs as NestedDirectoryJSON,
				});
				vol = built.vol;
				mountedFs = built.fs;
				capWrites(mountedFs, maxFsBytes);
			}

			const options: SandboxOptions = {
				memoryLimit,
				maxStackSize,
				executionTimeout,
				maxTimeoutCount,
				maxIntervalCount,
				// The ONE host bridge. The wrapper bridges the returned host promise into a guest deferred.
				env: {
					__invoke: (path: string, args: unknown) =>
						input.invoker.invoke({ path, args }),
				},
				// Console is the only overridable ambient injection — route the six levels to the
				// per-execution sink; nothing reaches host stdout.
				console: {
					log: capture("log"),
					warn: capture("warn"),
					error: capture("error"),
					info: capture("info"),
					debug: capture("debug"),
					trace: capture("trace"),
				},
				// Fetch, default-absent. Both flags are required together — the wrapper silently ignores
				// the adapter without allowFetch. Classified seam: the wrapper types the slot as
				// `typeof fetch`; our structural SandboxFetch is the host's governed fetch.
				...(input.context.fetchAdapter
					? {
							allowFetch: true,
							fetchAdapter: input.context
								.fetchAdapter as SandboxOptions["fetchAdapter"],
						}
					: {}),
				// The write-capped IFs (the IFs path, not the NestedDirectoryJSON path). Classified
				// seam: the wrapper types the slot as `NestedDirectoryJSON | IFs`.
				...(mountedFs
					? {
							allowFs: true,
							mountFs: mountedFs as SandboxOptions["mountFs"],
						}
					: {}),
			};

			const body = guestBody(input.code);
			// Snapshot the mutated tree back out whenever a volume was mounted — INCLUDING on an error
			// outcome (a partial write already happened in memfs; the model reads the error and adapts).
			const withTree = (output: ExecutionResult): SandboxExecution =>
				vol ? { output, fsTree: extractTree(vol) } : { output };
			// Most guest faults come back as `{ ok: false, error }` (syntax error, timeout, thrown fetch
			// stub, and the write-cap throw above) — an expected failure VALUE the model reads and fixes.
			// But some abort the underlying wasm runtime and REJECT instead — notably deep recursion,
			// which trips a GC assertion (`list_empty(&rt->gc_obj_list)`) as the aborted context is
			// disposed. That abort is isolated to this one execution (a fresh context is built per call;
			// the module and sibling executions survive — verified), so we catch the throw and convert it
			// to the same failure VALUE rather than letting a host throw escape and fail the run_code call.
			try {
				const outcome = await runSandboxed(
					async ({ evalCode }) => evalCode(body),
					options,
				);
				return withTree(
					outcome.ok
						? toExecutionResult({ result: outcome.data, logs })
						: toExecutionResult({
								result: null,
								logs,
								error: outcome.error.message,
							}),
				);
			} catch (error) {
				return withTree(
					toExecutionResult({
						result: null,
						logs,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		},
	};
}
