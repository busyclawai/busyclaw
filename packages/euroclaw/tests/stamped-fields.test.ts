// The runtime half of stamped-fields.test-d (docs/plans/stamped-fields.md): even when a client FORGES a
// who/where field in the request body — the wire scenario the input schema silently strips, but a
// hand-built body can still carry — the handler stamps the field from the authenticated caller
// `{ principal }`, NEVER the body. The forged body values are injected via `as never` to stand in for
// exactly that untyped wire input; the assertions prove the CALLER wins. (The positive stamping is also
// proven in app-authz-pep / send / conversation-binding / secret-store; here we prove the forge is inert.)
import { secrets } from "@euroclaw/secrets-plugin";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, textModel } from "./fixtures";

const ALICE = "user:alice";
const VICTIM = "user:victim";

function makeClaw() {
	const { db, redactor } = durableRedactor();
	return createClaw({
		database: db,
		model: textModel("done"),
		redaction: { redactor },
		plugins: [secrets([], { store: { key: "0123456789abcdef".repeat(4) } })],
	});
}

describe("stamped identity fields — the caller wins over a forged body (runtime)", () => {
	it("createClaw stamps createdBy/scope/scopeId from the caller, ignoring a forged body (#5)", async () => {
		const claw = makeClaw();
		const created = await claw.api.createClaw(
			// A wire client's forged body — createdBy/scope/scopeId it should not control.
			{
				name: "c",
				createdBy: VICTIM,
				scope: "organization",
				scopeId: "org:evil",
			} as never,
			{ principal: ALICE },
		);
		// The owner is the caller, and the claw is personal to the caller — the body is inert.
		expect(created.createdBy).toBe(ALICE);
		expect(created.scope).toBe("personal");
		expect(created.scopeId).toBe(ALICE);
	});

	it("secrets.set keys the row to the caller, ignoring a forged body principal (#3)", async () => {
		const claw = makeClaw();
		await claw.api.secrets.set(
			{ name: "TOKEN", value: "v", principal: VICTIM } as never,
			{ principal: ALICE },
		);
		// The row lives on ALICE's boundary — the victim can't reach it, the caller can.
		await expect(
			claw.api.secrets.list({}, { principal: VICTIM }),
		).resolves.toEqual([]);
		await expect(
			claw.api.secrets.list({}, { principal: ALICE }),
		).resolves.toMatchObject([{ name: "TOKEN", createdBy: ALICE }]);
	});

	it("shareResource stamps grantedBy from the caller, ignoring a forged body", async () => {
		const claw = makeClaw();
		const created = await claw.api.createClaw(
			{ name: "shared" },
			{ principal: ALICE },
		);
		const grant = await claw.api.shareResource(
			{
				resourceKind: "claw",
				resourceId: created.id,
				principalRef: "user:bob",
				permission: "use",
				grantedBy: VICTIM,
			} as never,
			{ principal: ALICE },
		);
		// The accountable grantor is the caller who owns/manages the target, never the forged body value.
		expect(grant.grantedBy).toBe(ALICE);
	});
});
