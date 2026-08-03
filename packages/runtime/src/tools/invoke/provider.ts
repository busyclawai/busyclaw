// The registered-tool provider: turns an organization's `registered_tool` rows into `binding`
// descriptors whose executor is the generic HTTP invoker bound to the row's binding. They join the
// tool set beside code tools and ride the SAME chokepoint (redact → gate → execute → audit) under
// the SAME addressing: the row's dotted `address` IS the descriptor's path, so the Cedar action,
// the catalog address and the audit name all agree, and the model is offered the flattened
// projection of it exactly like a plugin tool's.
//
// The invocation tag is load-bearing here: these are the tools that exist as DATA. The declarative
// binding rides in the descriptor (the egress floor and `serverForAction` read the same field the
// row stores), while the credentials, the resolver, and the turn's org/principal stay
// closure-captured inside the executor — never descriptor fields. `modelToolProjection` is an
// allowlist projection, so neither the binding nor anything else can reach the model regardless.
//
//   • the config-scope pair and principal come from the per-run CONTEXT passed to the provider (the turn's trusted
//     org + principal), NOT from the AI-SDK execute options — those carry no turn context.
//
// Governance rides through typed: the registry column is schema-first (`field.json(toolGovernance)`),
// so the store validates it on read and `row.governance` is a `ToolGovernance` here — no cast, and
// no second re-validation downstream now that the descriptor keeps it in the type. The stored
// binding is an adapter-read boundary, so it is arktype-parsed inside the executor
// before it can drive a request. The response is UNTRUSTED data: parsed as data only (never
// executed), size-capped, and time-bounded; a non-2xx status is RETURNED (not thrown) so policy and
// the model can react. Throws are reserved for infra / guard / missing-required-credential.

import type {
	JsonValue,
	RegisteredToolRecord,
	Secrets,
	ToolDefinitionSet,
} from "@busyclaw/contracts";
import {
	configurationError,
	errorMessage,
	jsonObject,
	jsonValue,
	validationError,
} from "@busyclaw/contracts";
import { jsonSchema } from "ai";
import { type } from "arktype";
import { assertApprovedOrigin } from "../credential-binding";
import { openApiBinding } from "../sources/openapi";
import { applyCredentials } from "./credentials";
import {
	assertEgressAllowed,
	type EgressDecision,
	type EgressLookup,
	pinnedConnection,
	pinnedFetch,
} from "./egress";
import { planHttpRequest } from "./request-plan";

/** The per-run turn context the provider closes each tool over. NONE of it comes from model args or
 *  the AI-SDK execute options (which carry no turn context) — it is the run's trusted org + principal. */
export type RegisteredToolContext = {
	scope: string;
	scopeId: string;
	principal?: string;
};

/** The response the invoker returns to the model — untrusted data. A non-2xx status arrives here,
 *  never as a throw. */
export type InvokerResponse = {
	status: number;
	headers: Record<string, string>;
	body: JsonValue;
};

export type RegisteredToolProviderOptions = {
	/** The one-door reader the invoker resolves each registration's credential through
	 *  (`secrets.get(source, { scope, scopeId, principal })`). */
	secrets: Secrets;
	/** Injected for tests; defaults to the platform global `fetch`. */
	fetch?: typeof fetch;
	/** Response body byte cap (untrusted data flowing back to the model). Default 1 MB. */
	maxResponseBytes?: number;
	/** Per-request deadline. Default 30 s. */
	timeoutMs?: number;
	/** Allow http targets (localhost dev / tests). Default false — https only. */
	allowInsecure?: boolean;
	/** DNS override for the egress floor (tests inject a fake; hosts can pin). */
	lookup?: EgressLookup;
};

export type RegisteredToolProvider = (
	rows: readonly RegisteredToolRecord[],
	context: RegisteredToolContext,
) => ToolDefinitionSet;

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Refuse an argument the tool never declared.
 *
 * The row's `inputSchema` is the flattened parameters-plus-body shape the extractor derived, and it is
 * the SAME shape the policy projection filters against — so checking against it here is what makes
 * "policy and wire consume the identical object" true rather than hopeful.
 *
 * Shallow on purpose: this closes the gap the finding names (undeclared TOP-LEVEL fields reaching the
 * body unauthorized). Deep per-property type checking against the JSON Schema is a further step and a
 * dependency decision — arktype does not consume bare JSON Schema — so it is not smuggled in here.
 */
