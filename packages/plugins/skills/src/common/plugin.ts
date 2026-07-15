import type { Adapter } from "@euroclaw/contracts";
import {
	configurationError,
	defineReasonCodes,
	type EuroclawPlugin,
	type EuroclawPluginConfigureContext,
	type EuroclawPluginRuntime,
	type GateDecision,
	type ToolCall,
	type TurnContext,
} from "@euroclaw/contracts";
import { type SkillsStore, skillsModels } from "../core";
import { createSkillsStore } from "../store/store";
import type {
	ActiveSkillRef,
	SkillManifest,
	SkillsApiOptions,
	SkillsPluginConfig,
} from "./contracts";
import { assertSkillManifests } from "./manifest";
import { parseActiveSkillSelection, refLabel } from "./refs";
import { isReservedToolName } from "./reserved";
import { recordedActiveSkillRefs, resolveActiveSkill } from "./resolution";

export const skillReasonCodes = defineReasonCodes({
	ACTIVE_SKILL_FORBIDDEN: "The actor cannot activate this skill.",
	ACTIVE_SKILL_OUT_OF_SCOPE:
		"An active skill lives in a boundary this context cannot stand inside.",
	ACTIVE_SKILL_UNAVAILABLE: "An active skill is not enabled or trusted.",
	NO_ACTIVE_SKILL: "No active skill permits this tool call.",
	SKILL_TOOL_NOT_ALLOWED: "The active skills do not permit this tool.",
	UNKNOWN_ACTIVE_SKILL: "An active skill is not installed.",
});

function deny(
	reasonCode: keyof typeof skillReasonCodes,
	reason: string,
): GateDecision {
	return { decision: "deny", reason, reasonCode };
}

/** Narrow the resolved adapter the assembly passes through the configure context's index signature. */
export function contextAdapter(context: unknown): Adapter | undefined {
	if (context === null || typeof context !== "object") return undefined;
	const value = (context as { adapter?: unknown }).adapter;
	if (value === null || typeof value !== "object") return undefined;
	return value as Adapter;
}

export function requireSkillsStore(
	store: SkillsStore | undefined,
): SkillsStore {
	if (!store) {
		throw configurationError("claw.api.skills requires a SkillsStore", {
			reason:
				"pass database, stores.skills, or an explicit store to skillsPlugin",
		});
	}
	return store;
}

export type SkillsApiFactory<TApi> = (
	store: SkillsStore | undefined,
	options: SkillsApiOptions,
) => TApi;

/**
 * Shared plugin shell: active-skill resolution plus the opt-in allowed-tools gate. Both the simple
 * plugin and the governed plugin build on this, differing only in the api surface produced by
 * `apiFactory`.
 */
export function buildSkillsPlugin<
	const Skills extends readonly SkillManifest[],
	TApi,
