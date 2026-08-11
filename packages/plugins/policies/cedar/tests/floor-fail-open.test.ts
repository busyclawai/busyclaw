/**
 * THE FLOOR MUST NOT EVAPORATE WHEN A CONTEXT ATTRIBUTE IS MISSING.
 *
 * Cedar's failure mode here is the dangerous direction. Reading an ABSENT attribute is an evaluation
 * ERROR, and an erroring policy is SILENTLY SKIPPED rather than treated as false — so an unguarded
 * `forbid` does not block, it disappears, and whatever `permit` sits under it decides instead. The
 * repo knows this: `system-posture.ts` says so in its own header, and `cedar.ts` marks `scopes` and
 * `roles` as always-supplied "belt-and-braces ... a policy reading an ABSENT base errors, and an
 * erroring policy is skipped, which takes a `forbid` down with it."
 *
 * That knowledge currently lives in prose and in the stamping layer. Nothing tests it, and nothing
 * stops the next optional attribute from being referenced unguarded. These cases put it under test as
 * a PROPERTY rather than as a list, so a newly declared context attribute is swept automatically:
 * the key list is read back out of the shipped Cedar schema, not copied into this file.
 *
 * WHAT IS BEING CLAIMED. Not that the stamping layer is broken — `cedarMapCall` really does default
 * `runMode`, `scopes` and `roles`. The claim is that the SEALED FLOOR does not defend itself, so its
 * safety is a property of one caller rather than of the policy. Every other way into this engine —
 * the shadow engine, the api plane, a plugin-supplied engine, a direct `cedarEngine` construction,
 * or the next door somebody adds — inherits the floor without inheriting the defaulting, and the
 * failure is silent by construction: a skipped forbid leaves no trace in the decision it did not make.
 */

import {
	type AuthzActionInput,
	actionEntitiesFromModel,
	buildAuthzModel,
	cedarEngine,
	modelToCedarSchema,
	SYSTEM_POSTURE,
} from "@busyclaw/authz";
import type { PolicyRequest } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";

const model = buildAuthzModel([
	{ id: "readDoc", source: "tool", governance: { access: "read" } },
	{ id: "writeDoc", source: "tool", governance: { access: "write" } },
] satisfies AuthzActionInput[]);

/**
 * The optional context attributes, READ BACK OUT of the schema this build actually ships.
 *
 * Deliberately not a hand-copied list. `CONTEXT_FIELDS` is private to `cedar.ts`, and a copy here
 * would rot the first time somebody adds an attribute — which is precisely the moment this sweep
 * needs to grow. Rendering the schema and parsing `name?: Type` back out means the new attribute is
 * swept by the next run of this file, with nobody remembering to add it.
 */
function optionalContextAttributes(): { key: string; sample: unknown }[] {
	const schema = modelToCedarSchema(model);
	const context = schema.match(/context:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/);
	if (!context?.[1])
		throw new Error("could not read the context block back out");
	const out: { key: string; sample: unknown }[] = [];
	for (const m of context[1].matchAll(
		/(\w+)\?:\s*(Set<String>|String|Bool|Long)/g,
	)) {
		const [, key, type] = m;
		if (key === undefined || type === undefined) continue;
		if (out.some((o) => o.key === key)) continue;
		out.push({
			key,
			sample:
				type === "Set<String>"
					? []
					: type === "Bool"
						? true
						: type === "Long"
							? 1
							: `sample-${key}`,
		});
	}
	return out;
}

/** The floor plus a customer slice that permits writes outright — the shape `loadPolicyBundle` builds. */
const withCustomerPermit = {
	...SYSTEM_POSTURE,
	"customer:allow-writes": `permit(principal, action in Action::"writes", resource);`,
};

const engine = () =>
	cedarEngine({
		policies: withCustomerPermit,
		entities: actionEntitiesFromModel(model) as never,
	});

const req = (context: Record<string, unknown>): PolicyRequest => ({
	principal: { type: "User", id: "alice" },
	action: { type: "Action", id: "writeDoc" },
	resource: { type: "Tool", id: "writeDoc" },
	context,
});

/** Every attribute present, and the run in the state the floor exists to gate: nobody confirmed it
 *  and no human is watching. */
function fullContext(): Record<string, unknown> {
	const context: Record<string, unknown> = {
		confirmationUsed: false,
		runMode: "autonomous",
	};
	for (const { key, sample } of optionalContextAttributes()) {
		if (!(key in context)) context[key] = sample;
	}
	return context;
}

describe("the sealed floor under a context that is missing an attribute", () => {
	it("gates the write when every attribute is present (the baseline this sweep is measured against)", async () => {
		// Not a formality. If this came back `permit`, every case below would pass for the wrong
		// reason — there would be no gate left to lose.
		const result = await engine().authorize(req(fullContext()));
		expect(result.decision).toBe("needs-approval");
	});

	it.each(
		optionalContextAttributes(),
	)("still gates the write when $key is absent", async ({ key }) => {
		// THE PROPERTY: dropping an OPTIONAL attribute may make a decision no more permissive than
		// it was with the attribute present. Optional means the stamping layer is allowed not to
		// supply it, so every one of these contexts is a legal request.
		//
		// `runMode` is the one the floor reads directly, and its absence is expected to take the
		// forbid down with it — leaving `customer:allow-writes` to decide, which is a silent,
		// unconfirmed, unattended write. The others are swept because the cost of sweeping them is
		// one line and the cost of missing the next one is this same bug again.
		const context = fullContext();
		delete context[key];
		const result = await engine().authorize(req(context));
		expect(result.decision).not.toBe("permit");
	});

	it("does not let a missing runMode turn an unattended write into a silent permit", async () => {
		// The property above, written out once as the concrete scenario, so a failure reads as a
		// security finding rather than as a parametrised row.
		//
		// A customer slice permits writes. The floor's `forbid ... unless { context.confirmationUsed
		// || context.runMode == "interactive" }` is what keeps that permit from applying to an
		// unattended run. With `runMode` absent the condition errors, the forbid is skipped, and the
		// customer permit stands alone — the write executes with no human and no confirmation, and
		// the decision trail names only the permit, because the forbid never ran to be recorded.
		const result = await engine().authorize(
			req({ confirmationUsed: false, scopes: [], roles: [], facts: [] }),
		);
		expect(result.decision).toBe("needs-approval");
	});

	it("keeps a read permitted with an empty context — the floor's other half is genuinely unconditional", async () => {
		// The control. `floor:reads-run` reads no context at all, so it must be indifferent to all of
		// this. A failure here would mean the sweep is measuring something other than what it claims.
		const e = engine();
		const result = await e.authorize({
			principal: { type: "User", id: "alice" },
			action: { type: "Action", id: "readDoc" },
			resource: { type: "Tool", id: "readDoc" },
			context: {},
		});
		expect(result.decision).toBe("permit");
	});
});
