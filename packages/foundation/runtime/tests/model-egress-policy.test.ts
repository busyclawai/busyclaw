import { describe, it } from "vitest";

describe("runtime model egress policy", () => {
	it.todo(
		"routes to a fallback model when routing exists and primary egress is denied",
	);
	it.todo(
		"records an appealable model-egress denial for host-managed exception review",
	);
	it.todo(
		"retries a run only after a policy exception is visible to the model boundary gate",
	);
	it.todo(
		"scopes model-egress exceptions by organization, provider, model, and redacted prompt hash",
	);
	it.todo(
		"never treats a model-egress exception as a direct runtime resume approval",
	);
	it.todo("persists only redacted exception-review data and never raw PII");
});
