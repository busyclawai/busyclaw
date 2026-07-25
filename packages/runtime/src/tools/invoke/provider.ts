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
//   • organizationId/principal come from the per-run CONTEXT passed to the provider (the turn's trusted
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
} from "@euroclaw/contracts";
import {
	configurationError,
	jsonObject,
	jsonValue,
	validationError,
} from "@euroclaw/contracts";
import { jsonSchema } from "ai";
import { type } from "arktype";
import { openApiBinding } from "../sources/openapi";
import { applyCredentials } from "./credentials";
import { assertEgressAllowed, type EgressLookup } from "./egress";
import { planHttpRequest } from "./request-plan";

/** The per-run turn context the provider closes each tool over. NONE of it comes from model args or
 *  the AI-SDK execute options (which carry no turn context) — it is the run's trusted org + principal. */
export type RegisteredToolContext = {
	organizationId: string;
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
	 *  (`secrets.get(source, { organizationId, principal })`). */
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

export function createRegisteredToolProvider(
	options: RegisteredToolProviderOptions,
): RegisteredToolProvider {
	const fetchImpl = options.fetch ?? fetch;
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

				const plan = planHttpRequest(binding, validArgs);
				const credentialed = await applyCredentials(
					plan,
					binding,
					options.secrets,
					{
						organizationId: context.organizationId,
						source: row.source,
						principal: context.principal,
					},
				);
				// The floor resolves + blocks + pins BEFORE the socket opens; a blocked target throws.
				await assertEgressAllowed(credentialed.url, {
					...(options.allowInsecure !== undefined
						? { allowInsecure: options.allowInsecure }
						: {}),
					...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
				});
				return performFetch(credentialed, _callOptions, {
					fetchImpl,
					timeoutMs,
					maxResponseBytes,
				});
			};

			const description = row.description;
			// Keyed by the row's dotted address — the canonical PATH, the id the model is built from.
			tools[row.address] = {
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
};

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

	let response: Response;
	try {
		response = await deps.fetchImpl(plan.url, {
			method: plan.method,
			headers: plan.headers,
			...(plan.body !== undefined ? { body: plan.body } : {}),
			// Never auto-follow redirects: a 3xx to a private host would bypass the egress floor.
			redirect: "manual",
			signal,
		});
	} catch (error) {
		if (timeoutSignal.aborted) {
			throw configurationError("registered tool request timed out", {
				origin: plan.origin,
				timeoutMs: deps.timeoutMs,
			});
		}
		throw error;
	}
	return readResponse(response, deps.maxResponseBytes);
}

/** Read a response body under a byte cap and parse it as DATA (JSON when the content-type says so,
 *  else text). The body is untrusted — it is validated as JSON-safe, never executed. */
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
	for (const [key, value] of response.headers) headers[key] = value;
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
