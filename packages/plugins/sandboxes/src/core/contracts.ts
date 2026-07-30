// The sandboxes floor — the Sandbox provider contract, the normalized ExecutionContext view, and
// the two shapes that cross the sandbox→host trust boundary. Every provider and the shared engine
// build on this module; nothing here imports a provider or the wasm dependency.
//
// Schema discipline (the channels precedent): arktype ONLY where untrusted, agent-authored data
// crosses a boundary — the execution result and the invoker input. Ports (Sandbox,
// SandboxToolInvoker) and host-assembled views (ExecutionContext, IsolationPosture) stay plain TS.

import type { EgressLookup } from "@busyclaw/egress";
import { type } from "arktype";

// UNTRUSTED (sandbox → host): validated by the ENGINE at the boundary. `result` is the value the
// sandboxed code returned; it must be JSON-safe (the host builds it that way — see the provider).
export const executionResult = type({
	result: "unknown",
	"logs?": "string[]",
	"error?": "string",
});
export type ExecutionResult = typeof executionResult.infer;

// What sandboxed code hands the invoker — validated BEFORE it reaches subInvoke. handleToolCall
// re-validates the ToolCall downstream; this catches a malformed/hostile shape at the door with a
// sandbox-legible value.
export const sandboxInvokeInput = type({ path: "string", args: "unknown" });
export type SandboxInvokeInput = typeof sandboxInvokeInput.infer;

/**
 * The governed-fetch seam. Mirrors global fetch structurally so the floor needs no DOM lib (this
 * repo builds without `DOM`; channels' TelegramFetch is the same convention). When present on an
 * ExecutionContext the provider injects it as the sandbox's fetch; absent = fetch stays the
 * wrapper's throwing stub. The host returns the wrapper's mapped-response shape (delegate to
 * getDefaultFetchAdapter or emit it).
 */
export type SandboxFetch = (
	input: string | { readonly href: string },
	init?: unknown,
) => Promise<unknown>;

/**
 * What a host may choose about the guest's network. Every field narrows the floor; none removes it.
 */
export type SandboxNetwork = {
	/** Allow http targets (localhost dev / tests). Default false — https only. */
	allowInsecure?: boolean;
	/** Response body byte cap — the body crosses into the guest. Default 1 MB. */
	maxResponseBytes?: number;
	/** Per-request deadline. Default 30 s. Independent of the EXECUTION deadline, which now also
	 *  aborts anything still in flight. */
	timeoutMs?: number;
	/** DNS for the floor — a host may pin or cache; tests inject a fake. Default node:dns. Narrows
	 *  what the floor resolves; it cannot skip the range checks applied to the answer. */
	lookup?: EgressLookup;
	/**
	 * A TRUSTED transport beneath the floor — a corporate proxy, a custom TLS stack, a test fake.
	 *
	 * It replaces the socket, never the checks: the egress floor has already resolved and vetted the
	 * address before this is called. Understand what you are taking on, though — the pin rides on a
	 * non-standard `dispatcher` field, so a transport that ignores it resolves the hostname AGAIN at
	 * connect time and reopens DNS rebinding, which is the one thing the floor cannot do for you.
	 *
	 * A HOST fetch returning a real `Response` — deliberately not {@link SandboxFetch}, which is the
	 * guest-facing shape the floor produces after capping and flattening the response. This sits on
	 * the other side of that translation.
	 */
	transport?: typeof fetch;
};

/**
 * What a PROVIDER receives: the host's context with the network already resolved into one governed
 * adapter. Providers never see host network options and cannot be handed a raw fetch — by the time
 * a context reaches here the floor is on the path, or there is no network at all.
 */
export type ProviderExecutionContext = Omit<ExecutionContext, "network"> & {
	fetchAdapter?: SandboxFetch;
};

// PORTS + HOST-ASSEMBLED VIEWS: plain types — no runtime boundary to validate.

/**
 * A virtual filesystem tree — the wrapper's memfs NestedDirectoryJSON shape: a file is a string or
 * Uint8Array leaf, a directory is a nested object. Host-assembled (the engine builds it from a store,
 * the provider extracts it from memfs), NOT an untrusted boundary — plain TS, no arktype. The type
 * is recursive so tree walkers narrow leaves naturally instead of casting.
 */
