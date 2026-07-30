// The guest's network is a POLICY the engine applies, not a door the host hands over.
//
// QuickJS has no sockets and no DNS — the guest cannot originate a packet, so every byte leaves
// through a host function. That made the adapter a single chokepoint, which was the good news. The
// bad news was that nothing checked what the chokepoint DID: `fetchAdapter: fetch` was a legal,
// short, obvious thing for a host to write, and it handed the guest 127.0.0.1, 169.254.169.254 and
// the whole private network with no error and no audit trail.
//
// Making the safe path short is worth something. Making the unsafe path unspellable is worth more.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FETCH_TOOL_PATH, fetchTool } from "@busyclaw/egress/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SandboxToolInvoker } from "../src/core/contracts";
import { executeInSandbox } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

/**
 * The invoker a real host provides: the runtime's `subInvoke` resolves `busyclaw.fetch` to the
 * registered tool and runs it through the chokepoint. Here it dispatches straight to the tool,
 * because these tests are about the FLOOR and about the execution owning its sockets — the governed
 * DECISION has its own tests at the assembly level, where a policy engine exists.
 *
 * It forwards the signal, which is the point of half of them: nothing reaches the network except
 * through a tool call now, so a fixture that stubbed the invoker away would be testing a path that
 * no longer exists.
 */
const routeFetch = (
	options: Parameters<typeof fetchTool>[0] = {
		allow: ["https://example.com"],
	},
): SandboxToolInvoker => ({
	invoke: async ({ path, args }, invokeOptions) => {
		if (path !== FETCH_TOOL_PATH) {
			throw new Error(`unexpected nested call: ${path}`);
		}
		const execute = fetchTool(options).invocation.execute as (
			a: unknown,
			o: unknown,
		) => Promise<unknown>;
		return {
			status: "ok",
			output: await execute(args, { abortSignal: invokeOptions?.signal }),
		};
	},
});

const run = (
	code: string,
	context: Parameters<typeof executeInSandbox>[0]["context"],
	invoker: SandboxToolInvoker = routeFetch(),
) => executeInSandbox({ sandbox: quickjs(), code, invoker, context });

// A REAL loopback server, so "blocked" cannot be confused with "nothing was listening". Pointing the
// guest at a dead port proves nothing: the connection fails either way, and the test passes whether
// or not the floor is on the path. This answers 200 to anyone who reaches it.
let server: Server;
let port: number;

beforeAll(async () => {
	server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("reached");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("sandbox network — the floor is not optional", () => {
	it("stays airgapped when no network is declared", async () => {
		const { output } = await run(
			'try { await fetch("https://example.com"); return "reached"; } catch (e) { return "blocked"; }',
			{},
		);
		expect(output.result).toBe("blocked");
	});

	it("refuses loopback that WOULD have answered, because the floor is on the path", async () => {
		// The host declared policy, not a door. It did not — and could not — opt out of the floor. A
		// raw fetch here reaches the server above and returns 200, so this distinguishes the floor
		// refusing from the network simply failing.
		const { output } = await run(
			[
				"try {",
				`  const r = await fetch("http://127.0.0.1:${port}/");`,
				'  return "reached:" + r.status;',
				'} catch (e) { return "blocked"; }',
			].join("\n"),
			// The tool the invoker routes to DECLARES this origin, so the destination check passes it
			// through and the FLOOR is what refuses. Left undeclared this would pass for the wrong
			// reason — a green test naming the floor while never reaching it.
			{ network: true },
			routeFetch({ allow: [`http://127.0.0.1:${port}`], allowInsecure: true }),
		);
		expect(output.result).toBe("blocked");
	});

	it("refuses link-local metadata even with network enabled and http allowed", async () => {
		// Nothing listens on 169.254.169.254 here, so this one cannot distinguish a refusal from a
		// failed connection on its own — it rides on the test above, which can. Kept because it names
		// the address that matters.
		const { output } = await run(
			[
				"try {",
				'  await fetch("http://169.254.169.254/latest/meta-data/");',
				'  return "reached";',
				'} catch (e) { return "blocked"; }',
			].join("\n"),
			// Declared, for the same reason as above: the floor is the thing under test.
			{ network: true },
			routeFetch({ allow: ["http://169.254.169.254"], allowInsecure: true }),
		);
		expect(output.result).toBe("blocked");
	});
});

describe("sandbox network — the execution owns its requests", () => {
	it("aborts a host request the guest abandoned", async () => {
		// A sandbox deadline used to reject the GUEST's promise while the host request it was waiting
		// on ran to completion: the guest saw a timeout, the socket did not. A guest could retire
		// promises faster than the host retired connections, and an abandoned request still spent its
		// full deadline against whatever it was aimed at.
		let observed: AbortSignal | undefined;
		const transport: typeof fetch = (_input, init) => {
			observed = (init as RequestInit | undefined)?.signal ?? undefined;
			// Never resolves on its own — only the abort can end this.
			return new Promise<Response>((_resolve, reject) => {
				observed?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		};

		const { output } = await run(
			'try { await fetch("https://example.com/slow"); return "done"; } catch (e) { return "err"; }',
			{ timeoutMs: 500, network: true },
			// The transport and a fake resolver live on the TOOL now — the floor still range-checks
			// the answer, it just does not need DNS to get one. The signal reaches this transport by
			// travelling engine → invoker → subInvoke → handleToolCall → the tool's execute, which is
			// the whole chain this test exists to hold.
			routeFetch({
				allow: ["https://example.com"],
				transport,
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			}),
		);

		// The guest is finished either way; what matters is the host side.
		expect(output.result === "err" || output.result === null).toBe(true);
		expect(observed).toBeDefined();
		expect(observed?.aborted).toBe(true);
	});
});

describe("sandbox network — the door cannot be smuggled back in", () => {
	it("ignores a `fetchAdapter` that arrives at runtime anyway", async () => {
		// Removing a field from a TYPE removes it from the type and nothing else. The value still
		// arrives — from plain JS, from a widened cast, from an object built dynamically — and the
		// first version of this fix spread the host's context into the provider's, which carried it
		// straight through. A raw adapter reached the guest and answered 200 from loopback.
		let reached = false;
		const { output } = await run(
			'try { const r = await fetch("http://127.0.0.1:1/"); return "reached:" + r.status; } catch (e) { return "blocked"; }',
			{
				fetchAdapter: async () => {
					reached = true;
					return { status: 200 };
				},
			} as never,
		);

		expect(reached).toBe(false);
		expect(output.result).toBe("blocked");
	});
});
