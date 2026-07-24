// slice-1 proof at the ASSEMBLY: the product-API PEP wraps the whole `claw.api` and enforces the
// GENERIC ACL end-to-end through `createClaw`. The generic owner∪scope∪grant BRANCHES + level ordering
// are proven at the decision layer (../../foundation/authz/tests/api.test.ts, via membership/grant
// stubs — no org plugin, no table needed); here we prove the WIRING: the actor floor, cross-user owner
// isolation over a real loaded claw, the create-permit, zero-config protection, and the escape hatches.

import type { ApiPermissionLevel } from "@euroclaw/authz";
import { secrets } from "@euroclaw/secrets-plugin";
import { describe, expect, it } from "vitest";
import type { ClawApiMethod } from "../src/api";
import type { AppAuthzConfig } from "../src/authz-pep";
import { createClaw } from "../src/index";
import { durableRedactor, textModel } from "./fixtures";

const ALICE = "user:alice";
const BOB = "user:bob";

function makeClaw(options?: {
	appAuthz?: AppAuthzConfig;
	warn?: (message: string) => void;
}) {
	const { db, redactor } = durableRedactor();
	return createClaw({
		database: db,
		model: textModel("done"),
		redaction: { redactor },
		...(options?.appAuthz ? { appAuthz: options.appAuthz } : {}),
		...(options?.warn ? { warn: options.warn } : {}),
	});
}

describe("app-authz PEP — the actor floor", () => {
	it("zero-config claw is PROTECTED: a governed call with no caller principal denies out of the box", async () => {
		const claw = makeClaw();
		await expect(
			claw.api.createClaw({ createdBy: ALICE, name: "a" }),
		).rejects.toThrow(/actor floor|EUROCLAW_AUTHORIZATION_DENIED/);
		await expect(claw.api.getClaw({ id: "missing" })).rejects.toThrow(
			/EUROCLAW_AUTHORIZATION_DENIED/,
		);
	});
});