>(
	config: SkillsPluginConfig<Skills>,
	apiFactory: SkillsApiFactory<TApi>,
): EuroclawPlugin<"no-cron", readonly string[], { readonly skills: TApi }> & {
	readonly $Infer?: { readonly skills: Skills[number] };
} {
	const skills = assertSkillManifests(config.skills);
	const skillById = new Map<string, SkillManifest>();
	for (const skill of skills) {
		if (skillById.has(skill.id)) {
			throw configurationError("duplicate skill id", { skillId: skill.id });
		}
		skillById.set(skill.id, skill);
	}
	const allSkillIds = skills.map((skill) => skill.id);
	const staticActiveSelection =
		typeof config.active === "function" ? undefined : config.active;
	const staticActive =
		staticActiveSelection === undefined || staticActiveSelection === "recorded"
			? undefined
			: parseActiveSkillSelection(staticActiveSelection, allSkillIds);

	// The skills store rides a mutable slot: a host-supplied `config.store` wins, else `configure`
	// builds one from the adapter. Both the allowed-tools GATE (a static decide-gate, so it cannot be
	// returned from configure) and the api read it — the same two-role capture the secret-store
	// provider uses. No adapter and no host store ⇒ the slot stays undefined and only static skills
	// resolve. `configure` fills it and returns the api as the runtime half; nothing rebuilds the plugin.
	let store = config.store;

	const resolveActiveSkillRefs = async (
		ctx: TurnContext,
	): Promise<ActiveSkillRef[]> => {
		if (typeof config.active !== "function") {
			return staticActive ?? recordedActiveSkillRefs({ ctx, store });
		}
		const selection = await config.active(ctx);
		return selection === undefined || selection === "recorded"
			? recordedActiveSkillRefs({ ctx, store })
			: parseActiveSkillSelection(selection, allSkillIds);
	};
	const configure = (
		context: EuroclawPluginConfigureContext,
	): EuroclawPluginRuntime<{ readonly skills: TApi }> | undefined => {
		// Core stays skills-agnostic: the assembly passes the resolved adapter through the configure
		// context's index signature, and this plugin builds its OWN store from it — nothing outside this
		// package creates a skills store. A host-supplied store already filled the slot; otherwise build
		// one from the adapter (absent ⇒ static-only skills). The api reads the slot at call time.
		if (!store) {
			const adapter = contextAdapter(context);
			if (adapter) store = createSkillsStore(adapter);
		}
		return {
			api: () => ({
				skills: apiFactory(store, {
					activationContext: config.activationContext,
					readContext: config.readContext,
					staticSkills: skills,
				}),
			}),
		};
	};

	// The subtractive allowed-tools gate: a tool is denied unless an active skill lists it. Skills
	// are additive by default (skills-plan-v2), so this gate is OPT-IN via `enforceAllowedTools` —
	// off by default, installing the plugin never restricts the tool surface. Reserved meta-tools
	// are always exempt (they bootstrap activation). When on, it is sealed by default.
	const allowedToolsGate = {
		id: config.gateId ?? "skills:allowed-tools",
		sealed: config.sealed ?? true,
		matcher: (call: ToolCall) => !isReservedToolName(call.name),
		handler: async (
			call: ToolCall,
			ctx: TurnContext,
		): Promise<GateDecision> => {
			const activeSkillRefs = await resolveActiveSkillRefs(ctx);
			if (activeSkillRefs.length === 0) {
				return deny(
					"NO_ACTIVE_SKILL",
					`tool "${call.name}" denied because no skills are active`,
				);
			}

			const allowedTools = new Set<string>();
			const activeLabels: string[] = [];
			for (const ref of activeSkillRefs) {
				activeLabels.push(refLabel(ref));
				const resolution = await resolveActiveSkill({
					ctx,
					ref,
					skillById,
					store,
				});
				if (resolution.status === "out_of_scope") {
					return deny(
						"ACTIVE_SKILL_OUT_OF_SCOPE",
						`active skill "${refLabel(ref)}" is outside this context's boundaries`,
					);
				}
				if (resolution.status === "unavailable") {
					return deny(
						"ACTIVE_SKILL_UNAVAILABLE",
						`active skill "${refLabel(ref)}" is not enabled or trusted`,
					);
				}
				if (resolution.status === "forbidden") {
					return deny(
						"ACTIVE_SKILL_FORBIDDEN",
						`active skill "${refLabel(ref)}" cannot be activated by this context`,
					);
				}
				if (resolution.status === "missing") {
					return deny(
						"UNKNOWN_ACTIVE_SKILL",
						`active skill "${refLabel(ref)}" is not installed`,
					);
				}
				for (const toolName of resolution.manifest.allowedTools ?? [])
					allowedTools.add(toolName);
			}

			if (allowedTools.has(call.name)) return { decision: "permit" };
			return deny(
				"SKILL_TOOL_NOT_ALLOWED",
				`tool "${call.name}" is not allowed by active skills: ${activeLabels.join(", ")}`,
			);
		},
	};

	return {
		id: config.id ?? "euroclaw.skills",
		$HasCron: "no-cron",
		$Api: {} as { readonly skills: TApi },
		$Infer: {} as { readonly skills: Skills[number] },
		$REASON_CODES: skillReasonCodes,
		// The tables this plugin owns — collected by getEuroclawTables into the migration schema. The
		// same models back the skills store, so registering the plugin is what puts skills on disk.
		schema: skillsModels,
		// Skills is the FIRST plugin consumer of the shareable-resource loader registry (app-authz slice
		// 5, docs/plans/app-authz.md §6): registering `{ kind: "skill", load }` teaches the product-api
		// PEP how to load a skill installation's base row, so a skill installation presents the generic
		// `{ createdBy, scope, scopeId }` shape and is OWNER-isolated through the same generic decision as
		// a claw — with ZERO core change, proving the registry is plugin-extensible. The loader binds its
		// store the same way `configure` does (host store, else the adapter). NOTE (scope of slice 5): this
		// registers the LOADER only (owner-isolation); the `skill_acl` → `access_grant` grant-data
		// migration + retiring `hasSkillGrant` is a clean follow-up — skills' own activation/read gate
		// still routes through skill_acl (a different, runtime TurnContext surface) until then.
		shareable: [
			{
				kind: "skill",
				load: (loaderContext) => {
					const loaderStore =
						config.store ??
						(loaderContext.adapter
							? createSkillsStore(loaderContext.adapter)
							: undefined);
					return async (id) => {
						if (!loaderStore) return null;
						const installation = await loaderStore.installations.get(id);
						return installation
							? {
									createdBy: installation.createdBy,
									scope: installation.scope,
									scopeId: installation.scopeId,
								}
							: null;
					};
				},
			},
		],
		// The api is the RUNTIME half — `configure` returns it, closing over the store slot it fills.
		configure,
		gates: config.enforceAllowedTools ? [allowedToolsGate] : [],
	};
}
