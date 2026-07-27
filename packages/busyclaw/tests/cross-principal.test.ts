// Cross-principal isolation, proven per RESOLVER KIND against a real assembled claw.
//
// This is the test the whole authz refactor exists to pass, and it is deliberately behavioural rather
// than structural. The type gate proves every method DECLARES what it authorizes against; the boot walk
// proves none is missing. Neither can prove the declaration is CORRECT — nothing checks that `getMessage`
// resolves the message rather than something else convenient, and a resolver pointed at the wrong field
// still compiles. So each kind gets exercised end to end: Alice creates, Bob knows the id, Bob is refused.
//
// Bob KNOWING THE ID is the point. Random ids are not an authorization boundary — a resource id leaks
// through a URL, a log, a screenshot, a shared transcript. Every case below hands Bob the real id and
// asserts the answer is still no.

import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, textModel } from "./fixtures";

const ALICE = { principal: "user:alice" } as const;
const BOB = { principal: "user:bob" } as const;

const DENIED = /BUSYCLAW_AUTHORIZATION_DENIED/;

function makeClaw() {
	const { db, redactor } = durableRedactor();
	return createClaw({
		database: db,
		model: textModel("done"),
		redaction: { redactor },
	});
}

/** Alice's claw + thread + one message — the transcript every descendant kind hangs off. */
async function alicesTranscript() {
	const claw = makeClaw();
	const owned = await claw.api.createClaw({ name: "alice's claw" }, ALICE);
	const thread = await claw.api.createThread({ clawId: owned.id }, ALICE);
	const message = await claw.api.appendMessage(
		{
			clawId: owned.id,
			threadId: thread.id,
			role: "user",
			content: "hello",
		},
		ALICE,
	);
	return { claw, owned, thread, message };
}