function assertDeclaredArgs(
	address: string,
	inputSchema: unknown,
	args: Record<string, unknown>,
): void {
	const properties =
		inputSchema !== null &&
		typeof inputSchema === "object" &&
		"properties" in inputSchema
			? (inputSchema as { properties?: unknown }).properties
			: undefined;
	// A schema declaring no properties says nothing about what is allowed, and inventing a
	// closed-world reading of it would refuse every call to a tool whose spec simply omitted them.
	if (properties === null || typeof properties !== "object") return;
	const declared = new Set(Object.keys(properties));
	const undeclared = Object.keys(args).filter((key) => !declared.has(key));
	if (undeclared.length === 0) return;
	throw validationError(
		`registered tool "${address}" received undeclared arguments`,
		`not in this tool's input schema: ${undeclared.join(", ")}`,
	);
}

export function createRegisteredToolProvider(
	options: RegisteredToolProviderOptions,
): RegisteredToolProvider {
	// The DEFAULT must be the fetch that matches `pinnedConnection`'s dispatcher — the global one is
	// backed by whatever undici Node bundles, and handing it this package's Agent fails before the
	// request leaves. A host-supplied fetch owns this half of the floor and may ignore the pin.
	const fetchImpl = options.fetch ?? pinnedFetch;
	const maxResponseBytes =
		options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return (rows, context) => {
		const tools: ToolDefinitionSet = {};
		for (const row of rows) {
			// Closure captures: credentials resolver, org/principal — none become descriptor fields.
			const execute = async (
				args: unknown,
				_callOptions: unknown,
			): Promise<InvokerResponse> => {
				const validArgs = jsonObject(args);
				if (validArgs instanceof type.errors) {
					throw validationError(
						`registered tool "${row.address}" received non-object args`,
						validArgs.summary,
					);
				}
				// The parse result IS OpenApiBinding — the type derives from this schema, no cast.
				const binding = openApiBinding(row.binding);
				if (binding instanceof type.errors) {
					throw validationError(
						`registered tool "${row.address}" has an invalid stored binding`,
						binding.summary,
					);
				}

				// R-M01. The args were checked only for being an OBJECT, so any field the model invented
				// travelled straight into the request body — while the POLICY saw a projection filtered
				// to the tool's declared fields. Two different objects: Cedar decided about one, the
				// wire carried the other, and the difference was exactly the part nobody authorized.
				//
				// Refused rather than dropped. Silently discarding an undeclared field would make the
				// two agree by throwing away what the model asked for, which is a different call than
				// the one it made — and a model cannot correct a mistake it is never told about.
				assertDeclaredArgs(row.address, row.inputSchema, validArgs);
				const plan = planHttpRequest(binding, validArgs);
				// DESTINATION FIRST, then the credential. Both checks below used to run after the secret
				// was already on the plan, which got the order exactly backwards: the thing being
				// protected was resolved and placed before anything asked where it was going.
				//
				// The row's pinned origin is the approval; the plan's origin is what the stored binding
				// says today. They agree unless the binding moved without going through registration —
				// and the credential is the one thing that must not follow it there.
				assertApprovedOrigin(plan.url, row, options.allowInsecure);
				// The floor resolves + blocks + pins BEFORE the socket opens; a blocked target throws.
				// Credential placement never changes the origin (an apiKey query param is appended to a
				// URL already vetted here), so nothing downstream can move the destination.
				const decision = await assertEgressAllowed(plan.url, {
					...(options.allowInsecure !== undefined
						? { allowInsecure: options.allowInsecure }
						: {}),
					...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
				});
				// The ledger's id for this effect, sent as `Idempotency-Key` when the tool's own governance
				// says a duplicate matters. That header is the de-facto convention (Stripe, Square,
				// PayPal, and an IETF draft), and a provider that does not speak it ignores an unknown
				// header — so the cost of sending it is nothing and the cost of NOT sending it is a
				// double charge on any retried attempt. Only when governance asks: an `idempotency:
				// "none"` tool has said duplicates are fine, and we do not editorialize.
				const effectId = effectIdOf(_callOptions);
				if (
					effectId !== undefined &&
					row.governance.effect?.idempotency !== undefined &&
					row.governance.effect.idempotency !== "none" &&
					plan.headers["idempotency-key"] === undefined
				) {
					plan.headers["idempotency-key"] = effectId;
				}
				const credentialed = await applyCredentials(
					plan,
					binding,
					options.secrets,
					{
						scope: context.scope,
						scopeId: context.scopeId,
						source: row.source,
						principal: context.principal,
					},
				);
				// CONSUME the decision: dial the vetted address, not the name again. A host that injects
				// its own `fetch` owns this half of the floor — the dispatcher only reaches the built-in
				// one — so the pin is passed and a custom impl is free to ignore it.
				return performFetch(credentialed, _callOptions, {
					fetchImpl,
					timeoutMs,
					maxResponseBytes,
					decision,
				});
			};

			const description = row.description;
			// Keyed by the row's dotted address — the canonical PATH, the id the model is built from.
			tools[row.address] = {
				// What this descriptor was built from — the approval binding reads it, so a spec
				// re-registered under a pending approval is caught rather than silently resumed onto.
				contentVersion: row.contentVersion,
				...(typeof description === "string" && description !== ""
					? { description }
					: {}),
				// Registered tools are merged into the run's toolset and offered like code tools —
				// `discoverable` is for sets nobody hand-curated, which is a later slice.
				presence: "always",
				inputSchema: jsonSchema(
					row.inputSchema as Parameters<typeof jsonSchema>[0],
				),
				// `row.governance` is typed `ToolGovernance`: the registry column is schema-first and
				// the store validates it on read, so this is the boundary — nothing re-validates it
				// downstream, because the descriptor carries it in the type from here on.
				governance: row.governance,
				invocation: {
					kind: "binding",
					provider: "openapi",
					binding: row.binding,
					execute,
				},
			};
		}
		return tools;
	};
}

