// The in-memory SandboxVolumeStore — the reference adapter, and the one the persistence tests run
// against. Trees live in a Map keyed by VolumeRef; an unknown ref loads as an empty tree (a fresh
// volume, not an error). Dep-clean: no memfs, no wasm — this subpath stays out of the heavy graph so
// the root and the store side never pull the interpreter. S3/redis/SharePoint adapters are deferred.

import type {
	SandboxVolumeStore,
	VolumeNode,
	VolumeRef,
	VolumeTree,
} from "../../core/contracts";

// Deep-clone on the way in AND out so a returned tree can never mutate the stored one, nor a caller's
// later edits to a saved tree corrupt the store. Handles the VolumeTree leaf shapes: strings are
// immutable (shared safely), Uint8Array is copied, nested dirs recurse. No structuredClone dependency.
function cloneValue(value: VolumeNode): VolumeNode {
	if (value instanceof Uint8Array) return value.slice();
	if (typeof value === "object") return cloneTree(value);
	return value;
}

function cloneTree(tree: VolumeTree): VolumeTree {
	const out: VolumeTree = {};
	for (const [key, value] of Object.entries(tree)) {
		out[key] = cloneValue(value);
	}
	return out;
}

export function memoryVolumeStore(): SandboxVolumeStore {
	const store = new Map<VolumeRef, VolumeTree>();
	return {
		load: async (ref) => {
			const tree = store.get(ref);
			return tree !== undefined ? cloneTree(tree) : {};
		},
		save: async (ref, tree) => {
			store.set(ref, cloneTree(tree));
		},
	};
}