describe("cross-principal isolation — Bob knows the id and is still refused", () => {
	it("claw: Bob cannot read, mutate, or archive Alice's claw", async () => {
		const { claw, owned } = await alicesTranscript();

		await expect(claw.api.getClaw({ id: owned.id }, BOB)).rejects.toThrow(
			DENIED,
		);
		await expect(
			claw.api.updateClaw({ id: owned.id, patch: { name: "bob's now" } }, BOB),
		).rejects.toThrow(DENIED);
		await expect(claw.api.archiveClaw({ id: owned.id }, BOB)).rejects.toThrow(
			DENIED,
		);
		// And Alice still can — a gate that denies everyone is not isolation, it is an outage.
		expect((await claw.api.getClaw({ id: owned.id }, ALICE))?.id).toBe(
			owned.id,
		);
	});

	it("thread: Bob cannot read or list into Alice's claw", async () => {
		const { claw, owned, thread } = await alicesTranscript();

		await expect(claw.api.getThread({ id: thread.id }, BOB)).rejects.toThrow(
			DENIED,
		);
		await expect(
			claw.api.listThreads({ clawId: owned.id }, BOB),
		).rejects.toThrow(DENIED);
		await expect(
			claw.api.listMessages({ threadId: thread.id }, BOB),
		).rejects.toThrow(DENIED);
		expect(
			await claw.api.listThreads({ clawId: owned.id }, ALICE),
		).toHaveLength(1);
	});

	it("message: Bob cannot read Alice's message by id", async () => {
		const { claw, message } = await alicesTranscript();

		// The message row carries `clawId`, so the resolver reaches Alice's claw. This is the case that
		// silently permitted before: `getMessage` had no binding, so the PEP built a resource owned by
		// whoever asked and the owner rule agreed with itself.
		await expect(claw.api.getMessage({ id: message.id }, BOB)).rejects.toThrow(
			DENIED,
		);
		expect((await claw.api.getMessage({ id: message.id }, ALICE))?.id).toBe(
			message.id,
		);
	});

	it("message: Bob cannot append into Alice's thread", async () => {
		const { claw, owned, thread } = await alicesTranscript();

		await expect(
			claw.api.appendMessage(
				{
					clawId: owned.id,
					threadId: thread.id,
					role: "user",
					content: "smuggled",
				},
				BOB,
			),
		).rejects.toThrow(DENIED);
	});

	it("toolCall + toolResult: Bob cannot read Alice's tool traffic by id or by run", async () => {
		const { claw, owned, thread } = await alicesTranscript();
		const call = await claw.api.createToolCall(
			{
				clawId: owned.id,
				threadId: thread.id,
				runId: "run-1",
				toolCallId: "provider-1",
				toolName: "search",
				args: { q: "x" },
				status: "proposed",
			},
			ALICE,
		);
		await claw.api.createToolResult(
			{
				clawId: owned.id,
				threadId: thread.id,
				runId: "run-1",
				toolCallId: "provider-1",
				status: "completed",
				output: { hits: 0 },
				outputMode: "full",
			},
			ALICE,
		);

		await expect(claw.api.getToolCall({ id: call.id }, BOB)).rejects.toThrow(
			DENIED,
		);
		await expect(
			claw.api.updateToolCallStatus(
				{ id: call.id, patch: { status: "failed" } },
				BOB,
			),
		).rejects.toThrow(DENIED);
		// Keyed by the (runId, provider tool-call id) pair rather than a row id — the composite still has
		// to resolve to Alice's claw, or the pair would be a way around the row lookup.
		await expect(
			claw.api.getToolCallByProviderId(
				{ runId: "run-1", toolCallId: "provider-1" },
				BOB,
			),
		).rejects.toThrow(DENIED);
		await expect(
			claw.api.listToolResults(
				{ runId: "run-1", toolCallId: "provider-1" },
				BOB,
			),
		).rejects.toThrow(DENIED);

		expect((await claw.api.getToolCall({ id: call.id }, ALICE))?.id).toBe(
			call.id,
		);
	});

	it("checkpoint: Bob cannot read Alice's checkpoint by id or by run", async () => {
		const { claw, owned, thread } = await alicesTranscript();
		const checkpoint = await claw.api.createCheckpoint(
			{
				clawId: owned.id,
				threadId: thread.id,
				runId: "run-1",
				kind: "step",
				state: { step: 1 },
			},
			ALICE,
		);

		await expect(
			claw.api.getCheckpoint({ id: checkpoint.id }, BOB),
		).rejects.toThrow(DENIED);
		await expect(
			claw.api.getLatestCheckpoint({ runId: "run-1" }, BOB),
		).rejects.toThrow(DENIED);
		expect(
			(await claw.api.getLatestCheckpoint({ runId: "run-1" }, ALICE))?.id,
		).toBe(checkpoint.id);
	});

	it("scope: Bob cannot administer a boundary he is not a verified member of", async () => {
		const claw = makeClaw();
		const boundary = { scope: "organization", scopeId: "acme" } as const;

		// No scope resolver is configured, so NOBODY holds a scope and every scope-anchored method
		// denies. That is the correct default: a deployment that cannot verify membership must not
		// honour a membership claim, and the request naming a boundary is not evidence of belonging to
		// it. This is the sharpest case the audit found — it used to rewrite any tenant's Cedar policy.
		await expect(
			claw.api.putPolicySlice(
				{
					...boundary,
					name: "guard",
					cedar: "permit(principal, action, resource);",
					mode: "enforce",
				},
				BOB,
			),
		).rejects.toThrow(DENIED);
		await expect(claw.api.listPolicySlices(boundary, BOB)).rejects.toThrow(
			DENIED,
		);
		await expect(
			claw.api.deletePolicySlice({ ...boundary, id: "any" }, BOB),
		).rejects.toThrow(DENIED);
		await expect(claw.api.listActions(boundary, BOB)).rejects.toThrow(DENIED);
		// Alice is no more a member than Bob — this is not owner isolation, it is membership.
		await expect(claw.api.listPolicySlices(boundary, ALICE)).rejects.toThrow(
			DENIED,
		);
	});

	it("share: Bob cannot grant himself access to Alice's claw", async () => {
		const { claw, owned } = await alicesTranscript();

		// share/unshare take the target kind AND id from the input, and require MANAGE on the target —
		// so the one method that could manufacture access is itself gated by the access it would grant.
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "claw",
					resourceId: owned.id,
					principalRef: "user:bob",
					permission: "manage",
				},
				BOB,
			),
		).rejects.toThrow(DENIED);
		// Still Alice's afterwards — the refusal was not a no-op that wrote anyway.
		await expect(claw.api.getClaw({ id: owned.id }, BOB)).rejects.toThrow(
			DENIED,
		);
	});

	it("an unresolvable id denies rather than falling back to the caller", async () => {
		const claw = makeClaw();

		// The original defect in one line: a row that does not resolve used to produce a resource owned
		// by whoever asked. Absent must mean no, not yes.
		await expect(
			claw.api.getClaw({ id: "does-not-exist" }, BOB),
		).rejects.toThrow(DENIED);
		await expect(
			claw.api.getMessage({ id: "does-not-exist" }, BOB),
		).rejects.toThrow(DENIED);
		await expect(
			claw.api.getCheckpoint({ id: "does-not-exist" }, BOB),
		).rejects.toThrow(DENIED);
	});
});
