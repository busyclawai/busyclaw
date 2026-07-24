// Slice-5 proof at the ASSEMBLY: the generic `access_grant` ACL + the plugin-extensible loader registry
// end-to-end through `createClaw`. The DECISION mechanics (owner/scope/grant, leveled Cedar `in`) are
// proven at the authz layer (../../foundation/authz/tests/api.test.ts); here we prove the DATA + WIRING:
// real grants written through the share api reach the decision, the registry loads real rows (claw /
// thread inheritance / a plugin `shareable` kind), owner-isolation holds, and fail-closed is preserved.

import type { EuroclawPlugin } from "@euroclaw/contracts";
import { accessGrantFields } from "@euroclaw/contracts";
import { entityAdapter, memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, textModel } from "./fixtures";

const ALICE = "user:alice";
const BOB = "user:bob";
const CAROL = "user:carol";
const STRANGER = "user:stranger";

function makeClaw(plugins: readonly EuroclawPlugin[] = []) {
	const { db, redactor } = durableRedactor();
	return createClaw({
		database: db,
		model: textModel("done"),
		redaction: { redactor },
		plugins,
	});
}

describe("app-authz slice 5 — a user grant goes LIVE through the share api", () => {
	it("share user:bob(use) → bob is use/read-permitted, manage-denied; the owner is unaffected", async () => {
		const claw = makeClaw();
		const created = await claw.api.createClaw(
			{ createdBy: ALICE, name: "shared" },
			{ principal: ALICE },
		);

		// alice OWNS it (manage), so she may share it
		await claw.api.shareResource(
			{
				resourceKind: "claw",
				resourceId: created.id,
				principalRef: BOB,
				permission: "use",
				grantedBy: ALICE,
			},
			{ principal: ALICE },
		);

		// bob at USE: createThread (use) permitted, listThreads (read; use satisfies read) permitted
		await expect(
			claw.api.createThread({ clawId: created.id }, { principal: BOB }),
		).resolves.toMatchObject({ clawId: created.id });
		await expect(
			claw.api.listThreads({ clawId: created.id }, { principal: BOB }),
		).resolves.toBeInstanceOf(Array);

		// bob at MANAGE: archiveClaw denied (use does NOT reach manage — Cedar level ordering)
		await expect(
			claw.api.archiveClaw({ id: created.id }, { principal: BOB }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);

		// the owner still reads/manages it
		await expect(
			claw.api.getClaw({ id: created.id }, { principal: ALICE }),
		).resolves.toMatchObject({ id: created.id, createdBy: ALICE });
	});

	it("a public grant permits ANYONE at the granted level, but not above it", async () => {
		const claw = makeClaw();
		const created = await claw.api.createClaw(
			{ createdBy: ALICE },
			{ principal: ALICE },
		);
		await claw.api.shareResource(
			{
				resourceKind: "claw",
				resourceId: created.id,
				principalRef: "public",
				permission: "read",
				grantedBy: ALICE,
			},
			{ principal: ALICE },
		);
		// any stranger reads it (public read) …
		await expect(
			claw.api.getClaw({ id: created.id }, { principal: STRANGER }),
		).resolves.toMatchObject({ id: created.id });
		// … but a public READ grant does not confer USE
		await expect(
			claw.api.createThread({ clawId: created.id }, { principal: STRANGER }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz slice 5 — the share/unshare api is itself governed (manage on the target)", () => {
	it("only a caller who MANAGES the target may share it; unshare revokes", async () => {
		const claw = makeClaw();
		const created = await claw.api.createClaw(
			{ createdBy: ALICE },
			{ principal: ALICE },
		);

		// bob neither owns nor holds a grant → cannot share alice's claw (manage required)
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "claw",
					resourceId: created.id,
					principalRef: CAROL,
					permission: "read",
					grantedBy: BOB,
				},
				{ principal: BOB },
			),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);

		// alice shares with bob(use) → bob is in
		await claw.api.shareResource(
			{
				resourceKind: "claw",
				resourceId: created.id,
				principalRef: BOB,
				permission: "use",
				grantedBy: ALICE,
			},
			{ principal: ALICE },
		);
		await expect(
			claw.api.createThread({ clawId: created.id }, { principal: BOB }),
		).resolves.toBeTruthy();

		// alice unshares → the grant is gone (count 1), bob is out again
		await expect(
			claw.api.unshareResource(
				{ resourceKind: "claw", resourceId: created.id, principalRef: BOB },
				{ principal: ALICE },
			),
		).resolves.toBe(1);
		await expect(
			claw.api.createThread({ clawId: created.id }, { principal: BOB }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz slice 5 — thread access is its claw's ∪ its own", () => {
	it("a claw grant reaches the thread (inheritance); a thread's own grant reaches a principal with no claw grant", async () => {
		const claw = makeClaw();
		const created = await claw.api.createClaw(
			{ createdBy: ALICE },
			{ principal: ALICE },
		);
		const thread = await claw.api.createThread(
			{ clawId: created.id },
			{ principal: ALICE },
		);

		// share the CLAW with bob(use) → bob reads the thread (inherited) and its messages
		await claw.api.shareResource(
			{
				resourceKind: "claw",
				resourceId: created.id,
				principalRef: BOB,
				permission: "use",
				grantedBy: ALICE,
			},
			{ principal: ALICE },
		);
		await expect(
			claw.api.getThread({ id: thread.id }, { principal: BOB }),
		).resolves.toMatchObject({ id: thread.id });
		await expect(
			claw.api.listMessages({ threadId: thread.id }, { principal: BOB }),
		).resolves.toBeInstanceOf(Array);

		// carol has NO claw grant, but a grant on the THREAD itself reaches her
		await claw.api.shareResource(
			{
				resourceKind: "thread",
				resourceId: thread.id,
				principalRef: CAROL,
				permission: "read",
				grantedBy: ALICE,
			},
			{ principal: ALICE },
		);
		await expect(
			claw.api.getThread({ id: thread.id }, { principal: CAROL }),
		).resolves.toMatchObject({ id: thread.id });

		// a principal with neither is denied
		await expect(
			claw.api.getThread({ id: thread.id }, { principal: "user:nobody" }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz slice 5 — fail-closed is preserved with the grant store wired", () => {
	it("a not-found resource still DENIES (never self-owned), sharing a ghost too", async () => {
		const claw = makeClaw();
		await expect(
			claw.api.getClaw({ id: "ghost" }, { principal: ALICE }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
		// you cannot share what does not resolve (the target load fails closed → no manage → deny)
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "claw",
					resourceId: "ghost",
					principalRef: BOB,
					permission: "read",
					grantedBy: ALICE,
				},
				{ principal: ALICE },
			),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz slice 5 — a plugin's shareable kind is governed with ZERO new policy", () => {
	// A throwaway plugin registering a `widget` loader — no policy, no core change: the GENERIC baseline
	// owner-isolates it the moment its base row is loadable.
	const widgetPlugin = {
		id: "widget-test",
		shareable: [
			{
				kind: "widget",
				load: () => async (id: string) =>
					id === "w1"
						? { createdBy: ALICE, scope: "personal", scopeId: ALICE }
						: null,
			},
		],
	} satisfies EuroclawPlugin;

	it("the owner may share the fake kind; a stranger cannot; an unregistered kind fails closed", async () => {
		const claw = makeClaw([widgetPlugin]);
		// alice OWNS widget w1 → may share it (generic owner rule, no widget-specific policy)
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "widget",
					resourceId: "w1",
					principalRef: BOB,
					permission: "read",
					grantedBy: ALICE,
				},
				{ principal: ALICE },
			),
		).resolves.toMatchObject({ resourceKind: "widget", resourceId: "w1" });

		// bob does not own w1 → denied
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "widget",
					resourceId: "w1",
					principalRef: CAROL,
					permission: "read",
					grantedBy: BOB,
				},
				{ principal: BOB },
			),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);

		// an UNREGISTERED kind → fail closed (you can't share what the registry can't load)
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "gadget",
					resourceId: "g1",
					principalRef: BOB,
					permission: "read",
					grantedBy: ALICE,
				},
				{ principal: ALICE },
			),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz slice 5 — a PLUGIN-registered shareable kind is owner-isolated", () => {
	// The plugin-extensible loader registry: a plugin declares a `shareable` kind + a loader that
	// presents the row's opaque base shape, and the generic PEP enforces owner-isolation on it with
	// ZERO core change and zero new policy. Proven against an inline fixture (an in-memory owner map)
	// rather than a real plugin, so the registry's regression coverage can't rot with whatever plugin
	// happens to exist — this previously rode on the skills plugin, deleted with the package.
	const OWNER_OF: Record<string, string> = { "doc-1": ALICE };
	const docsPlugin: EuroclawPlugin = {
		id: "docs",
		shareable: [
			{
				kind: "doc",
				load: () => async (id: string) => {
					const owner = OWNER_OF[id];
					// An unresolvable row returns null → the PEP FAILS CLOSED (never "the caller owns it").
					return owner === undefined
						? null
						: { createdBy: owner, scope: "personal", scopeId: owner };
				},
			},
		],
	};

	it("the owner may share it; a non-owner is denied", async () => {
		const db = memoryAdapter();
		const { redactor } = durableRedactor(db);
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
			plugins: [docsPlugin],
		});

		// alice owns doc-1 (per the plugin's loader) → may share it
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "doc",
					resourceId: "doc-1",
					principalRef: BOB,
					permission: "read",
				},
				{ principal: ALICE },
			),
		).resolves.toMatchObject({ resourceKind: "doc" });

		// bob is not the owner → denied (owner-isolation via the plugin loader, zero core change)
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "doc",
					resourceId: "doc-1",
					principalRef: CAROL,
					permission: "read",
				},
				{ principal: BOB },
			),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);

		// an UNREGISTERED kind fails closed even for a would-be owner
		await expect(
			claw.api.shareResource(
				{
					resourceKind: "nope",
					resourceId: "doc-1",
					principalRef: BOB,
					permission: "read",
				},
				{ principal: ALICE },
			),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});
