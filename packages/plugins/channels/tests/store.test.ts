import { entityAdapter, memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	channelsModels,
	createChannelEndpointStateStore,
	endpointId,
} from "../src/index";

// Stores take the schema-aware adapter the assembly provides; tests wrap manually.
const db = () => entityAdapter(memoryAdapter(), channelsModels);

const now = () => "2026-01-01T00:00:00.000Z";

describe("createChannelEndpointStateStore", () => {
	it("creates the state row on first contact and patches it afterwards", async () => {
		const store = createChannelEndpointStateStore(db(), { now });
		const key = { provider: "telegram", endpointKey: "default" };

		const first = await store.record(
			{ ...key, mode: "webhook" },
			{ kind: "received" },
		);
		expect(first).toMatchObject({
			provider: "telegram",
			endpointKey: "default",
			mode: "webhook",
			lastReceivedAt: now(),
		});
		expect(first.id).toBe(endpointId(key));

		const second = await store.record(
			{ ...key, mode: "webhook" },
			{ kind: "received" },
		);
		// same natural key -> same primary key -> one row, patched in place
		expect(second.id).toBe(first.id);
		await expect(store.get(key)).resolves.toMatchObject({ id: first.id });
	});

	it("advances the poll cursor and records poll errors", async () => {
		const store = createChannelEndpointStateStore(db(), { now });
		const key = {
			provider: "telegram",
			endpointKey: "poller",
			mode: "poll",
		} as const;

		await store.record(key, { kind: "polled", cursor: { offset: 7 } });
		await expect(
			store.get({ provider: "telegram", endpointKey: "poller" }),
		).resolves.toMatchObject({ cursor: { offset: 7 } });

		const errored = await store.record(key, {
			kind: "poll-error",
			error: { message: "provider down" },
		});
		expect(errored.lastError).toEqual({ message: "provider down" });
		expect(errored.cursor).toEqual({ offset: 7 }); // errors never clobber the cursor

		const recovered = await store.record(key, {
			kind: "polled",
			cursor: { offset: 9 },
		});
		// the cleared marker round-trips as JSON null (a json column's null is a value, not absence)
		expect(recovered.lastError).toBeNull();
		expect(recovered.cursor).toEqual({ offset: 9 });
	});
});
