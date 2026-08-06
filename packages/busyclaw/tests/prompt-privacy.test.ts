// A CHAT MESSAGE MUST NOT SURVIVE ITS OWN ERASURE — docs/plans/one-run.md D13, hazard P1.
//
// Erasure here is crypto-shredding: `forgetSubject` destroys the MAPPINGS, so every placeholder that
// pointed at a person stops resolving. It has exactly one blind spot, and it is total — text that was
// never tokenized has no mapping to shred, so shredding does nothing to it and a completed DSR is a
// false statement about that copy.
//
// Making a chat turn a durable run put two new columns in the path of that blind spot: `run.input`,
// which is `immutable` and which nothing prunes, and `runtime_task.payload`, which `completeTask`
// retains. Written raw, they were a permanent cleartext copy of every message, minted one line after
// the same words were carefully tokenized into the transcript.
//
// So the test is not "is the marker set" — the `pii` marker is documentation and adapters neither
// read nor enforce it. The test is the DSR claim itself: after erasure, the words are gone from
// everywhere, and the way to check that is to look everywhere.

import type { Adapter } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { createMemoryAudit } from "@busyclaw/core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, textModel, withPrincipal } from "./fixtures";

const ACTOR = userPrincipal("actor-1");
const SECRET = "alice@personal.com";

async function conversation(audit?: ReturnType<typeof createMemoryAudit>) {
	const { db, redactor } = durableRedactor();
	const claw = createClaw({
		database: db,
		model: textModel("done"),
		redaction: { redactor },
		...(audit ? { audit } : {}),
	});
	const api = withPrincipal(claw, ACTOR).api;
	const agent = await api.createClaw({ id: "claw-1", name: "Assistant" });
	const thread = await api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Chat",
	});
	return { agent, api, claw, db, thread };
}

/** Which of this claw's tables hold `needle`, out of ALL of them — the only honest way to ask "is it
 *  anywhere". Asserting table by table only tests the tables somebody thought of. */
async function tablesHolding(
	db: Adapter,
	claw: { $tables: unknown },
	needle: string,
): Promise<string[]> {
	const models = Object.keys(claw.$tables as Record<string, unknown>);
	const hits = await Promise.all(
		models.map(async (model) => {
			try {
				const rows = await db.findMany({ model, where: [] });
				return JSON.stringify(rows).includes(needle) ? model : null;
			} catch {
				// A model the adapter has no rows for is not a hiding place.
				return null;
			}
		}),
	);
	return hits.filter((model): model is string => model !== null).sort();
}

