import type { Principal, TurnContext } from "@euroclaw/contracts";
import type { SkillManifest, SkillsStore } from "../core";
import type {
	activateSkillContext,
	activateSkillInput,
	activeSkillRef,
	readSkillContext,
	readSkillInput,
} from "./schema";

export type { SkillManifest } from "../core";

export type SkillId<Skills extends readonly SkillManifest[]> = Extract<
	Skills[number]["id"],
	string
>;

export type ActiveSkillRef = typeof activeSkillRef.infer;

export type ActiveSkillSelection =
	| "all"
	| "recorded"
	| readonly ActiveSkillRef[]
	| undefined;

export type ActiveSkillResolver = (
	ctx: TurnContext,
) => ActiveSkillSelection | Promise<ActiveSkillSelection>;

export type ActivateSkillInput = typeof activateSkillInput.infer;
// `activatedBy`/`readBy` carry the branded `Principal` the host constructs — the arktype narrow
// validates the form but infers a bare `string`, so rebrand the deciding field here (the assert
// re-establishes the brand via `asPrincipal`). teamId/organizationId stay boundary refs.
export type ActivateSkillContext = Omit<
	typeof activateSkillContext.infer,
	"activatedBy"
> & { activatedBy: Principal };
export type ReadSkillInput = typeof readSkillInput.infer;
export type ReadSkillContext = Omit<
	typeof readSkillContext.infer,
	"readBy"
> & { readBy: Principal };

export type ActivateSkillContextResolver = (
	input: ActivateSkillInput,
) => ActivateSkillContext | Promise<ActivateSkillContext>;

export type ReadSkillContextResolver = (
	input: ReadSkillInput,
) => ReadSkillContext | Promise<ReadSkillContext>;

export type SkillsApiOptions = {
	/** Trusted activation principal/organization. Not read from ActivateSkillInput. */
	activationContext?: ActivateSkillContext | ActivateSkillContextResolver;
	/** Trusted read principal/organization. Not read from ReadSkillInput. */
	readContext?: ReadSkillContext | ReadSkillContextResolver;
	/** Static manifests contributed by composition; catalog only exposes compact metadata. */
	staticSkills?: readonly SkillManifest[];
};

export type SkillsPluginConfig<
	Skills extends readonly SkillManifest[] = readonly SkillManifest[],
> = {
	/** Plugin id. Defaults to "euroclaw.skills". */
	id?: string;
	/**
	 * Opt in to the subtractive allowed-tools gate: when `true`, a tool call is denied unless an
	 * active skill lists it in `allowedTools`. Default `false` — skills are additive, so installing
	 * this plugin does not restrict the tool surface; tool authorization stays the policy engine's
	 * job. Turn this on only to use skills as an extra capability-attenuation layer.
	 */
	enforceAllowedTools?: boolean;
	/** Gate id. Defaults to "skills:allowed-tools". Only used when `enforceAllowedTools` is on. */
	gateId?: string;
	/** Skill manifests installed for this composition. */
	skills: Skills;
	/** Active skills for a run. Omit or use "recorded" to resolve durable activations when a store exists. */
	active?:
		| "all"
		| "recorded"
		| readonly (SkillId<Skills> | ActiveSkillRef)[]
		| ActiveSkillResolver;
	/** Trusted principal/organization for claw.api.skills.activate. */
	activationContext?: SkillsApiOptions["activationContext"];
	/** Trusted principal/organization for claw.api.skills.read. */
	readContext?: SkillsApiOptions["readContext"];
	/** The allowed-tools gate is sealed by default. */
	sealed?: boolean;
	/** Optional explicit store. Needed for DB-backed skills and skills API data methods. */
	store?: SkillsStore;
};
