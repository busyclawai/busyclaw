// Type proofs for the server-stamped identity fields (docs/plans/stamped-fields.md, findings
// #5/#14/#6/#3): a who/where field — createdBy, scope/scopeId, approver `by`, secrets `principal`,
// grantedBy, registeredBy, updatedBy — is NOT a caller input. It is absent from every write method's
// input SHAPE, so a body value is a compile error; the handler stamps the field from the authenticated
// `{ principal }`. This file proves the forge is closed at the type level (the runtime stamping is proven
// in app-authz-pep / send / conversation-binding / secret-store). `.test-d.ts` is type-checked, never run.
import { secrets } from "@euroclaw/secrets-plugin";
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expectTypeOf, test } from "vitest";
import { createClaw } from "../src/index";
import { textModel } from "./fixtures";

// A fully-assembled claw whose api surface we probe at the TYPE level only — `declare`d, so it is never
// constructed at runtime; `buildClaw` exists solely to carry the assembled (secrets-augmented) type.
function buildClaw() {
	return createClaw({
		database: memoryAdapter(),
		model: textModel("done"),
		plugins: [secrets([], { store: { key: "0123456789abcdef".repeat(4) } })],
	});
}
declare const claw: ReturnType<typeof buildClaw>;

type CreateClawInput = Parameters<typeof claw.api.createClaw>[0];
type UpdateClawPatch = Parameters<typeof claw.api.updateClaw>[0]["patch"];
type GrantInput = Parameters<typeof claw.api.grantApproval>[0];
type DenyInput = Parameters<typeof claw.api.denyApproval>[0];
type SetSecretInput = Parameters<typeof claw.api.secrets.set>[0];
type DeleteSecretInput = Parameters<typeof claw.api.secrets.delete>[0];
type ListSecretInput = Parameters<typeof claw.api.secrets.list>[0];
type ShareInput = Parameters<typeof claw.api.shareResource>[0];
type RegisterSpecInput = Parameters<typeof claw.api.registerOpenApiSpec>[0];
type PutPolicySliceInput = Parameters<typeof claw.api.putPolicySlice>[0];
type BindClawDefaults = NonNullable<
	Parameters<typeof claw.api.bindConversation>[0]["claw"]
>;

describe("stamped identity fields are absent from every write input", () => {
	test("createClaw — createdBy / scope / scopeId are server-stamped, never input (#5)", () => {
		// The owner and the access boundary are stamped from the caller; a body value would forge them.
		expectTypeOf<CreateClawInput>().not.toHaveProperty("createdBy");
		expectTypeOf<CreateClawInput>().not.toHaveProperty("scope");
		expectTypeOf<CreateClawInput>().not.toHaveProperty("scopeId");
		// the domain fields the caller DOES supply are still present
		expectTypeOf<CreateClawInput>().toHaveProperty("name");
	});

	test("updateClaw — scope / scopeId are not a mass-assignable patch (#5)", () => {
		// Re-scoping is a governed sharing transition, never an updateClaw patch field.
		expectTypeOf<UpdateClawPatch>().not.toHaveProperty("scope");
		expectTypeOf<UpdateClawPatch>().not.toHaveProperty("scopeId");
		// a normal mutable column stays patchable
		expectTypeOf<UpdateClawPatch>().toHaveProperty("name");
	});

	test("approvals — the decider `by` is stamped, never caller-supplied (#6)", () => {
		// A forged approver `by` is impossible: decidedBy comes from the authenticated caller.
		expectTypeOf<GrantInput>().not.toHaveProperty("by");
		expectTypeOf<DenyInput>().not.toHaveProperty("by");
		expectTypeOf<GrantInput>().toHaveProperty("approvalId");
	});

	test("secrets — the owner keys strictly to the caller, never a body principal (#3)", () => {
		// A body `principal` would let a caller key a row to a victim — it is absent from all three.
		expectTypeOf<SetSecretInput>().not.toHaveProperty("principal");
		expectTypeOf<DeleteSecretInput>().not.toHaveProperty("principal");
		expectTypeOf<ListSecretInput>().not.toHaveProperty("principal");
		expectTypeOf<SetSecretInput>().toHaveProperty("value");
	});

	test("shareResource — the grantor is stamped from the caller, never input", () => {
		expectTypeOf<ShareInput>().not.toHaveProperty("grantedBy");
		expectTypeOf<ShareInput>().toHaveProperty("principalRef");
	});

	test("registry / policy-slice — registeredBy / updatedBy are stamped, never input", () => {
		expectTypeOf<RegisterSpecInput>().not.toHaveProperty("registeredBy");
		expectTypeOf<PutPolicySliceInput>().not.toHaveProperty("updatedBy");
		// organizationId stays caller-supplied for now (its stamping awaits organization())
		expectTypeOf<RegisterSpecInput>().toHaveProperty("organizationId");
	});

	test("bindConversation — a registration's claw defaults cannot carry createdBy (#14)", () => {
		// createdBy is stamped from the caller, so a registration can never mint a victim-owned conversation.
		expectTypeOf<BindClawDefaults>().not.toHaveProperty("createdBy");
		expectTypeOf<BindClawDefaults>().toHaveProperty("name");
	});
});