type FetchDeps = {
	fetchImpl: typeof fetch;
	timeoutMs: number;
	maxResponseBytes: number;
	/** The floor's vetted resolution — the socket is pinned to it so the name is not resolved twice. */
	decision: EgressDecision;
};

/** The runtime hands the effect id through the call options; a plain read with no cast escaping. */
function effectIdOf(callOptions: unknown): string | undefined {
	if (callOptions === null || typeof callOptions !== "object") return undefined;
	const value = (callOptions as { effectId?: unknown }).effectId;
	return typeof value === "string" && value !== "" ? value : undefined;
}

async function performFetch(
	plan: ReturnType<typeof planHttpRequest>,
	callOptions: unknown,
	deps: FetchDeps,
): Promise<InvokerResponse> {
	const timeoutSignal = AbortSignal.timeout(deps.timeoutMs);
	const incoming = abortSignalOf(callOptions);
	const signal = incoming
		? AbortSignal.any([timeoutSignal, incoming])
		: timeoutSignal;

	// Valid only for THIS decision, so it is built and closed per request.
	const pin = pinnedConnection(deps.decision);
	let response: Response;
	try {
		response = await deps.fetchImpl(plan.url, {
			method: plan.method,
			headers: plan.headers,
			...(plan.body !== undefined ? { body: plan.body } : {}),
			// Never auto-follow redirects: a 3xx to a private host would bypass the egress floor.
			redirect: "manual",
			signal,
			// Non-standard RequestInit field the built-in (undici-backed) fetch reads: the connection
			// strategy. Carries the pin — without it the socket re-resolves the hostname and the floor's
			// verdict describes an address the request never dialled.
			dispatcher: pin.dispatcher,
		} as RequestInit);
	} catch (error) {
		await pin.close().catch(() => undefined);
		if (timeoutSignal.aborted) {
			throw configurationError("registered tool request timed out", {
				origin: plan.origin,
				timeoutMs: deps.timeoutMs,
			});
		}
		// L-03. By this point the URL may CARRY A CREDENTIAL: an `apiKey`/`in: query` scheme appends
		// it as a query parameter, so `plan.url` is secret-bearing from `applyCredentials` onward. A
		// transport error frequently quotes the URL it failed on, and rethrowing it verbatim put that
		// key into whatever read the error — a log line, an operator notice, a tool result.
		//
		// The origin and method are what a caller needs to act; the query string is the part that is
		// never theirs. Reported rather than swallowed, with the cause's own text left behind because
		// it is the thing that quotes the URL.
		throw configurationError("registered tool request failed", {
			origin: plan.origin,
			method: plan.method,
			cause: sanitizeTransportMessage(errorMessage(error)),
		});
	}
	try {
		return await readResponse(response, deps.maxResponseBytes);
	} finally {
		// The body is fully read (or the read threw) — the pooled socket has no further use.
		await pin.close().catch(() => undefined);
	}
}

