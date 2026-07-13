// React 18/19-safe nanostores binding on `useSyncExternalStore` (adapted from better-auth's
// react-store.ts, which itself mirrors `@nanostores/react` — see THIRD_PARTY_NOTICES.md). The
// snapshot REF is the referential-churn guard: React re-reads the snapshot on every render and
// bails out when the reference is unchanged, so the ref only moves when the store actually
// changed (the query atoms' stable-reference dance stays intact through the hook). The
// subscribe-time `emitChange` closes the React 18 gap between first render (ref init) and
// effect-time subscription — a store that changed in between still lands. Reduced from the
// reference: no `keys`/`deps` options — the client registry holds plain atoms, not map stores.

import type { Store, StoreValue } from "nanostores";
import { useCallback, useRef, useSyncExternalStore } from "react";

export function useStore<SomeStore extends Store>(
	store: SomeStore,
): StoreValue<SomeStore> {
	const snapshotRef = useRef<StoreValue<SomeStore>>(store.get());

	const subscribe = useCallback(
		(onChange: () => void) => {
			const emitChange = (value: StoreValue<SomeStore>): void => {
				if (snapshotRef.current === value) return;
				snapshotRef.current = value;
				onChange();
			};
			// `get()` (not `.value`): always initialized, even on a lazily-mounted query atom.
			emitChange(store.get());
			return store.listen(emitChange);
		},
		[store],
	);

	const getSnapshot = (): StoreValue<SomeStore> => snapshotRef.current;

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
