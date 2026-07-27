# @busyclaw/cli

```bash
busyclaw db generate    # emit the schema your config declares
busyclaw db migrate     # apply it (SQL targets only)
```

## Why it exists

busyclaw declares its durable tables in one place — the entity field maps — and projects them two
ways: `getBusyclawModels` feeds the entity-validating adapter, `getBusyclawTables` feeds this CLI.
One declaration, two projections, so a column cannot exist in the validator and be missing from the
database.

## Pointing it at your app

It reads either shape, checking `claw`, `config`, `busyclawConfig`, then the default export:

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

Without `--config` it searches `busyclaw.config.{ts,js,mjs}`, `lib/busyclaw.ts`, `src/lib/busyclaw.ts`,
`app/lib/busyclaw.ts`, `lib/claw.ts`, `src/lib/claw.ts`. TypeScript modules load through jiti, so no
build step is needed.

## Targets

`generate` emits for whichever adapter your config uses — inferred from `database`, or forced with
`--target`. The generator for each lives in that adapter's own package, not here.

| target | emits | who migrates |
|---|---|---|
| `sql` | the DDL that reconciles a live database, diffed | `busyclaw db migrate` |
| `drizzle` | a Drizzle schema module (`--provider pg\|sqlite`) | `drizzle-kit` |
| `prisma` | Prisma models, without your `datasource`/`generator` blocks | `prisma migrate` |
| `kysely` | the `Database` interface + row types (`--dialect`) | — (types only) |

`kysely` is the one target that is not about migrating. It gives a Kysely user what the other two
ORMs hand out for free: types to query through. `kysely-codegen` derives those by introspecting a
live database; deriving them from the declaration instead needs no connection and cannot drift from
what the runtime validates. Hand the result to `new Kysely<Database>({ … })`.

An adapter reporting `kysely` infers `sql`, not `kysely` — the tables have to exist before anything
can query them, so ask for types as a deliberate second step.

`drizzle` and `prisma` print the **whole** schema and never connect — so they work in CI with no
database and no credentials. Only `sql` diffs, because nothing else owns migration history for a raw
SQL setup; where drizzle-kit and prisma-migrate already do, this hands off to them.

## What it will and won't do

**Additive only.** Missing tables are created and missing columns added. Nothing is ever dropped,
renamed, or retyped — a column whose type has drifted from the declaration is reported and left
alone, because silently rewriting a live column's type is how data disappears.

**Idempotent.** A second run against an unchanged database plans nothing, so it is safe in a deploy
step — and writes no file, so the migrations directory gains an entry only when something changed.

**SQL accumulates; schemas are replaced.** `--target sql` writes a new timestamped file under
`./busyclaw_migrations/`, because each one is a *delta* against the database as it was — the files
are the history, and overwriting one would discard the record of what already shipped. A Drizzle or
Prisma schema is a *snapshot* of current truth, so it overwrites in place.

**It asks first.** `migrate` prompts unless you pass `--yes`, and a non-interactive shell answers
*no* — a migration that ran because nobody was there to decline is not one anyone approved.

## Options

| | |
|---|---|
| `-c, --config <path>` | the config module, if it isn't in a searched location |
| `-d, --dialect <postgres\|sqlite>` | inferred from a pg Pool or better-sqlite3 Database; required for a bare Kysely instance or Dialect, and for `--target kysely` |
| `-t, --target <target>` | `sql` \| `drizzle` \| `prisma` \| `kysely` — inferred from your adapter |
| `-p, --provider <pg\|sqlite>` | required for `--target drizzle` |
| `-o, --output <path>` | where `generate` writes (default: `./busyclaw_migrations/<stamp>.sql` for sql, one file per target otherwise) |
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
- **A table with no declared primary key still generates.** SQL creates it keyless; Prisma, which
  requires every model to carry an identifier, gets `@@ignore` and a warning — the model is absent
  from the generated client. No core table is in that state (the PII vault's
  `(placeholder, scope, scopeId)` key is declared), but a plugin may declare one, so the escape hatch
  stays rather than failing the generate.
