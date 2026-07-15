import { type } from "arktype";
import {
	nonEmptyString,
	skillInstallationRecord,
	skillInstallationStatus,
	skillManifest,
	skillPackageRecord,
	skillPackageSource,
	skillReadRecord,
} from "../core";

const stringArray = type("string").array();
const nes = nonEmptyString;
const optionalNes = nonEmptyString.or("undefined");

export const readSkillResult = type({
	id: "string",
	kind: "'static'",
	manifest: skillManifest,
	"read?": skillReadRecord.or("undefined"),
})
	.or({
		id: "string",
		installation: skillInstallationRecord,
		kind: "'installed'",
		manifest: skillManifest,
		package: skillPackageRecord,
		read: skillReadRecord,
	})
	.configure({
		euroclaw: {
			doc: "Reading a skill WRITES a read-audit row. Discriminated on `kind`: the 'static' branch carries only the manifest, and its audit row is recorded only when both a store and a readContext are configured (hence optional); the 'installed' branch also resolves the installation and package and always records the audit row. `id` echoes the manifest/logical skill id, never an installation or package row id.",
		},
	});

// A personal skill needs only its creator — the installation lands in the personal:createdBy
// boundary (no organization anywhere; org is additive).
export const createPersonalSkillInput = type({
	createdBy: nes.configure({
		euroclaw: {
			doc: "Branded to a Principal and used three ways: package publisher, the installation's createdBy/enabledBy stamp, and the grantee of the auto-issued activate and read grants. The installation lands in the personal:createdBy boundary.",
		},
	}),
	digest: nes.configure({
		euroclaw: {
			doc: "Caller-supplied content digest stored on the package as-is; not recomputed or verified here.",
		},
	}),
	manifest: skillManifest.configure({
		euroclaw: {
			doc: "Re-validated through assertSkillManifest after the schema parse to enforce the reserved euroclaw__ tool-name rule the arktype schema cannot express.",
		},
	}),
	packageId: nes.configure({
		euroclaw: {
			doc: "Logical package id, stable across versions — distinct from the generated package row id.",
		},
	}),
	"source?": type("'local' | 'upload' | undefined").configure({
		euroclaw: { doc: "Defaults to 'local' when omitted." },
	}),
	version: nes,
});

export const createPersonalSkillResult = type({
	installation: skillInstallationRecord.configure({
		euroclaw: {
			doc: "Created directly with status 'enabled', bypassing the installed→trusted→enabled ladder used for governed installs. No grant rows are minted — the runtime gate's owner-rule (installation.createdBy === caller) authorizes the installer to activate and read it.",
		},
	}),
	package: skillPackageRecord,
});

// Installed entries list ONE boundary at a time (exact single-scope, like the store); omit the
// pair to browse static skills only.
export const skillCatalogInput = type({
	"includeStatic?": type("boolean | undefined").configure({
		euroclaw: {
			doc: "Only an explicit `false` suppresses static skills; undefined or true includes options.staticSkills.",
		},
	}),
	"publisher?": optionalNes.configure({
		euroclaw: {
			doc: "Post-filter on the resolved package.publisher of installed entries only.",
		},
	}),
	"source?": skillPackageSource.or("undefined").configure({
		euroclaw: {
			doc: "Post-filter on the resolved package.source of installed entries only.",
		},
	}),
	"status?": skillInstallationStatus.or("undefined").configure({
		euroclaw: {
			doc: "Passed to installations.listForScope as the lifecycle-status filter.",
		},
	}),
	"scope?": optionalNes.configure({
		euroclaw: {
			doc: "Installed entries need BOTH scope and scopeId; if either is absent the catalog lists static skills only. Lists exactly one boundary — no hierarchy walk.",
		},
	}),
	"scopeId?": optionalNes,
});

export const skillCatalogEntry = type({
	allowedTools: stringArray.configure({
		euroclaw: { doc: "Defaults to [] when the manifest omits it." },
	}),
	description: "string",
	"digest?": "string | undefined",
	id: "string",
	kind: "'static' | 'installed'",
	"name?": "string | undefined",
	"packageId?": "string | undefined",
	"publisher?": "string | undefined",
	"source?": skillPackageSource.or("undefined"),
	"installationId?": "string | undefined",
	"status?": skillInstallationStatus.or("undefined"),
	"scope?": "string | undefined",
	"scopeId?": "string | undefined",
	"version?": "string | undefined",
}).configure({
	euroclaw: {
		doc: "Static entries carry only id/name/description/allowedTools; installed entries additionally populate installationId, status, scope/scopeId and the resolved package fields (digest, packageId, publisher, source, version).",
	},
});
