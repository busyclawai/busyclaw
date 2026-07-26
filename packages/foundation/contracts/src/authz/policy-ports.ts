// The slice-6b store PORTS — the behavioural protocol (verbs) the durable stores satisfy, kept apart
// from the entity/schema declarations (mirrors tools/registry-ports.ts). Types only; the impls live
// in @euroclaw/storage-durable (createRegistryStores).

import type { ScopeRef } from "../scope";
import type { AuthzChangeAppend, AuthzChangeRecord } from "./change-log";
import type { PolicySliceRecord, PolicySliceUpsert } from "./policy-slice";

/** A scope's Cedar policy slices; replace-by-`(scope, scopeId, name)`. */
export type PolicySliceStore = {
	listForScope: (ref: ScopeRef) => Promise<PolicySliceRecord[]>;
	upsert: (input: PolicySliceUpsert) => Promise<PolicySliceRecord>;
	/** Scope-keyed delete: a slice is removed only when the id belongs to `ref`, so a caller in one
	 *  boundary can never delete another boundary's slice by id (defense in depth). No-op when absent. */
	delete: (ref: ScopeRef, id: string) => Promise<void>;
};

/** The append-only authz change log. `count` is the cheap per-decision read the policy router keys on;
 *  `listForScope` is the (deferred-use) read-side history. */
export type AuthzChangeStore = {
	append: (input: AuthzChangeAppend) => Promise<AuthzChangeRecord>;
	count: (ref: ScopeRef) => Promise<number>;
	listForScope: (ref: ScopeRef) => Promise<AuthzChangeRecord[]>;
};
