import { describe, expect, it } from "vitest";
import { memorySecondaryStorage } from "../src/index";

describe("memorySecondaryStorage", () => {
	it("stores, reads and deletes", async () => {
		const kv = memorySecondaryStorage();

		expect(await kv.get("a")).toBeNull();
		await kv.set("a", "one");
		expect(await kv.get("a")).toBe("one");
		await kv.delete("a");
		expect(await kv.get("a")).toBeNull();
	});

	it("expires on READ rather than on a timer", async () => {
		let clock = 0;
		const kv = memorySecondaryStorage({ now: () => clock });

		await kv.set("a", "one", 10); // seconds
		clock = 9_000;
		expect(await kv.get("a")).toBe("one");
		clock = 10_000;
		// A timer would keep the process alive AND still have to handle a read landing between the
		// deadline and the sweep — so the check has to exist either way, and once it does the sweep
		// only saves memory a Map of expiring buffers does not need saved.
		expect(await kv.get("a")).toBeNull();
	});

	it("getAndDelete consumes — a second reader gets nothing", async () => {
		const kv = memorySecondaryStorage();
		await kv.set("once", "value");

		expect(await kv.getAndDelete("once")).toBe("value");
		// The whole point: two readers cannot both consume. A get-then-delete pair would let them.
		expect(await kv.getAndDelete("once")).toBeNull();
	});

	it("increment returns the value AFTER the increment, from absent", async () => {
		const kv = memorySecondaryStorage();

		// Absent ⇒ created at 1, which is what makes it usable as a stream offset: the first chunk
		// gets 1, and `Last-Event-ID: 1` means "I have the first one".
		expect(await kv.increment("seq", 60)).toBe(1);
		expect(await kv.increment("seq", 60)).toBe(2);
		expect(await kv.increment("seq", 60)).toBe(3);
	});

	it("increment sets the ttl ONLY when the counter is born", async () => {
		let clock = 0;
		const kv = memorySecondaryStorage({ now: () => clock });

		await kv.increment("seq", 10); // born at t=0, dies at t=10s
		clock = 5_000;
		await kv.increment("seq", 10); // must NOT push the deadline out
		clock = 9_000;
		await kv.increment("seq", 10);
		clock = 10_000;

		// Refreshing on every increment would make a busy counter immortal — the one behaviour the
		// window exists to prevent, and the reason this is not just `set(get() + 1)`.
		expect(await kv.get("seq")).toBeNull();
		expect(await kv.increment("seq", 10)).toBe(1);
	});
});
