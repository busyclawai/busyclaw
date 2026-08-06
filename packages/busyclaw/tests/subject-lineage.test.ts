// WHOSE DATA IS THIS — R-M03, and the half of it the conversational door never had.
//
// Erasure is crypto-shredding, and shredding is keyed on the SUBJECT: `forgetSubject(subjectId)`
// deletes the mappings that person appears on. A mapping reaches that index only when trusted code
// says who it is about, which is what `createClaw({ subject })` is for.
//
// The gap was an ordering one, and it hit the likeliest place for a person's data. `sendMessage`
// tokenizes the user's message at the DOOR, before the run that resolves the subject has started —
// so `save` linked nothing, and `forgetSubject` answered "erased 0" SUCCESSFULLY about a person
// whose address was sitting in the transcript. A compliance answer that cannot tell "shredded
// everything" from "found nothing" is not a weak answer, it is a false one.
//
// The fix links what is ALREADY tokenized when a subject is in context, inside the redactor — so
// lineage follows the data rather than the call site.

import { memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import { emailDetector, owned, textModel } from "./fixtures";

const SECRET = "alice@personal.com";
const SUBJECT = "cust_42";

async function conversation(subject?: () => string | undefined) {
	const db = memoryAdapter();
	const claw = owned({
		database: db,
		model: textModel("done"),
		redaction: { detectors: [emailDetector], indexKey: "test-key" },
		...(subject ? { subject } : {}),
	} as Parameters<typeof owned>[0]);
	const agent = await claw.api.createClaw({ id: "claw-1", name: "Assistant" });
	const thread = await claw.api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Chat",
	});
	return { agent, claw, db, thread };
}

describe("a chat message is erasable by the person it is about", () => {
	it("links the user's own message to the subject the host resolved", async () => {
		const { agent, claw, thread } = await conversation(() => SUBJECT);

		await claw.api.sendMessage({
			clawId: agent.id,
			message: `email ${SECRET} about the offer`,
			threadId: thread.id,
		});
		// Readable before, so the assertion after it means something.
		expect(
			JSON.stringify(
				await claw.api.listMessages({
					threadId: thread.id,
					view: "original",
				}),
			),
		).toContain(SECRET);

		const erased = await claw.api.forgetSubject({
			subjectId: SUBJECT,
			containerKind: "claw",
			containerId: agent.id,
		});

		// A NON-ZERO count, which is the whole compliance answer: "found nothing" and "shredded it"
		// used to be the same reply here.
		expect(erased.erased).toBeGreaterThan(0);
		expect(
			JSON.stringify(
				await claw.api.listMessages({
					threadId: thread.id,
					view: "original",
				}),
			),
		).not.toContain(SECRET);
	});

	it("still finds nothing when the deployment named no subject", async () => {
		// The honest other half. Without a resolver nobody has said whose data this is, and busyclaw
		// cannot infer it — so erasure genuinely has nothing to find, and the assembly warns at boot
		// rather than pretending. This asserts the warning is TRUE, not that the gap is fine.
		const { agent, claw, thread } = await conversation();

		await claw.api.sendMessage({
			clawId: agent.id,
			message: `email ${SECRET}`,
			threadId: thread.id,
		});

		expect(
			(
				await claw.api.forgetSubject({
					subjectId: SUBJECT,
					containerKind: "claw",
					containerId: agent.id,
				})
			).erased,
		).toBe(0);
	});

	it("does not link one person's message to another person's subject", async () => {
		// The subject is resolved PER TURN, so two turns about two people must not cross. Erasing one
		// leaves the other readable — which is what makes this an erasure index rather than a
		// per-claw kill switch.
		let who = "cust_a";
		const { agent, claw, thread } = await conversation(() => who);

		await claw.api.sendMessage({
			clawId: agent.id,
			message: "email a@personal.com",
			threadId: thread.id,
		});
		who = "cust_b";
		await claw.api.sendMessage({
			clawId: agent.id,
			message: "email b@personal.com",
			threadId: thread.id,
		});

		await claw.api.forgetSubject({
			subjectId: "cust_a",
			containerKind: "claw",
			containerId: agent.id,
		});

		const after = JSON.stringify(
			await claw.api.listMessages({ threadId: thread.id, view: "original" }),
		);
		expect(after).not.toContain("a@personal.com");
		expect(after).toContain("b@personal.com");
	});

	it("links nothing for a placeholder this container has no mapping for", async () => {
		// A token with no mapping HERE is not this subject's data — it is a namesake, a stale token
		// left in a transcript after an erasure, or a string somebody pasted. Linking it would put an
		// orphan in the erasure index, so a later shred would report a count for rows that erase
		// nothing: the same false-confidence answer this whole area exists to remove.
		const { agent, claw, db, thread } = await conversation(() => SUBJECT);

		await claw.api.appendMessage({
			clawId: agent.id,
			threadId: thread.id,
			role: "user",
			content: "look at {{pii:email:not-a-real-token-here}}",
		});
		await claw.api.sendMessage({
			clawId: agent.id,
			message: "and {{pii:email:not-a-real-token-here}} again",
			threadId: thread.id,
		});

		expect(
			await db.findMany({
				model: "pii_subject",
				where: [
					{
						field: "placeholder",
						value: "{{pii:email:not-a-real-token-here}}",
					},
				],
			}),
		).toEqual([]);
	});

	it("links a value the run only ever saw as a placeholder", async () => {
		// THE PROPERTY, stated generally: lineage follows the DATA. The same address mentioned in a
		// LATER turn is already tokenized by then — nothing mints, so nothing would link if this lived
		// at the mint site. Both turns' copies are the same mapping and both are erasable.
		const { agent, claw, thread } = await conversation(() => SUBJECT);

		await claw.api.sendMessage({
			clawId: agent.id,
			message: `first ${SECRET}`,
			threadId: thread.id,
		});
		await claw.api.sendMessage({
			clawId: agent.id,
			message: `again ${SECRET}`,
			threadId: thread.id,
		});

		await claw.api.forgetSubject({
			subjectId: SUBJECT,
			containerKind: "claw",
			containerId: agent.id,
		});

		expect(
			JSON.stringify(
				await claw.api.listMessages({
					threadId: thread.id,
					view: "original",
				}),
			),
		).not.toContain(SECRET);
	});
});
