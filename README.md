# velocious-int-to-uuid

Safe, deliberately small staged integer-to-UUID migration helpers for MySQL/MariaDB Velocious applications.

The package covers three explicit phases:

- `plan.expand(migration)`: additive, idempotent creation of nullable UUID shadow columns and indexes.
- `plan.backfill(runner, options)` plus `plan.verifyBackfill(runner)`: deterministic RFC 4122 v5 backfill and read-only verification gates.
- `plan.planCutover({ legacyColumnPrefix })`: explicit canonical-name cutover and rollback planning that retains legacy integer columns for a rollback window.

The package still does not attempt generic MySQL/MariaDB primary-key swaps, foreign-key recreation, NOT NULL/unique rewrites, or destructive contract cleanup. Those steps are application-specific and must stay separately reviewed.

## Manifest and expand

`UuidKeyMigration.define(...)` remains explicit: every table must provide `references` and `polymorphic` arrays, using empty arrays when it has none, and the library never infers relationships. Every declared table receives `uuid_id` and an index. A reference named `author` receives `uuid_author_id` and a single-column index. A polymorphic relationship named `subject` receives `uuid_subject_id` and an index on `subject_type, uuid_subject_id`. Reference targets must be declared tables. Polymorphic discriminator-to-target mappings are explicit and one-to-one; duplicate discriminators or duplicate targets are rejected as ambiguous. Self-references are supported.

```js
import { UuidKeyMigration } from "velocious-int-to-uuid"

const plan = UuidKeyMigration.define({
  uuidStorage: { type: "varchar", length: 36 }, // optional; this is the only v0.1 representation
  tables: [
    {
      table: "users",
      references: [{ name: "manager", target: "users" }],
      polymorphic: []
    },
    {
      table: "comments",
      references: [{ name: "author", target: "users" }],
      polymorphic: [{
        name: "subject",
        typeColumn: "subject_type",
        mappings: [
          { type: "User", target: "users" },
          { type: "Comment", target: "comments" }
        ]
      }]
    }
  ]
})

export async function up(migration) {
  plan.validate()
  await plan.expand(migration)
}
```

The migration object is structural: it needs async or synchronous `columnExists(table, column)`, `indexExists(table, indexName)`, `addColumn(table, column, columnType, args)`, and `addIndex(table, columns, options)` methods. For every shadow column, the exact Velocious call is `addColumn(table, column, "string", { maxLength: 36, null: true })`, which Velocious represents as a nullable SQL `varchar(36)`. The package does not import Velocious internals at runtime. `velocious` remains a peer dependency.

## Deterministic backfill and verification

`plan.backfill(runner, { namespace, batchSize?, onProgress? })` fills every shadow column that expand() added. UUIDs are RFC 4122 v5: `uuidV5(namespace, `${targetTable}:${integerId}`)`, so primary keys and every reference to them agree by construction without joins, reruns derive identical values, and the batched NULL-only selection makes interrupted runs resumable. The `namespace` must be a UUID that stays stable for the lifetime of the application and should be treated as a secret (for example in the backend secrets file): anyone who knows it can enumerate UUIDs from integer ids. `uuidForRecord({ namespace, table, id })` is exported so application dual-writes derive byte-identical UUIDs for new rows.

The runner contract is structural like the migration contract: an object with `query(sql)` resolving to rows (a Velocious driver satisfies it). Polymorphic pairs are backfilled per discriminator mapping with the type column scoping each batch. Discriminator matching is byte-exact (case-sensitive) via the MariaDB/MySQL `BINARY` operator, so distinct manifest mappings such as `User` and `user` cannot alias each other under a case-insensitive column collation.

Integer ids are read from rows and interpolated into SQL predicates and UUID derivation exactly. To preserve MySQL/MariaDB `BIGINT` values beyond JavaScript's safe-integer range, every backfill SELECT casts both the row id used for deterministic batch ordering/updates and the legacy root or relationship id used for UUID derivation to `CHAR` under stable internal aliases. The runner therefore receives exact decimal strings without requiring special driver configuration. A JavaScript `number` id is still only accepted when it is a safe integer (`Number.isSafeInteger`); an unsafe `number` (a value past 2^53 that a driver may already have rounded) is rejected with a clear error. Decimal strings and `bigint` passed directly to `uuidForRecord` remain accepted as-is.

