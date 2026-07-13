// Query atoms: a lazily-fetched `{ data, error, isPending, isRefetching, refetch }` store over one
// GET-shaped api call (adapted from better-auth's useAuthQuery — see THIRD_PARTY_NOTICES.md).
// The hard-won behaviors adopted: no request until the first subscriber (`onMount`), an
// AbortController cancels the in-flight fetch on refetch/unmount, stale data survives non-401
// errors (401 clears it — the session is gone), and identical payloads keep the same object
// reference so equality-checking renderers don't re-render.
//
// DELIBERATE deviation from better-auth: no `typeof window` SSR guard. `onMount` already never
// fires during SSR (nothing subscribes server-side), and this vanilla core must fetch in
// node/native hosts — the injectable-fetch seam — where `window` never exists.

import type { EndpointHttpMethod } from "@euroclaw/contracts";
import type { ReadableAtom } from "nanostores";
import { atom, onMount } from "nanostores";
import type { ClawClientError, ClawClientFetch } from "./types";

export type ClawQueryState<T> = {
	data: T | null;
	error: ClawClientError | null;
	/** True only while fetching WITHOUT data yet (first load); refetches keep data and set
	 *  `isRefetching` instead. */
	isPending: boolean;
	isRefetching: boolean;
	refetch: () => Promise<void>;
};

export type ClawQueryAtomConfig = {
	$fetch: ClawClientFetch;
	/** Route path relative to the client base (e.g. `/list-approvals`). */
	path: string;
	/** Wire verb; defaults to GET — query atoms are reads. */
	method?: EndpointHttpMethod;
	/** The call input (GET rides `?input=`). */
	input?: unknown;
	/** Boolean signal atoms that trigger a refetch when toggled while the query is mounted. */
	signals?: readonly ReadableAtom<boolean>[];
};

function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

export function createQueryAtom<T>(
	config: ClawQueryAtomConfig,
): ReadableAtom<ClawQueryState<T>> {
	let controller: AbortController | undefined;

	const refetch = (): Promise<void> => fetchData();
	const state = atom<ClawQueryState<T>>({
		data: null,
		error: null,
		isPending: true,
		isRefetching: false,
		refetch,
	});

	// The equality gate: a state identical to the current one (data by reference — see the
	// stable-reference dance below) never notifies subscribers.
	const setState = (next: ClawQueryState<T>): void => {
		const current = state.get();
		if (
			current.data === next.data &&
			current.error === next.error &&
			current.isPending === next.isPending &&
			current.isRefetching === next.isRefetching
		) {
			return;
		}
		state.set(next);
	};

	// An aborted fetch settles the flags it raised (only if it still owns the in-flight slot) and
	// writes NOTHING else — the newer fetch owns the outcome.
	const settleAborted = (aborted: AbortController): void => {
		if (controller !== aborted) return;
		controller = undefined;
		const current = state.get();
		if (!current.isPending && !current.isRefetching) return;
		setState({ ...current, isPending: false, isRefetching: false });
	};

	const fetchData = async (): Promise<void> => {
		controller?.abort();
		const own = new AbortController();
		controller = own;
		const current = state.get();
		setState({
			data: current.data,
			error: null,
			isPending: current.data === null,
			isRefetching: true,
			refetch,
		});
		const result = await config.$fetch<T>(config.path, {
			input: config.input,
			method: config.method ?? "GET",
			signal: own.signal,
		});
		if (own.signal.aborted) {
			settleAborted(own);
			return;
		}
		if (result.error) {
			const latest = state.get();
			setState({
				data: result.error.status === 401 ? null : latest.data,
				error: result.error,
				isPending: false,
				isRefetching: false,
				refetch,
			});
			return;
		}
		const latest = state.get();
		const stable =
			latest.data !== null &&
			result.data !== null &&
			jsonEqual(latest.data, result.data)
				? latest.data
				: result.data;
		setState({
			data: stable,
			error: null,
			isPending: false,
			isRefetching: false,
			refetch,
		});
	};

	onMount(state, () => {
		// Deferred a tick so subscribing never fetches synchronously mid-render.
		const timeout = setTimeout(() => {
			void fetchData();
		}, 0);
		// `listen` (not `subscribe`): signals fire refetches on CHANGE only, never on wiring up.
		const unbinds = (config.signals ?? []).map((signal) =>
			signal.listen(() => {
				void fetchData();
			}),
		);
		return () => {
			clearTimeout(timeout);
			const own = controller;
			own?.abort();
			if (own) settleAborted(own);
			for (const unbind of unbinds) unbind();
		};
	});

	return state;
}