describe("app-authz PEP — owner isolation over a loaded claw", () => {
	it("the creator owns it; a different principal is denied read", async () => {
		const claw = makeClaw();
		const created = await claw.api.createClaw(
			{ createdBy: ALICE, name: "Alice's claw" },
			{ principal: ALICE },
		);

		// owner reads it
		await expect(
			claw.api.getClaw({ id: created.id }, { principal: ALICE }),
		).resolves.toMatchObject({ id: created.id, createdBy: ALICE });

		// a stranger cannot (no membership, no grant) — the loaded claw's createdBy is the owner
		await expect(
			claw.api.getClaw({ id: created.id }, { principal: BOB }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);

		// nor can the stranger mutate it (manage level, still owner-gated)
		await expect(
			claw.api.updateClaw(
				{ id: created.id, patch: { name: "hijacked" } },
				{ principal: BOB },
			),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz PEP — the fail-closed loader", () => {
	it("a resource-anchored method on a NOT-FOUND resource DENIES (the old self-shape would have permitted)", async () => {
		const claw = makeClaw();
		// A valid authenticated caller, but the id resolves to no row: the loader FAILS CLOSED to a shape
		// nothing satisfies — NOT "the caller owns it". (Pre-rework, the self-shape made createdBy == the
		// caller, so this READ would have been permitted — the cross-user hole this rework closes.)
		await expect(
			claw.api.getClaw({ id: "ghost" }, { principal: ALICE }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
		// a manage-level method on a ghost likewise denies
		await expect(
			claw.api.updateClaw(
				{ id: "ghost", patch: { name: "x" } },
				{ principal: ALICE },
			),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});

	it("a create is permitted, yet a resource-anchored method on an unloadable resource still denies", async () => {
		const claw = makeClaw();
		// authorizeScope-style create — any authenticated principal may (the created row is theirs) …
		const created = await claw.api.createClaw(
			{ createdBy: ALICE, name: "real" },
			{ principal: ALICE },
		);
		expect(created.createdBy).toBe(ALICE);
		// … but that create does NOT make an arbitrary resource-anchored method pass: a getClaw on a
		// DIFFERENT, non-existent id fails closed.
		await expect(
			claw.api.getClaw({ id: "no-such-claw" }, { principal: ALICE }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz PEP — the create-permit", () => {
	it("any authenticated principal may create; the created row is then theirs to read", async () => {
		const claw = makeClaw();
		const created = await claw.api.createClaw(
			{ createdBy: BOB, name: "Bob's claw" },
			{ principal: BOB },
		);
		expect(created.createdBy).toBe(BOB);
		await expect(
			claw.api.getClaw({ id: created.id }, { principal: BOB }),
		).resolves.toMatchObject({ id: created.id });
	});
});

describe("app-authz PEP — escape hatches", () => {
	it("unsafeOpen restores host-authorizes: a caller-less governed call permits", async () => {
		const claw = makeClaw({ appAuthz: { unsafeOpen: true } });
		const created = await claw.api.createClaw({
			createdBy: ALICE,
			name: "open",
		});
		// getClaw with NO caller would deny under enforcement — unsafeOpen lets it through.
		await expect(claw.api.getClaw({ id: created.id })).resolves.toMatchObject({
			id: created.id,
		});
	});

	it("posture shadow logs a would-be denial without enforcing", async () => {
		const warnings: string[] = [];
		const claw = makeClaw({
			appAuthz: { posture: "shadow" },
			warn: (message) => warnings.push(message),
		});
		const created = await claw.api.createClaw(
			{ createdBy: ALICE, name: "shadowed" },
			{ principal: ALICE },
		);
		// BOB is not the owner: enforcement WOULD deny, shadow logs it and proceeds (returns the claw).
		await expect(
			claw.api.getClaw({ id: created.id }, { principal: BOB }),
		).resolves.toMatchObject({ id: created.id });
		expect(
			warnings.some(
				(w) => w.includes("app-authz shadow") && w.includes("getClaw"),
			),
		).toBe(true);
	});
});

describe("app-authz PEP — a governed plugin method (secretStore realignment)", () => {
	it("the caller-arg is the ONE identity path; absent → the actor floor denies", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
			plugins: [secrets([], { store: { key: "0123456789abcdef".repeat(4) } })],
		});
		// Identity travels beside the input (no `principal` in the domain body) — the realigned path.
		await claw.api.secrets.set(
			{ name: "NOTION", value: "tok" },
			{ principal: ALICE },
		);
		await expect(
			claw.api.secrets.list({}, { principal: ALICE }),
		).resolves.toMatchObject([{ name: "NOTION", createdBy: ALICE }]);
		// a different caller reads their own (empty) boundary — the caller IS the scope
		await expect(
			claw.api.secrets.list({}, { principal: BOB }),
		).resolves.toEqual([]);
		// the actor floor reaches plugin namespaces too: no caller principal → deny
		await expect(
			claw.api.secrets.set({ name: "X", value: "y" }),
		).rejects.toThrow(/EUROCLAW_AUTHORIZATION_DENIED/);
	});
});

describe("app-authz PEP — the per-method level map is typo-safe", () => {
	it("a mistyped api action id does not compile", () => {
		// The real map is `satisfies Record<ClawApiMethod, ApiPermissionLevel>` (see authz-pep.ts): a
		// key that is not a ClawApi method fails to compile, so an action typo can never ship unmodeled.
		const good = { getClaw: "read" } satisfies Partial<
			Record<ClawApiMethod, ApiPermissionLevel>
		>;
		expect(good.getClaw).toBe("read");
		// @ts-expect-error — "getClawTypo" is not a ClawApiMethod
		const bad = { getClawTypo: "read" } satisfies Partial<
			Record<ClawApiMethod, ApiPermissionLevel>
		>;
		void bad;
	});
});