export type VolumeNode = string | Uint8Array | VolumeTree;
export type VolumeTree = { [path: string]: VolumeNode };

/**
 * An opaque, provider-agnostic reference a SandboxVolumeStore interprets: an S3 adapter reads it as
 * bucket/prefix, a SharePoint adapter as drive/folder, the memory adapter as a map key. Kept a plain
 * string in v1 — never parsed by the engine.
 */
export type VolumeRef = string;

/**
 * The persistence port. The guest's `node:fs` is SYNCHRONOUS and cannot await a remote store, so the
 * model is snapshot-at-the-boundary: the engine async-`load`s a bounded tree into memfs BEFORE the
 * guest runs, the guest does sync reads/writes on that in-memory tree, and the engine async-`save`s
 * the mutated tree AFTER. (Lazy read-through / asyncify is deliberately deferred.) Plain-TS port —
 * host-assembled, no schema.
 */
export type SandboxVolumeStore = {
	/** Returns `{}` for an unknown ref — an unseeded ref is a fresh, empty volume, not an error. */
	load: (ref: VolumeRef) => Promise<VolumeTree>;
	save: (ref: VolumeRef, tree: VolumeTree) => Promise<void>;
};

/**
 * What a provider hands back: the arktype-validated guest result, PLUS the mutated fs tree when (and
 * only when) a tree was mounted. The tree rides ALONGSIDE `output`, never inside it — `output` stays
 * the clean, guest-facing `ExecutionResult` the runtime's tool.completed validation accepts.
 */
export type SandboxExecution = {
	output: ExecutionResult;
	fsTree?: VolumeTree;
};

export interface Sandbox {
	readonly provider: string;
	/** Two configs of one provider need distinct names — the channels distinct-(provider,name) fold. */
	readonly name?: string;
	/** Self-reported enforcement reality: selection input + strict-mode gate. */
	readonly posture: IsolationPosture;
	/** Assert usable at construction (wasm loadable) — fail at startup, not on first run_code. */
	validate?: () => void;
	execute: (input: {
		code: string; // already normalized by the ENGINE
		invoker: SandboxToolInvoker; // engine-wrapped; routes into handleToolCall
		context: ProviderExecutionContext; // network already resolved into a governed adapter
	}) => Promise<SandboxExecution>;
	dispose?: () => Promise<void>;
}

export type IsolationPosture = {
	kind: "wasm" | "process" | "isolate"; // quickjs | deno | workerd
	network: "blocked" | "allowlist" | "interceptor";
	filesystem: "none" | "scoped";
	memoryLimit: boolean;
	wallClockLimit: boolean;
};

export type ExecutionContext = {
	timeoutMs?: number;
	memoryLimitBytes?: number;
	/** Egress policy for THIS execution — reserved for the domain-allowlist step; absent/null = the
	 *  provider injects no fetch. The v1 quickjs provider consumes egress only as "fetch or not"
	 *  through `fetchAdapter` below; it does not read `domains`. */
	egress?: { domains?: readonly string[] } | null;
	modules?: Record<string, string>;
	/**
	 * Network for THIS execution. Absent = airgapped, and that stays the default.
	 *
	 * A POLICY, not a function. This slot used to be `fetchAdapter: SandboxFetch` — the host handed
	 * over the whole door — and a host that wrote `fetchAdapter: fetch` gave the guest 127.0.0.1,
	 * 169.254.169.254 and the private network with no error and no audit trail. The floor existed and
	 * was simply not on the path unless someone knew to call it. Making the safe thing short is worth
	 * something; making the unsafe thing UNSPELLABLE is worth more, so the shape is gone.
	 *
	 * The engine now applies {@link governedFetch} itself. What a host can still choose is the policy
	 * inside it, and — via `transport` — the socket underneath it.
	 */
	network?: SandboxNetwork;
	/** In-memory virtual filesystem tree to seed for this execution. memfs lives in the HOST heap and
	 *  is NOT bounded by `memoryLimitBytes`, so the provider enforces a byte budget at BOTH the seed
	 *  (load) and cumulative writes — see the quickjs provider's `maxFsBytes`. Absent = no fs. */
	mountFs?: VolumeTree;
};

export interface SandboxToolInvoker {
	invoke: (input: SandboxInvokeInput) => Promise<unknown>;
}
