// The one warn seam: `createClaw({ warn })` is the single operator-notice door — the assembly
// routes redaction and secrets boot warnings through it (observer-sink failures and tool-name
// collisions are proved at their own sites: send/plugin-event-sinks/resolve-tools tests). A
// configured `warn` fully REPLACES the console.warn default — nothing leaks past the seam.
import { memoryAdapter } from "@busyclaw/storage-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaw } from "../src/index";
import { emailDetector, textModel } from "./fixtures";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createClaw warn seam", () => {
	it("the redaction keyless-durable warning arrives through a custom warn, not console", () => {
		const warnings: string[] = [];
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		createClaw({
			database: memoryAdapter(),
			model: textModel("ok"),
			// A durable mapping store without indexKey — the keyless-durable warning fires at boot.
			// (Bare-array shorthand: strict posture over these detectors, no indexKey.)
			redaction: [emailDetector],
			warn: (message: string) => void warnings.push(message),
		});
		expect(
			warnings.some(
				(message) =>
					message.startsWith("busyclaw redaction:") &&
					message.includes("no indexKey"),
			),
		).toBe(true);
		expect(consoleWarn).not.toHaveBeenCalled();
	});

	it("the secrets boot coverage warning arrives through a custom warn, not console", async () => {
		const warnings: string[] = [];
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		createClaw({
			model: textModel("ok"),
			plugins: [
				{
					id: "needs-secret",
					secrets: { expects: [{ name: "BUSYCLAW_TEST_UNRESOLVABLE" }] },
				},
			],
			warn: (message: string) => void warnings.push(message),
		});
		// Boot validation is fire-and-forget — wait for the probe to land.
		await vi.waitFor(() => {
			expect(
				warnings.some(
					(message) =>
						message.startsWith("busyclaw secrets:") &&
						message.includes("BUSYCLAW_TEST_UNRESOLVABLE"),
				),
			).toBe(true);
		});
		expect(consoleWarn).not.toHaveBeenCalled();
	});
});
