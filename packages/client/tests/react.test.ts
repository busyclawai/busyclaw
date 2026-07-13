// @vitest-environment happy-dom
// The react binding over the same injected-fetch seam as the vanilla tests. Hooks are driven with
// `react-dom/client` + React's own `act` — no renderer library: a Probe component calling the
// hook is the whole harness. Covers the `use${Capitalize(key)}` renaming, re-render on store
// change (incl. the signal-toggle refetch path through the REAL approvals machinery), the
// wrapper forwarding the vanilla surface untouched, and the capitalization-collision fail-loud.
// The root-stays-react-free checks live in react-free.test.ts (node env — they walk the fs).

import { atom } from "nanostores";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { ClawClientPlugin, ClawFetchLike } from "../src/index";
import { approvalsClient } from "../src/plugins/index";
import { createClawClient } from "../src/react/index";

// React's `act` batching is opt-in; without the flag it warns and skips the flushing we rely on.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function envelopeResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "content-type": "application/json" },
	});
}

type RecordedCall = { url: string; init: RequestInit | undefined };

function recordingFetch(
	respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: RecordedCall[]; fetch: ClawFetchLike } {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			calls.push({ init, url: String(input) });
			return respond(String(input), init);
		},
	};
}

async function until(check: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("condition not reached in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** The minimal hook harness: a Probe component renders the hook and records the latest value. */
function renderHook<T>(useHook: () => T): {
	latest: () => T;
	renders: () => number;
	unmount: () => void;
} {
	let current: { value: T } | undefined;
	let renders = 0;
	function Probe(): null {
		renders += 1;
		current = { value: useHook() };
		return null;
	}
	const root = createRoot(document.createElement("div"));
	act(() => {
		root.render(createElement(Probe));
	});
	return {
		latest: () => {
			if (current === undefined) throw new Error("hook never rendered");
			return current.value;
		},
		renders: () => renders,
		unmount: () => {
			act(() => {
				root.unmount();
			});
		},
	};
}

describe("atom → hook renaming and re-rendering", () => {
	it("maps an atom to its use-capitalized hook and re-renders on store change", async () => {
		const count = atom(1);
		const counter = {
			getAtoms: () => ({ count }),
			id: "counter",
		} satisfies ClawClientPlugin;
		const { fetch } = recordingFetch(() =>
			envelopeResponse({ data: null, ok: true }),
		);
		const client = createClawClient({ fetch, plugins: [counter] });

		expect(typeof client.useCount).toBe("function");
		const { latest, renders, unmount } = renderHook(() => client.useCount());
		expect(latest()).toBe(1);

		act(() => {
			count.set(2);
		});
		expect(latest()).toBe(2);

		// Identical value → no notification, snapshot ref holds → no re-render.
		const settled = renders();
		act(() => {
			count.set(2);
		});
		expect(renders()).toBe(settled);
		unmount();
	});

	it("re-renders an atom-backed hook when a mutation's signal toggles a refetch", async () => {
		let pending: unknown[] = [{ id: "appr-1", status: "pending" }];
		const { fetch } = recordingFetch((url) => {
			if (url.includes("/list-approvals")) {
				return envelopeResponse({ data: pending, ok: true });
			}
			if (url.includes("/grant-approval")) {
				pending = [];
				return envelopeResponse({
					data: { id: "appr-1", status: "granted" },
					ok: true,
				});
			}
			return envelopeResponse({ data: null, ok: true });
		});
		const client = createClawClient({ fetch, plugins: [approvalsClient()] });

		const { latest, unmount } = renderHook(() => client.usePendingApprovals());
		// Lazy onMount: the hook's first render shows the pending initial state...
		expect(latest().isPending).toBe(true);
		expect(latest().data).toBeNull();

		// ...then the mount-triggered fetch lands and the hook re-renders with data.
		await act(async () => {
			await until(() => latest().data !== null);
		});
		expect(latest().data).toEqual([{ id: "appr-1", status: "pending" }]);

		// A matching mutation toggles the signal (10ms deferred) → refetch → re-render with [].
		await act(async () => {
			const granted = await client.grantApproval({
				approvalId: "appr-1",
				by: "user:reviewer",
			});
			expect(granted.error).toBeNull();
			await until(() => latest().data?.length === 0);
		});
		expect(latest().isPending).toBe(false);
		unmount();
	});
});

describe("the wrapper stays the vanilla client", () => {
	it("forwards base methods, atoms, and proxy namespaces untouched", async () => {
		const { calls, fetch } = recordingFetch(() =>
			envelopeResponse({ data: { id: "c-1" }, ok: true }),
		);
		const client = createClawClient({ fetch, plugins: [approvalsClient()] });

		const result = await client.getClaw({ id: "c-1" });
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ id: "c-1" });
		expect(calls[0]?.url).toContain("/api/euroclaw/get-claw?");
		expect(client.$store.atoms.pendingApprovals).toBeDefined();

		// Unknown names still route by convention through the inner proxy.
		const namespaced = client as unknown as {
			secrets: { set: (input: unknown) => Promise<unknown> };
		};
		await namespaced.secrets.set({ name: "NOTION", value: "tok" });
		expect(calls[1]?.url).toBe("/api/euroclaw/secrets/set");
		expect(calls[1]?.init?.method).toBe("POST");
	});

	it("fails loud when two atom keys collide after capitalization", () => {
		expect(() =>
			createClawClient({
				plugins: [
					{ getAtoms: () => ({ fooBar: atom(0) }), id: "a" },
					{ getAtoms: () => ({ FooBar: atom(0) }), id: "b" },
				],
			}),
		).toThrow(/duplicate euroclaw client hook key/);
	});
});