/** Read a response body under a byte cap and parse it as DATA (JSON when the content-type says so,
 *  else text). The body is untrusted — it is validated as JSON-safe, never executed. */
/**
 * L-06. Every Fetch-exposed response header was copied into the model's view of the result. That is
 * a disclosure channel pointing the wrong way: `set-cookie` carries the upstream's session, a
 * `location` on a 3xx (which is never followed, so it always reaches here) can be a pre-signed URL
 * bearing its own credential, and `www-authenticate` describes how to get one. None of it is
 * anything the model was authorized to see; it arrived because nobody chose.
 *
 * An allowlist rather than a denylist, for the usual reason: the set of headers an upstream might
 * invent is open, and the set a model can act on is small. What is here is what a tool result is
 * actually read for — the shape of the payload, whether it was truncated, and how to pace retries.
 */
const MODEL_VISIBLE_HEADERS = [
	"content-type",
	"content-length",
	"content-language",
	"etag",
	"last-modified",
	"retry-after",
	"x-ratelimit-limit",
	"x-ratelimit-remaining",
	"x-ratelimit-reset",
] as const;

/**
 * Strip anything that looks like a URL query from a transport error's text. A driver quotes the URL
 * it failed on, and by then the URL can carry an `in: query` credential — so the message is kept for
 * its diagnosis and cut at the `?`.
 */
function sanitizeTransportMessage(message: string): string {
	return message.replace(/(https?:\/\/[^\s"']+)\?[^\s"']*/gi, "$1?<redacted>");
}

async function readResponse(
	response: Response,
	maxResponseBytes: number,
): Promise<InvokerResponse> {
	const text = await readCapped(response, maxResponseBytes);
	const contentType = response.headers.get("content-type") ?? "";
	let parsed: JsonValue = text;
	if (/\bjson\b/i.test(contentType)) {
		try {
			parsed = JSON.parse(text) as JsonValue;
		} catch {
			parsed = text; // malformed JSON is returned verbatim as data, never thrown on
		}
	}
	const safe = jsonValue(parsed);
	const body = safe instanceof type.errors ? text : safe;

	const headers: Record<string, string> = {};
	for (const key of MODEL_VISIBLE_HEADERS) {
		const value = response.headers.get(key);
		if (value !== null) headers[key] = value;
	}
	return { status: response.status, headers, body };
}

async function readCapped(
	response: Response,
	maxResponseBytes: number,
): Promise<string> {
	const stream = response.body;
	if (!stream) return response.text();
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxResponseBytes) {
			await reader.cancel();
			throw configurationError(
				"registered tool response exceeded the size cap",
				{ maxResponseBytes },
			);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

function abortSignalOf(callOptions: unknown): AbortSignal | undefined {
	if (
		callOptions &&
		typeof callOptions === "object" &&
		"abortSignal" in callOptions
	) {
		const signal = (callOptions as { abortSignal?: unknown }).abortSignal;
		if (signal instanceof AbortSignal) return signal;
	}
	return undefined;
}
