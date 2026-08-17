/**
 * THE E2E FACTORY — a real claw, on a real database, driven by real workers.
 *
 * What this exists to test is COMPOSITION. Every piece below is already covered on its own: the
 * adapters have a conformance suite, the engine has 43 cases, the floor is exercised against a
 * hand-built Cedar engine, the redaction seams each have their own test. What nothing covers is the
 * seam between them — a message arriving, becoming a run, being claimed by one of several workers,
 * parking on an approval, resuming, and landing in rows somebody later has to erase.
 *
 * The other reason it is a package rather than a folder: `storage-core` cannot devDepend on
 * `storage-kysely` (turbo's `^build` would cycle), so no existing package can reach more than one
 * backend at a time. A LEAF nobody depends on can reach them all, which is what makes "the same
 * scenario, on every backend" expressible at all.
 *
 * TWO KNOBS THAT MATTER, and they are the reason this is a factory:
 *   - `database` — the memory adapter is not a database. Twenty-one of busyclaw's own test files
 *     stand on it, so a scenario that only ever runs there is proving something about a JS predicate
 *     evaluator, not about a deployment.
 *   - `workers` — one worker is a queue with the concurrency turned off. The lease, the claim CAS
 *     and the reaper only mean anything when something else is trying to take the work.
 */

import type {
	Adapter,
	BusyclawPlugin,
	Detector,
	SchemaDeclaration,
	ToolDefinition,
} from "@busyclaw/contracts";
import {
	createSqlEngineStore,
	type SqlEngineHandle,
	sqlEngine,
} from "@busyclaw/engine-sql";
import type { RuntimeModel } from "@busyclaw/runtime";
import {
	memoryAdapter,
	memorySecondaryStorage,
	secondaryStorageStream,
} from "@busyclaw/storage-core";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { type Claw, createClaw } from "busyclaw";
import { Kysely, SqliteDialect } from "kysely";

/** Which store the whole stack sits on for this run of the scenario. */
export type Backend = "memory" | "sqlite";

export type WorldOptions = {
	/** Default "sqlite" — the one that is actually a database. */
	database?: Backend;
	/** How many workers compete for the queue. Default 1. */
	workers?: number;
	model: RuntimeModel;
	tools?: Record<string, ToolDefinition>;
	/** Tokenize PII with this detector. Omit for a claw that stores raw. */
	detector?: Detector;
	/** Dedup key for placeholders. Without it the redactor mints one per occurrence — which is
	 *  documented behaviour, and never what a scenario means. */
	indexKey?: string;
	/** The caller every `api` call runs as. Default "user:actor-1". */
	principal?: string;
	/** Plugins to assemble into the claw — policy slices, tools, event sinks. */
	plugins?: readonly BusyclawPlugin[];
};

export type World = {
	claw: Claw;
	/** The claw's api, already bound to `principal`. */
	api: Claw["api"];
	db: Adapter;
	/** One tick on every worker, concurrently — the shape a real host's cron produces. */
	drain: () => Promise<void>;
	/** Tick until nothing is left to claim (or `max` rounds), for a scenario that just wants the
	 *  queue empty before it asserts. */
	settle: (max?: number, budgetMs?: number) => Promise<void>;
	/** Every row of a table — the "look everywhere" primitive erasure assertions need. */
	rows: (model: string) => Promise<Record<string, unknown>[]>;
	/** Every table this claw declares. */
	tables: () => string[];
	/** Which tables contain `needle`, out of ALL of them. */
	tablesHolding: (needle: string) => Promise<string[]>;
	close: () => void;
};

/**
 * Bind a fixed caller onto every governed `claw.api` call, flat and nested.
 *
 * The app-authz PEP takes the caller at arg index 1 as `{ principal }`, and refuses outright without
 * one — so a scenario would otherwise repeat it at every single call. Nested namespaces are wrapped
 * too, because plugins hang their api under `claw.api.<plugin>` and those calls are governed by the
 * same floor.
 */
function withPrincipal<T extends object>(target: T, principal: string): T {
	return new Proxy(target, {
		get(obj, prop, receiver) {
			const value = Reflect.get(obj, prop, receiver);
			if (typeof value === "function") {
				// THE ONE UNAVOIDABLE ASSERTION IN THIS FILE. `typeof value === "function"` narrows
				// `unknown` to `Function`, which TypeScript will not let you call with arguments — a
				// reflective proxy knows less about its target than the type system needs. Every other
				// cast here turned out to be removable; this one is the price of intercepting a call
				// generically.
				return (...args: unknown[]) =>
					(value as (...a: unknown[]) => unknown).call(
						obj,
						args[0],
						args[1] ?? { principal },
					);
			}
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value)
			) {
				return withPrincipal(value, principal);
			}
			return value;
		},
	});
}