describe("the prompt leaves the run row", () => {
	it("writes no fragment of the user's message into run.input", async () => {
		const { agent, api, db, thread } = await conversation();

		const sent = await api.sendMessage({
			clawId: agent.id,
			message: `email ${SECRET} about the offer`,
			threadId: thread.id,
		});

		const rows = await db.findMany({
			model: "run",
			where: [{ field: "id", value: sent.runId }],
		});
		expect(rows).toHaveLength(1);
		const row = JSON.stringify(rows[0]);
		// Not the address, and not the sentence it was in: `run.input` carries `{ ctx }` now, so there
		// is no prompt to leak either raw or tokenized.
		expect(row).not.toContain(SECRET);
		expect(row).not.toContain("about the offer");
		expect(row).not.toContain("{{pii:");
	});

	it("hands the engine the TOKENIZED prompt, so what the task payload keeps is shreddable", async () => {
		// The payload genuinely does carry the prompt — it is what seeds the transcript, and there is
		// nowhere else a first slice could get it. What changed is WHICH string arrives: a placeholder
		// has a mapping, and a mapping can be destroyed.
		const { agent, api, db, thread } = await conversation();

		const sent = await api.sendMessage({
			clawId: agent.id,
			message: `email ${SECRET}`,
			threadId: thread.id,
		});

		const tasks = await db.findMany({
			model: "runtime_task",
			where: [{ field: "runId", value: sent.runId }],
		});
		const payloads = JSON.stringify(tasks);
		expect(payloads).not.toContain(SECRET);
		expect(payloads).toMatch(/\{\{pii:email:[a-z0-9-]+\}\}/);
	});

	it("keeps the raw value in ONE table — the one whose job is to be destroyable", async () => {
		// THE PRECONDITION FOR ERASURE, stated as the property it actually is. Crypto-shredding works
		// because there is exactly one copy of the original and it lives behind a key: destroy the
		// mapping and every placeholder pointing at it stops resolving, everywhere at once. A second
		// copy anywhere else is not a smaller problem — it is the whole problem, because nothing
		// shreds it and nothing knows to look for it.
		//
		// A raw prompt in `run.input` or `runtime_task.payload` would show up here as a second and
		// third table, which is what this scans for rather than assuming.
		const { agent, api, claw, db, thread } = await conversation();

		await api.sendMessage({
			clawId: agent.id,
			message: `email ${SECRET} about the offer`,
			threadId: thread.id,
		});

		expect(await tablesHolding(db, claw, SECRET)).toEqual(["pii_mapping"]);
		// THE PROSE AROUND IT IS A DIFFERENT QUESTION, and the honest answer is that it stays. The
		// detector tokenizes what it identifies; the rest of the sentence is not a data subject and
		// nothing claims to erase it. It lives in the transcript and in `runtime_task.payload`, which
		// is what seeds the run and has nowhere else to get it — so `run` is NOT in this list, and its
		// absence is the whole of what this slice changed.
		expect(await tablesHolding(db, claw, "about the offer")).toEqual([
			"message",
			"runtime_task",
		]);
	});

	it("holds only placeholders once the mapping is shredded — everywhere at once", async () => {
		// THE DSR CLAIM, tested as a claim rather than as a set of columns somebody remembered.
		//
		// Shredding is performed here directly on the mapping rows rather than through
		// `api.forgetSubject`, and that is a finding rather than a shortcut: the door's own user-message
		// redaction links its mappings to NO data subject, so `forgetSubject({ subjectId })` sweeps for
		// rows that were never written and answers "erased 0" — indistinguishable from a completed
		// shred. The assembly already warns about it at boot ("no subject resolver: mappings minted by
		// ordinary message and tool redaction are linked to no data subject"), and a `subject` resolver
		// on `createClaw` does not close it for this path. That is R-M03's lineage work, not this
		// slice's, and it is named here so nobody reads a green suite as proof of the wider claim.
		//
		// What IS this slice's is the property below: destroying the mapping is SUFFICIENT, because
		// every copy of the value outside that table is a placeholder pointing at it.
		const { agent, api, claw, db, thread } = await conversation();

		await api.sendMessage({
			clawId: agent.id,
			message: `email ${SECRET} about the offer`,
			threadId: thread.id,
		});
		// Readable before, so the assertion after it means something.
		expect(
			JSON.stringify(
				await api.listMessages({ threadId: thread.id, view: "original" }),
			),
		).toContain(SECRET);

		await db.deleteMany?.({
			model: "pii_mapping",
			where: [{ field: "containerId", value: agent.id }],
		});

		expect(
			JSON.stringify(
				await api.listMessages({ threadId: thread.id, view: "original" }),
			),
		).not.toContain(SECRET);
		expect(await tablesHolding(db, claw, SECRET)).toEqual([]);
	});
});

describe("the run door is not a content door", () => {
	it("getRun answers about the run without answering about its content", async () => {
		const audit = createMemoryAudit();
		const { agent, api, thread } = await conversation(audit);

		const sent = await api.sendMessage({
			clawId: agent.id,
			message: `email ${SECRET}`,
			threadId: thread.id,
		});
		const run = await api.getRun({ id: sent.runId });

		// What a control plane asks for.
		expect(run).toMatchObject({ id: sent.runId, status: "completed" });
		// And what it does not get. `input` is absent from the projection entirely — not empty, not
		// redacted: a reader cannot tell from this door what the run was asked.
		expect(run && "input" in run).toBe(false);
		expect(JSON.stringify(run)).not.toContain(SECRET);
		// NO re-identification line, because nothing was re-identified. `listMessages({view:"original"})`
		// writes one; this door has no content to write one about, which is the asymmetry D13 closes —
		// the smaller door used to reach the same class of thing with neither a gate nor an audit.
		expect(
			audit.entries().some((entry) => entry.action === "pii.reidentification"),
		).toBe(false);
	});

	it("listRunEvents reports what happened, not what was said", async () => {
		// `run.completed`'s payload carries the whole terminal result — the assistant's answer — into
		// `run_event.payload`, a column no `view` gate and no audit line covers (P2).
		const { agent, api, thread } = await conversation();

		const sent = await api.sendMessage({
			clawId: agent.id,
			message: "hello",
			threadId: thread.id,
		});
		const events = await api.listRunEvents({ runId: sent.runId });

		expect(events.map((event) => event.type)).toContain("run.completed");
		// The answer is "done" — reachable through `listMessages`, and not through here.
		expect(JSON.stringify(events)).not.toContain("done");
		// Still useful: the operational keys survive, so "which task, how many steps, who asked" is
		// answerable without the transcript.
		expect(
			events.some((event) => typeof event.payload.taskId === "string"),
		).toBe(true);
	});
});
