// The registered-tool provider: turns an organization's `registered_tool` rows into executable
// AuthoredTools whose `execute` is the generic HTTP invoker bound to the row's binding. They join
// the tool set beside code tools and ride the SAME chokepoint (redact → gate → execute → audit).
//
// Two seam invariants:
//   • The binding, the credentials, the resolver, and the turn's org/actor are ALL closure-captured
//     inside `execute` — never object fields on the tool. So `modelFacingTools` (which strips only
//     `euroclaw` + `execute`) cannot leak a binding or a credential to the model.
//   • organizationId/actor come from the per-run CONTEXT passed to the provider (the turn's trusted
//     org + actor), NOT from the AI-SDK execute options — those carry no turn context.
//
// Governance is stamped RAW from the row and re-validated by the runtime's `toolGovernance` reader
// when it is read for execution at dispatch (the §2 invariant: governance blobs are never trusted
// raw). The stored binding is an adapter-read boundary, so it is arktype-parsed inside `execute`
// before it can drive a request. The response is UNTRUSTED data: parsed as data only (never
// executed), size-capped, and time-bounded; a non-2xx status is RETURNED (not thrown) so policy and
// the model can react. Throws are reserved for infra / guard / missing-required-credential.

import type {
	JsonValue,
	RegisteredToolRecord,
	Secrets,
	ToolGovernance,
} from "@euroclaw/contracts";
import {
	configurationError,
	govern,
	jsonObject,
	jsonValue,
	validationError,
} from "@euroclaw/contracts";
import { jsonSchema, type ToolSet } from "ai";
import { type } from "arktype";
import { type OpenApiBinding, openApiBinding } from "../sources/openapi";
import { applyCredentials } from "./credentials";
import { assertEgressAllowed, type EgressLookup } from "./egress";
import { planHttpRequest } from "./request-plan";

/** The per-run turn context the provider closes each tool over. NONE of it comes from model args or
 *  the AI-SDK execute options (which carry no turn context) — it is the run's trusted org + actor. */
export type RegisteredToolContext = {
	organizationId: string;
	actor?: string;
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
	 *  (`secrets.get(source, { organizationId, actor })`). */
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
) => ToolSet;

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
		const tools: ToolSet = {};
		for (const row of rows) {
			// Closure captures: binding source, resolver, org/actor — none become object fields.
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
				const parsedBinding = openApiBinding(row.binding);
				if (parsedBinding instanceof type.errors) {
					throw validationError(
						`registered tool "${row.address}" has an invalid stored binding`,
						parsedBinding.summary,
					);
				}
				const binding = parsedBinding as OpenApiBinding;

				const plan = planHttpRequest(binding, validArgs);
				const credentialed = await applyCredentials(
					plan,
					binding,
					options.secrets,
					{
						organizationId: context.organizationId,
						source: row.source,
						...(context.actor !== undefined ? { actor: context.actor } : {}),
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
			tools[row.address] = govern(
				{
					...(typeof description === "string" && description !== ""
						? { description }
						: {}),
					inputSchema: jsonSchema(
						row.inputSchema as Parameters<typeof jsonSchema>[0],
					),
					execute,
				},
				// Stamp RAW — the runtime's toolGovernance reader validates it at dispatch (never raw).
				row.governance as unknown as ToolGovernance,
			) as ToolSet[string];
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
