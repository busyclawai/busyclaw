// The tool-registry STORE PORTS — the behavioural protocol (verbs) the durable stores satisfy,
// kept apart from the entity/schema declarations in ./registry. Ports are types only; the impls
// live in @busyclaw/storage-durable (createRegistryStores).

import type { ScopeRef } from "../scope";
import type {
	FactsOverlayRecord,
	FactsOverlayUpsert,
	RegisteredToolCreate,
	RegisteredToolPatch,
	RegisteredToolRecord,
	SpecRegistrationRecord,
	SpecRegistrationUpsert,
} from "./registry";

/** Persists the raw registration per `(scope, scopeId, source)`; re-registration replaces the row. */
export type SpecRegistrationStore = {
	/** Replace-by-`(scope, scopeId, source)`: update the existing row or create a fresh one. */
	upsert: (input: SpecRegistrationUpsert) => Promise<SpecRegistrationRecord>;
	get: (
		ref: ScopeRef,
		source: string,
	) => Promise<SpecRegistrationRecord | null>;
	listForScope: (ref: ScopeRef) => Promise<SpecRegistrationRecord[]>;
};

/** The extracted operation rows; the registration diff creates/updates/deletes by address. */
export type RegisteredToolStore = {
	listBySource: (
		ref: ScopeRef,
		source: string,
	) => Promise<RegisteredToolRecord[]>;
	listForScope: (ref: ScopeRef) => Promise<RegisteredToolRecord[]>;
	create: (input: RegisteredToolCreate) => Promise<RegisteredToolRecord>;
	update: (
		id: string,
		patch: RegisteredToolPatch,
	) => Promise<RegisteredToolRecord | null>;
	deleteById: (id: string) => Promise<void>;
};

/** The customer facts overlay; replace-by-`(scope, scopeId, actionId)`. */
export type FactsOverlayStore = {
	listForScope: (ref: ScopeRef) => Promise<FactsOverlayRecord[]>;
	upsert: (input: FactsOverlayUpsert) => Promise<FactsOverlayRecord>;
	deleteById: (id: string) => Promise<void>;
};
