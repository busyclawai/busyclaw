import { describe, expect, it } from "vitest";
import { authzBundleKey, loadPolicyBundle } from "../src/index";

// The bundle is a NAMED set (name → cedar text): a slice is identified by the name it is MANAGED by,
// which is what reaches the determining-policy trail and the compliance audit.
const SYSTEM = {
	"floor:reads": `permit(principal, action in Action::"reads", resource);`,
};

describe("loadPolicyBundle", () => {
	it("enforce slices merge into live under their own name; no shadow slice ⇒ shadow undefined", () => {
		const bundle = loadPolicyBundle({
			system: SYSTEM,
			slices: [{ name: "a", cedar: "ENFORCE_A", mode: "enforce" }],
		});
		expect(bundle.live).toEqual({ ...SYSTEM, a: "ENFORCE_A" });
		expect(bundle.shadow).toBeUndefined(); // no candidate ⇒ the host skips the second engine
	});

	it("no slices ⇒ live is exactly the system posture", () => {
		const bundle = loadPolicyBundle({ system: SYSTEM, slices: [] });
		expect(bundle.live).toEqual(SYSTEM);
		expect(bundle.shadow).toBeUndefined();
	});

	it("a shadow slice yields a distinct candidate (live + shadow); live EXCLUDES it", () => {
		const bundle = loadPolicyBundle({
			system: SYSTEM,
			slices: [
				{ name: "enf", cedar: "ENFORCE_E", mode: "enforce" },
				{ name: "shd", cedar: "SHADOW_S", mode: "shadow" },
			],
		});
		expect(bundle.live).toEqual({ ...SYSTEM, enf: "ENFORCE_E" });
		expect(bundle.live.shd).toBeUndefined(); // shadow is a candidate, never live
		expect(bundle.shadow).toEqual({
			...SYSTEM,
			enf: "ENFORCE_E", // candidate = live …
			shd: "SHADOW_S", // … plus the shadow slice
		});
	});

	it("off slices are dropped from both live and the candidate", () => {
		const bundle = loadPolicyBundle({
			system: SYSTEM,
			slices: [{ name: "off1", cedar: "OFF_O", mode: "off" }],
		});
		expect(bundle.live).toEqual(SYSTEM);
		expect(bundle.shadow).toBeUndefined();
	});

	it("off + shadow together: off dropped, the shadow candidate still forms", () => {
		const bundle = loadPolicyBundle({
			system: SYSTEM,
			slices: [
				{ name: "off", cedar: "OFF_O", mode: "off" },
				{ name: "shd", cedar: "SHADOW_S", mode: "shadow" },
			],
		});
		expect(bundle.live).toEqual(SYSTEM); // both off and shadow are excluded from live
		expect(bundle.shadow).toEqual({ ...SYSTEM, shd: "SHADOW_S" });
	});

	it("a slice may NOT reuse a floor rule's name — a keyed merge would REPLACE the seal", () => {
		expect(() =>
			loadPolicyBundle({
				system: SYSTEM,
				slices: [{ name: "floor:reads", cedar: "OVERRIDE", mode: "enforce" }],
			}),
		).toThrow(/duplicate policy slice name: floor:reads/);
	});

	it("two slices may not share a name — they'd be indistinguishable in the audit", () => {
		expect(() =>
			loadPolicyBundle({
				system: SYSTEM,
				slices: [
					{ name: "dup", cedar: "A", mode: "enforce" },
					{ name: "dup", cedar: "B", mode: "shadow" },
				],
			}),
		).toThrow(/duplicate policy slice name: dup/);
	});
});

describe("authzBundleKey", () => {
	it("count 0 ⇒ the shared 'system' bundle (an uncustomized org)", () => {
		expect(authzBundleKey({ organizationId: "org-a", changeCount: 0 })).toBe(
			"system",
		);
	});

	it("an absent organizationId ⇒ 'system'", () => {
		expect(authzBundleKey({ organizationId: undefined, changeCount: 5 })).toBe(
			"system",
		);
	});

	it("a positive count ⇒ `org:count`", () => {
		expect(authzBundleKey({ organizationId: "org-a", changeCount: 3 })).toBe(
			"org-a:3",
		);
	});

	it("the same count ⇒ the same key (a cache hit); a bump ⇒ a new key (rebuild)", () => {
		const at3 = authzBundleKey({ organizationId: "org-a", changeCount: 3 });
		expect(authzBundleKey({ organizationId: "org-a", changeCount: 3 })).toBe(
			at3,
		);
		// A delete or edit APPENDS to the log → the count bumps → a distinct key → the router rebuilds.
		expect(
			authzBundleKey({ organizationId: "org-a", changeCount: 4 }),
		).not.toBe(at3);
	});

	it("org isolation: different orgs at the same count get different keys", () => {
		expect(
			authzBundleKey({ organizationId: "org-a", changeCount: 2 }),
		).not.toBe(authzBundleKey({ organizationId: "org-b", changeCount: 2 }));
	});
});
