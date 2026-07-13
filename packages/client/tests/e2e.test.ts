// REAL end-to-end: a createClaw-assembled claw behind adapter-core's toRequestHandler, the client
// pointed at it through an injected fetch that invokes the handler directly — the full wire
// (route derivation → ?input=/body conventions → boundary validation → envelope) with zero
// network. `typeof claw` is the only thing that crosses to the client's type side.

import { toRequestHandler } from "@euroclaw/adapter-core";
import { secrets } from "@euroclaw/secrets-plugin";
import { memoryAdapter } from "@euroclaw/storage-core";
import type { Claw } from "euroclaw";
import { createClaw } from "euroclaw";
import { describe, expect, it } from "vitest";
import { createClawClient } from "../src/index";
import { secretsClient } from "../src/plugins/index";

// 32 bytes hex — the shape the secrets() store master key demands.
const SECRET_STORE_TEST_KEY = "0123456789abcdef".repeat(4);

// The scripted-model shape the runtime accepts (adapter-core test pattern); never invoked here.
const model = {
	specificationVersion: "v4",
	provider: "mock",
	modelId: "mock",
	supportedUrls: {},
	doGenerate: async () => ({
		content: [{ type: "text", text: "done" }],
		finishReason: { unified: "stop", raw: undefined },
		usage: {
			inputTokens: {
				total: 1,
				noCache: undefined,
				cacheRead: undefined,
				cacheWrite: undefined,
			},
			outputTokens: { total: 1, text: undefined, reasoning: undefined },
		},
		warnings: [],
	}),
	doStream: async () => {
		throw new Error("stream not used");
	},
};

function buildClawAndClient() {
	const claw = createClaw({
		database: memoryAdapter(),
		model: model as never,
		plugins: [secrets([], { store: { key: SECRET_STORE_TEST_KEY } })],
		redaction: { posture: "raw" },
	});
	const handler = toRequestHandler(claw as unknown as Claw);
	const client = createClawClient<typeof claw>({
		baseUrl: "https://app.test/api/euroclaw",
		fetch: (input, init) => handler(new Request(input, init)),
		plugins: [secretsClient()],
	});
	return { claw, client };
}

describe("end-to-end: createClaw + toRequestHandler + createClawClient", () => {
	it("round-trips the secrets namespace: set → list → delete, typed from `typeof claw`", async () => {
		const { claw, client } = buildClawAndClient();

		const set = await client.secrets.set({
			name: "NOTION",
			principal: "user:alice",
			value: "tok-1",
		});
		expect(set.error).toBeNull();
		expect(set.data).toMatchObject({
			createdBy: "user:alice",
			kind: "value",
			name: "NOTION",
		});
		// Values are write-only: the routed surface returns the metadata VIEW, never the material.
		expect(
			(set.data as unknown as Record<string, unknown>).value,
		).toBeUndefined();

		// list rides GET + ?input= end to end.
		const listed = await client.secrets.list({ principal: "user:alice" });
		expect(listed.error).toBeNull();
		expect(listed.data).toMatchObject([{ name: "NOTION" }]);

		// The same assembled claw's in-process surface saw the HTTP write — one namespace, two doors.
		await expect(
			claw.api.secrets.list({ principal: "user:alice" }),
		).resolves.toMatchObject([{ name: "NOTION" }]);

		const removed = await client.secrets.delete({
			name: "NOTION",
			principal: "user:alice",
		});
		expect(removed.error).toBeNull();
		const after = await client.secrets.list({ principal: "user:alice" });
		expect(after.data).toEqual([]);
	});

	it("surfaces a boundary validation failure as { error } with the server's code", async () => {
		const { client } = buildClawAndClient();

		const result = await client.secrets.set({
			name: "K",
			principal: "",
			value: "v",
		});

		expect(result.data).toBeNull();
		expect(result.error?.status).toBe(400);
		expect(result.error?.code).toBe("EUROCLAW_VALIDATION_FAILED");
		expect(result.error?.message).toContain("claw.api.secrets.set input");
	});

	it("serves base api reads over the same handler (GET + ?input=)", async () => {
		const { client } = buildClawAndClient();

		const approvals = await client.listApprovals({});
		expect(approvals.error).toBeNull();
		expect(approvals.data).toEqual([]);

		const missing = await client.getClaw({ id: "nope" });
		expect(missing.error).toBeNull();
		expect(missing.data).toBeNull();
	});
});
