// What `euroclaw db generate` / `euroclaw db migrate` read.
//
// The same `clawConfig` the app assembles, over the UNPOOLED connection: Neon's pooler runs
// PgBouncer in transaction mode, which is the wrong shape for DDL. Nothing else differs, so the
// tables this migrates are by construction the tables the app expects.
//
// The CLI finds this file by name, loads `.env` / `.env.local` first, and reads `config`.

import { clawConfig, migrationConnectionString } from "./lib/euroclaw-config";

export const config = clawConfig(migrationConnectionString());
