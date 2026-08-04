import { describe, expect, it } from "vitest";
import { parseClawApiInput } from "../src/index";

/**
 * `claw.api.startRun` forwards its input to `ClawEngineHandle.startRun`, whose type grows as the
 * engine grows. So a field added to `EngineStartRunInput` becomes wire-reachable the moment it
 * exists — unless something says otherwise, twice.
 *
 * The two defences are deliberately redundant. The handler ENUMERATES what it forwards, which is the
 * door. The schema REJECTS undeclared keys, which is what survives somebody adding a field to the
 * engine input without reading the handler. Either alone would have let `recording` — the run's authz
 * parent, its redaction container, and the thread its answers land in — be chosen by the caller.
 */
describe("startRun's door", () => {
	it("accepts what it declares", () => {
		expect(parseClawApiInput("startRun", { prompt: "go" })).toMatchObject({
			prompt: "go",
		});
		expect(
			parseClawApiInput("startRun", { prompt: "go", ctx: { team: "acme" } }),
		).toMatchObject({ ctx: { team: "acme" } });
	});

	it("REJECTS a recording, rather than forwarding one it never declared", () => {
		// arktype preserves undeclared keys and `parseClawApiInput` returns its output verbatim, so
		// without the reject this parses clean and the key rides straight through.
		expect(() =>
			parseClawApiInput("startRun", {
				prompt: "go",
				recording: { clawId: "someone-elses-claw", threadId: "t1" },
			}),
		).toThrow(/recording/);
	});

	it("REJECTS a caller-chosen deadline", () => {
		// A caller-chosen `deadlineAt` is a caller-chosen yield — the door mints it from the host's
		// budget or not at all.
		expect(() =>
			parseClawApiInput("startRun", {
				prompt: "go",
				drive: { deadlineAt: "2026-01-01T00:00:00.000Z" },
			}),
		).toThrow(/drive/);
	});

	it("REJECTS an unknown key outright, whatever it is called", () => {
		expect(() =>
			parseClawApiInput("startRun", { prompt: "go", principal: "user:evil" }),
		).toThrow(/principal/);
	});
});