`plan.verifyBackfill(runner)` returns `{ ok, problems, orphans }`: completeness (no NULL shadow values where a legacy value exists), `uuid_id` uniqueness per table, and join-based referential consistency (every reference shadow value equals the referenced row's `uuid_id` — this catches namespace drift without knowing the namespace). Cross-column UUID comparisons are byte-exact via the MariaDB/MySQL `BINARY` operator, so verification remains safe when related `varchar(36)` columns have different collations. For polymorphic columns, in addition to the per-mapping checks (also byte-exact/case-sensitive), a relationship-wide check fails closed on every row that has a non-null source id but whose discriminator is not one of the declared mappings (or is NULL), **regardless of what the shadow UUID currently holds** — such a row has no safe backfill target, so an arbitrary pre-populated UUID must not let it pass. The report names the offending discriminator values so the missing mappings can be added. Orphaned legacy references (pointing at no row) are reported without failing the gate; they still receive derived UUIDs. Verification only reads; gating is the caller's decision, typically `if (!report.ok) throw`.

`verifyBackfill` runs each check as an independent read and opens no transaction of its own, so against a live, actively-written database successive queries can observe different snapshots. Treat it as a cutover gate only with writes quiesced, or pass a runner/transaction that serves every query one consistent snapshot.

## Cutover and rollback retention

`plan.planCutover({ legacyColumnPrefix })` builds a deterministic plan for renaming UUID shadow columns into canonical application names while preserving the legacy integer columns under retained names such as `legacy_id` and `legacy_author_id`. The prefix is explicit and validated; nothing is inferred.

```js
const cutover = plan.planCutover({ legacyColumnPrefix: "legacy_" })
const report = await plan.verifyBackfill(runner)
if (!report.ok) throw new Error(report.problems.join("; "))

const readiness = await cutover.verify(adapter, { verificationReport: report })
if (!readiness.ok) throw new Error(readiness.problems.join("; "))

await cutover.execute(adapter, {
  verificationReport: report,
  retentionPhase: cutover.retentionPhase
})
```

The cutover adapter is structural and intentionally narrow: it only needs `columnExists(table, column)` and `renameColumn(table, from, to)`. Forward cutover is limited to guarded column renames:

- `id -> legacy_id`, then `uuid_id -> id`
- `author_id -> legacy_author_id`, then `uuid_author_id -> author_id`
- polymorphic `subject_id -> legacy_subject_id`, then `uuid_subject_id -> subject_id`

`cutover.verify(...)` fails closed unless `verifyBackfill` already reported `ok`, and unless every logical column triple is in one of three safe states:

- pre-cutover: live integer column plus UUID shadow column
- partial-cutover: retained integer column plus UUID shadow column
- cutover-retained: retained integer column plus canonical UUID column

Any ambiguous collision, such as both `id` and `legacy_id` already existing before the legacy rename, is rejected. `cutover.execute(...)` is resumable and idempotent across those safe states.

Rollback is equally explicit:

```js
await cutover.rollback(adapter, {
  retentionPhase: cutover.retentionPhase
})
```

Rollback only operates during the documented `legacy-columns-retained` phase. It renames canonical UUID columns back to their `uuid_*` names and restores the retained integer columns to their legacy names. There is no automatic cleanup API after that phase: once the retained integer columns are intentionally dropped in a separate contract migration, package-supported rollback is over by design.

## Safety boundary

The package helps with canonical column naming and rollback retention, not full physical primary-key conversion. After cutover, a MySQL/MariaDB table may still have its original PK/FK/auto-increment semantics attached to the retained integer columns until the application performs separately reviewed DDL. The library does not pretend those operations are safely generic.

## Development

All project commands are intended to run in Docker:

```sh
docker compose run --rm package npm run validate
docker compose run --rm package npm pack
```

`npm run validate` performs linting, strict `checkJs` type checking, declaration/build generation, the `node:test` suite, a package dry run, and installation of the generated tarball in an isolated ESM consumer. That consumer proves runtime import and runs its own installed TypeScript compiler against the package declarations. Build and tarball artifacts are ignored by Git.

## CI

TensorBuzz runs the same `npm run validate` gate for every GitHub push and pull request from `tensorbuzz.yml`. Its runner connects only to a private Docker-in-Docker service, builds `compose.ci.yml`, then runs validation with `network_mode: none`; package scripts never run on the CI worker host.

MIT licensed.
