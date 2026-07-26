// The whole euroclaw API surface, mounted in one file.
//
// This is the entire server-side integration: one catch-all route, one call. It serves the base
// api methods (threads, messages, approvals, grants…), every plugin's api namespace, plugin/channel
// routes, and the cron trigger — plus `GET /api/euroclaw/openapi.json` because `openApi` is on.
//
// `resolveCaller` is not optional in practice: without it the PEP has no authenticated identity
// and every governed call fails closed with a 403.

import { toNextJsHandler } from "@euroclaw/adapter-nextjs";
import { claw } from "@/lib/claw";
import { resolveCaller } from "@/lib/session";

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(claw, {
	basePath: "/api/euroclaw",
	openApi: true,
	resolveCaller,
});