export async function world(options: WorldOptions): Promise<World> {
	const backend: Backend = options.database ?? "sqlite";
	const closers: (() => void)[] = [];

	let db: Adapter;
	let migrate: ((tables: SchemaDeclaration) => Promise<void>) | undefined;
	if (backend === "memory") {
		db = memoryAdapter();
	} else {
		const sqlite = new Database(":memory:");
		closers.push(() => sqlite.close());
		const kdb = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		db = kyselyAdapter(kdb);
		migrate = async (tables) => {
			const plan = await planMigrations({
				db: kdb,
				schema: tables,
				dialect: "sqlite",
				warn: () => undefined,
			});
			await plan.runMigrations();
		};
	}

	const store = createSqlEngineStore(db);
	const runStream = secondaryStorageStream(memorySecondaryStorage());

	// A database-backed claw must SAY what it does with PII — `createClaw` refuses to boot otherwise,
	// which is the right call and worth stating here: a scenario with no detector is declaring that it
	// stores raw, not quietly getting away without deciding.
	//
	// THE BUILT-IN FORM, not the `redactor` escape hatch. Handing over a pre-built redactor makes the
	// claw a consumer of somebody else's mapping store, and `forgetSubject` then refuses — per-subject
	// erasure needs the store the claw OWNS. Configuring detectors is also what a deployment actually
	// writes, so a scenario using it exercises the assembly rather than going around it.
	const redaction =
		options.detector === undefined
			? { posture: "raw" as const }
			: {
					detectors: [options.detector],
					// Without this the redactor has no hash to look a value up by and mints a fresh
					// placeholder per occurrence. A scenario asserting coreference would then be
					// measuring its own setup.
					...(options.indexKey !== undefined
						? { indexKey: options.indexKey }
						: {}),
				};

	/**
	 * ONE HOST — a claw with its own engine identity over the shared database.
	 *
	 * A worker is not a bare `createSqlEngineWorker`, and the difference is not cosmetic. That worker
	 * needs a Runtime, and a hand-built one has no effect store, no governance and no redaction — so
	 * it happily runs a tool that declared `idempotency: "required"`, with none of the protection the
	 * declaration was asking for. Scenarios driven by it would pass while proving nothing.
	 *
	 * The claw builds the governed runtime itself and hands it to `engine.create(runtime)`. So a
	 * second host is a second CLAW over the same adapter — which is exactly what it is in production:
	 * another process, its own assembly, the same database. Capturing the instance on the way past is
	 * the only way to reach `work()`, since the handle is constructed inside `createClaw`.
	 */
	const host = (workerId: string) => {
		// `cron: false` because a scenario ticks its hosts itself — an engine running its own timer
		// makes the interleaving unrepeatable, which is the one thing a scenario cannot afford.
		const factory = sqlEngine({ store, workerId, cron: false, runStream });
		let engine: SqlEngineHandle | undefined;
		const claw = createClaw({
			cronHandler: false,
			database: db,
			engine: {
				...factory,
				create: (runtime, services) => {
					const instance = factory.create(runtime, services);
					engine = instance.engine;
					return instance;
				},
			},
			runStream,
			model: options.model,
			...(options.tools !== undefined ? { tools: options.tools } : {}),
			...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
			redaction,
		});
		return { claw, work: async () => void (await engine?.work()) };
	};

	const count = Math.max(1, options.workers ?? 1);
	const hosts = Array.from({ length: count }, (_, i) => host(`w${i}`));
	const [primary] = hosts;
	if (primary === undefined) throw new Error("e2e: no host was built");
	const built = primary.claw;

	if (migrate) await migrate(built.$tables);

	const principal = options.principal ?? "user:actor-1";
	const api = withPrincipal(built.api, principal);

	// Every host ticks together, which is the shape a real deployment's cron produces: several
	// instances waking on their own schedules and racing for whatever is due.
	const drain = async (): Promise<void> => {
		await Promise.all(hosts.map((each) => each.work()));
	};

	const rows = async (model: string): Promise<Record<string, unknown>[]> => {
		try {
			// The Adapter port returns `unknown` DELIBERATELY — "an adapter hands back whatever the
			// database holds, and the port does not pretend otherwise", with row typing living one
			// layer up in the entity layer. A scenario inspecting raw rows is below that layer on
			// purpose (it wants to see what is actually stored, not a parsed view), so this is where
			// the shape gets asserted, once, instead of at every assertion site.
			return (await db.findMany({ model, where: [] })) as Record<
				string,
				unknown
			>[];
		} catch {
			// A model this backend never created is not a hiding place.
			return [];
		}
	};

	const tables = (): string[] => Object.keys(built.$tables);

	return {
		claw: built,
		api,
		db,
		drain,
		/**
		 * Tick until the queue is empty, WAITING OUT A RETRY BACKOFF when one is in the way.
		 *
		 * A failed task is rescheduled with `dueAt` pushed into the future — a second by default — and
		 * a claim walks straight past it until then. A settle that only spun would therefore report a
		 * quiet queue while a retry was still coming, and every crash scenario would assert against the
		 * state BEFORE the recovery it exists to test.
		 *
		 * So: drain, and if what remains is merely not due yet, sleep until it is. Bounded by
		 * `budgetMs` so a genuinely stuck queue fails the test rather than hanging it.
		 */
		async settle(max = 20, budgetMs = 10_000) {
			const deadline = Date.now() + budgetMs;
			for (let i = 0; i < max; i++) {
				await drain();
				// Through `rows`, so the one place that asserts a row shape stays the one place.
				const pending = (await rows("runtime_task")).filter(
					(task) => task.status === "pending",
				);
				if (pending.length === 0) return;
				const dueAts = pending
					.map((task) => Date.parse(String(task.dueAt)))
					.filter((at) => Number.isFinite(at));
				const soonest = dueAts.length > 0 ? Math.min(...dueAts) : Date.now();
				const wait = soonest - Date.now();
				if (wait <= 0) continue;
				if (Date.now() + wait > deadline) return;
				await new Promise((resolve) => setTimeout(resolve, wait + 25));
			}
		},
		rows,
		tables,
		async tablesHolding(needle: string) {
			const hits = await Promise.all(
				tables().map(async (model) => {
					const found = await rows(model);
					return found.length > 0 && JSON.stringify(found).includes(needle)
						? model
						: null;
				}),
			);
			return hits.filter((model): model is string => model !== null).sort();
		},
		close() {
			for (const shut of closers.splice(0)) shut();
		},
	};
}
