import { type } from "arktype";
import {
	nonEmptyString,
	skillAclRecord,
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
}).or({
	id: "string",
	installation: skillInstallationRecord,
	kind: "'installed'",
	manifest: skillManifest,
	package: skillPackageRecord,
	read: skillReadRecord,
});

// A personal skill needs only its creator — the installation lands in the personal:createdBy
// boundary (no organization anywhere; org is additive).
export const createPersonalSkillInput = type({
	createdBy: nes,
	digest: nes,
	manifest: skillManifest,
	packageId: nes,
	"source?": "'local' | 'upload' | undefined",
	version: nes,
});

export const createPersonalSkillResult = type({
	grant: skillAclRecord,
	installation: skillInstallationRecord,
	package: skillPackageRecord,
	readGrant: skillAclRecord,
});

// Installed entries list ONE boundary at a time (exact single-scope, like the store); omit the
// pair to browse static skills only.
export const skillCatalogInput = type({
	"includeStatic?": "boolean | undefined",
	"publisher?": optionalNes,
	"source?": skillPackageSource.or("undefined"),
	"status?": skillInstallationStatus.or("undefined"),
	"scope?": optionalNes,
	"scopeId?": optionalNes,
});

export const skillCatalogEntry = type({
	allowedTools: stringArray,
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
});
