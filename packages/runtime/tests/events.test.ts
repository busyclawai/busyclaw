import type {
	BusyclawPlugin,
	BusyclawPluginConfigureContext,
	Event,
} from "@busyclaw/contracts";
import { buildSecrets } from "@busyclaw/secrets";
import { describe, expect, it } from "vitest";
import {
	pluginEventSink,
	type RuntimeEvent,
	type RuntimeEventSink,
} from "../src/events";

// A recorder standing in for a real runtime sink (durable, in-memory, etc.).
function recordingSink(log?: { order: string[]; label?: string }) {
	const observed: { type: string }[] = [];
	const sink: RuntimeEventSink = {
		emit(event: RuntimeEvent) {
			observed.push(event);
			if (log) log.order.push(`${log.label ?? "sink"}:${event.type}`);
		},
	};
	return { sink, observed };
}

describe("pluginEventSink", () => {
	it("forwards plugin-emitted events to recording and observer sinks, recording first", async () => {
		const order: string[] = [];
		const recording = recordingSink({ order, label: "recording" });
		const observer = recordingSink({ order, label: "observer" });
		const context: BusyclawPluginConfigureContext = {
			events: pluginEventSink({
				recording: recording.sink,
				observers: [observer.sink],
			}),
			secrets: buildSecrets(),
		};

		const plugin = {
			id: "emitter",
			configure(ctx) {
				void ctx.events?.emit({ type: "skill.demo", skillId: "s1" });
				return undefined;
			},
		} satisfies BusyclawPlugin;

		plugin.configure?.(context);
		// emit may be async on the sink side; let microtasks flush.
		await Promise.resolve();

		expect(recording.observed).toEqual([{ type: "skill.demo", skillId: "s1" }]);
		expect(observer.observed).toEqual([{ type: "skill.demo", skillId: "s1" }]);
		expect(order).toEqual(["recording:skill.demo", "observer:skill.demo"]);
	});

	it("a throwing observer does not break the door and is warned", async () => {
		const warnings: string[] = [];
		const recording = recordingSink();
		const after = recordingSink();
		const port = pluginEventSink({
			recording: recording.sink,
			observers: [
				{
					emit() {
						throw new Error("observer exploded");
					},
				},
				after.sink,
			],
			warn: (message: string) => void warnings.push(message),
		});

		await expect(port.emit({ type: "skill.demo" })).resolves.toBeUndefined();
		expect(recording.observed).toEqual([{ type: "skill.demo" }]);
		expect(after.observed).toEqual([{ type: "skill.demo" }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("observer event sink failed");
		expect(warnings[0]).toContain("skill.demo");
		expect(warnings[0]).toContain("observer exploded");
	});

	it("a throwing recording sink propagates through the door", async () => {
		const observer = recordingSink();
		const port = pluginEventSink({
			recording: {
				emit() {
					throw new Error("recording unavailable");
				},
			},
			observers: [observer.sink],
		});

		await expect(port.emit({ type: "skill.demo" })).rejects.toThrow(
			/recording unavailable/,
		);
		expect(observer.observed).toEqual([]);
	});

	it("awaits async sinks for every event", async () => {
		const order: string[] = [];
		const slow: RuntimeEventSink = {
			async emit(event: RuntimeEvent) {
				await Promise.resolve();
				order.push(event.type);
			},
		};
		const port = pluginEventSink({ observers: [slow] });

		await port.emit({ type: "a" });
		await port.emit({ type: "b" });

		expect(order).toEqual(["a", "b"]);
	});

	it("leaves a plugin that never touches events untouched", () => {
		const { sink, observed } = recordingSink();
		const context: BusyclawPluginConfigureContext = {
			events: pluginEventSink({ observers: [sink] }),
			secrets: buildSecrets(),
		};

		const plugin = {
			id: "quiet",
			// Takes the context and ignores it — declaring `configure()` with no parameter made passing
			// one a type error, which is not what "never touches events" is supposed to mean.
			configure(_ctx) {
				return undefined;
			},
		} satisfies BusyclawPlugin;

		expect(() => plugin.configure?.(context)).not.toThrow();
		expect(observed).toEqual([]);
	});

	it("works when no events port is provided (optional)", () => {
		const context: BusyclawPluginConfigureContext = { secrets: buildSecrets() };
		const plugin = {
			id: "optional",
			configure(ctx) {
				void ctx.events?.emit({ type: "skill.demo" });
				return undefined;
			},
		} satisfies BusyclawPlugin;

		expect(() => plugin.configure?.(context)).not.toThrow();
	});
});
