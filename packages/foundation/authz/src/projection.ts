// The JSON-Schema → Cedar projection: LOSSY-BUT-SAFE. Policies may only condition on what
// projects cleanly to Cedar's type system; everything else is opaque to policy (dropped from the
// rendered schema AND filtered out of the request context, by the same walker — the two must
// never disagree, or `validateRequest` rejects legitimate calls).
//
// Rules (v1):
//   string / string-enum → String        boolean → Bool        integer → Long
//   number (float)       → DROPPED — Long would silently truncate comparisons; declare
//                          policy-visible amounts as integers (cents), which is also correct
//                          money practice
//   array<projectable>   → Set<T>
//   object               → closed Record of its projectable props (recursive)
//   unions / $ref / anything else → DROPPED

import type { JsonObject, JsonValue } from "@busyclaw/contracts";

export type ProjectedShape =
	| { kind: "string" }
	| { kind: "bool" }
	| { kind: "long" }
	| { kind: "set"; of: ProjectedShape }
	| {
			kind: "record";
			props: ReadonlyMap<string, { shape: ProjectedShape; required: boolean }>;
	  };

function asObject(value: JsonValue | undefined): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value
		: undefined;
}

function projectShape(schema: JsonObject): ProjectedShape | undefined {
	const type = schema.type;
	if (type === "string") return { kind: "string" };
	if (type === "boolean") return { kind: "bool" };
	if (type === "integer") return { kind: "long" };
	if (type === "array") {
		const items = asObject(schema.items);
		const of = items ? projectShape(items) : undefined;
		return of ? { kind: "set", of } : undefined;
	}
	if (type === "object") {
		const properties = asObject(schema.properties);
		if (!properties) return undefined;
		const required = new Set(
			Array.isArray(schema.required)
				? schema.required.filter((r): r is string => typeof r === "string")
				: [],
		);
		const props = new Map<
			string,
			{ shape: ProjectedShape; required: boolean }
		>();
		for (const [name, propSchema] of Object.entries(properties)) {
			const prop = asObject(propSchema);
			const shape = prop ? projectShape(prop) : undefined;
			if (shape) props.set(name, { shape, required: required.has(name) });
		}
		return props.size > 0 ? { kind: "record", props } : undefined;
	}
	// number (float), unions, $ref, const, … — not safely expressible; opaque to policy.
	return undefined;
}

/** Quote a string for Cedar schema text. Names can come from UNTRUSTED schemas (an uploaded
 *  spec's property names) — unescaped quotes would inject into the rendered schema. */
export function cedarQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Render a projected shape as Cedar schema type text. */
export function renderCedarType(shape: ProjectedShape): string {
	switch (shape.kind) {
		case "string":
			return "String";
		case "bool":
			return "Bool";
		case "long":
			return "Long";
		case "set":
			return `Set<${renderCedarType(shape.of)}>`;
		case "record": {
			const fields = [...shape.props.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(
					([name, p]) =>
						`${cedarQuote(name)}${p.required ? "" : "?"}: ${renderCedarType(p.shape)}`,
				);
			return `{${fields.join(", ")}}`;
		}
	}
}

/** Filter a runtime value down to the projected shape: records drop unknown keys (Cedar records
 *  are closed — an undeclared attr fails request validation), recursively. Leaf VALUES pass
 *  through untouched; Cedar's own request validation judges them. */
function filterToShape(shape: ProjectedShape, value: JsonValue): JsonValue {
	if (shape.kind === "record") {
		const obj = asObject(value);
		if (!obj) return value;
		// fromEntries, not assignment: prop names come from untrusted schemas — "__proto__"
		// must become an own property of the filtered args, never a prototype mutation.
		const entries: [string, JsonValue][] = [];
		for (const [name, p] of shape.props) {
			const v = Object.hasOwn(obj, name) ? obj[name] : undefined;
			if (v !== undefined) entries.push([name, filterToShape(p.shape, v)]);
		}
		return Object.fromEntries(entries);
	}
	if (shape.kind === "set" && Array.isArray(value)) {
		return value.map((item) => filterToShape(shape.of, item));
	}
	return value;
}

export type ArgsProjection = {
	/** Cedar record type text for the action's `context.args`. */
	readonly cedarType: string;
	/** Filter runtime args to the projected subset (same walker as the render). */
	readonly filter: (args: JsonObject) => JsonObject;
};

/**
 * Project an action's arg schema (JSON Schema, an object at the top level) into its
 * policy-visible Cedar form. Returns undefined when nothing projects — the action then has no
 * `args` in its Cedar context, and the request filter sends none.
 */
export function projectArgs(schema: JsonObject): ArgsProjection | undefined {
	const shape = projectShape(schema);
	if (!shape || shape.kind !== "record") return undefined;
	return {
		cedarType: renderCedarType(shape),
		filter: (args) => {
			const filtered = filterToShape(shape, args);
			return asObject(filtered) ?? {};
		},
	};
}
