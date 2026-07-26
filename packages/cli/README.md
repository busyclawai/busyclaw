# @euroclaw/cli

```bash
euroclaw db generate    # emit the schema your config declares
euroclaw db migrate     # apply it (SQL targets only)
```

## Why it exists

euroclaw declares its durable tables in one place — the entity field maps — and projects them two
ways: `getEuroclawModels` feeds the entity-validating adapter, `getEuroclawTables` feeds this CLI.
One declaration, two projections, so a column cannot exist in the validator and be missing from the
database.

## Pointing it at your app

It reads either shape, checking `claw`, `config`, `euroclawConfig`, then the default export:

```ts
// lib/claw.ts — the module your app already has
export const claw = createClaw({ model, database, plugins, redaction });
```

Reading the assembled claw uses `claw.$tables` (the merged declaration, computed on first read).
Because the claw holds a *resolved* storage Adapter rather than the connection it was built from,
export the config beside it when you want `migrate` to connect:

```ts
export const config = { model, database, plugins, redaction };
export const claw = createClaw(config);
```

Without `--config` it searches `euroclaw.config.{ts,js,mjs}`, `lib/euroclaw.ts`, `src/lib/euroclaw.ts`,
`app/lib/euroclaw.ts`, `lib/claw.ts`, `src/lib/claw.ts`. TypeScript modules load through jiti, so no
build step is needed.

## Targets

`generate` emits for whichever adapter your config uses — inferred from `database`, or forced with
`--target`. The generator for each lives in that adapter's own package, not here.

| target | emits | who migrates |
|---|---|---|
| `sql` | the DDL that reconciles a live database, diffed | `euroclaw db migrate` |
| `drizzle` | a Drizzle schema module (`--provider pg\|sqlite`) | `drizzle-kit` |
| `prisma` | Prisma models, without your `datasource`/`generator` blocks | `prisma migrate` |

`drizzle` and `prisma` print the **whole** schema and never connect — so they work in CI with no
database and no credentials. Only `sql` diffs, because nothing else owns migration history for a raw
SQL setup; where drizzle-kit and prisma-migrate already do, this hands off to them.

## What it will and won't do

**Additive only.** Missing tables are created and missing columns added. Nothing is ever dropped,
renamed, or retyped — a column whose type has drifted from the declaration is reported and left
alone, because silently rewriting a live column's type is how data disappears.

**Idempotent.** A second run against an unchanged database plans nothing, so it is safe in a deploy
step.

**It asks first.** `migrate` prompts unless you pass `--yes`, and a non-interactive shell answers
*no* — a migration that ran because nobody was there to decline is not one anyone approved.

## Options

| | |
|---|---|
| `-c, --config <path>` | the config module, if it isn't in a searched location |
| `-d, --dialect <postgres\|sqlite>` | inferred from a pg Pool or better-sqlite3 Database; required for a bare Kysely instance or Dialect, which carry no tag |
| `-o, --output <path>` | where `generate` writes (default `euroclaw.sql`) |
| `-y, --yes` | skip `migrate`'s confirmation |

## Known limits

- **`migrate` is Kysely only.** Applying DDL needs a live connection plus introspection; for the
  other two, their own tooling owns migration history and is better at it.
- **`--target sql` connects**, because it diffs to emit only what is missing. A full SQL baseline
  with no connection is not wired yet (the other two targets need no connection at all).
- **Drizzle `mysql` is unmapped.** The adapter declares the provider; the generator refuses it rather
  than emit an unverified column map.
- **`number` becomes `double precision` / `real` / `Float`.** The declaration has one numeric type,
  so there is no integer/bigint distinction to carry; floating point is the only lossless choice for
  a type that also has to hold confidence scores.
- **`pii_mapping` and `pii_subject` declare no primary key.** Their real key is
  `(placeholder, scope, scopeId)`, but `scope`/`scopeId` are nullable while the container-less
  redaction state exists, and a primary key cannot contain NULL — see the note in
  `contracts/src/governance/redact.ts`. SQL creates them keyless; Prisma, which requires every model
  to carry an identifier, gets them as `@@ignore`, so euroclaw's PII vault cannot run on Prisma until
  that key exists.
