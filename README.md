# velocious-int-to-uuid

Safe, deliberately small expand-phase planning for staged integer-to-UUID migrations in MySQL/MariaDB Velocious applications.

## v0.1 scope

This release only adds nullable `varchar(36)` shadow columns and named indexes through Velocious migration helpers. It never changes or drops a legacy ID, primary key, column, index, or foreign key; never adds a foreign key; never backfills data; and never performs primary-key cutover or contract cleanup. MySQL/MariaDB DDL is not transactional, so every schema operation is independently guarded by `columnExists` or `indexExists` and a partially completed expand can be rerun.

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

Every table must explicitly provide `references` and `polymorphic` arrays, using empty arrays when it has none; the library never infers relationships. Every declared table receives `uuid_id` and an index. A reference named `author` receives `uuid_author_id` and a single-column index. A polymorphic relationship named `subject` receives `uuid_subject_id` and an index on `subject_type, uuid_subject_id`. Reference targets must be declared tables. Polymorphic discriminator-to-target mappings are explicit and one-to-one in v0.1; duplicate discriminators or duplicate targets are rejected as ambiguous. Self-references are supported.

The migration object is structural: it needs async or synchronous `columnExists(table, column)`, `indexExists(table, indexName)`, `addColumn(table, column, columnType, args)`, and `addIndex(table, columns, options)` methods. For every shadow column, the exact Velocious call is `addColumn(table, column, "string", { maxLength: 36, null: true })`, which Velocious represents as a nullable SQL `varchar(36)`. The package does not import Velocious internals at runtime. `velocious` remains a peer dependency.

## Deterministic backfill and verification

`plan.backfill(runner, { namespace, batchSize?, onProgress? })` fills every shadow column that expand() added. UUIDs are RFC 4122 v5: `uuidV5(namespace, `${targetTable}:${integerId}`)`, so primary keys and every reference to them agree by construction without joins, reruns derive identical values, and the batched NULL-only selection makes interrupted runs resumable. The `namespace` must be a UUID that stays stable for the lifetime of the application and should be treated as a secret (for example in the backend secrets file): anyone who knows it can enumerate UUIDs from integer ids. `uuidForRecord({ namespace, table, id })` is exported so application dual-writes derive byte-identical UUIDs for new rows.

The runner contract is structural like the migration contract: an object with `query(sql)` resolving to rows (a Velocious driver satisfies it). Polymorphic pairs are backfilled per discriminator mapping with the type column scoping each batch. Discriminator matching is byte-exact (case-sensitive) via the MariaDB/MySQL `BINARY` operator, so distinct manifest mappings such as `User` and `user` cannot alias each other under a case-insensitive column collation.

Integer ids are read from rows and interpolated into SQL predicates and UUID derivation exactly, so precision must not be lost on the way in. A JavaScript `number` id is only accepted when it is a safe integer (`Number.isSafeInteger`); an unsafe `number` (a value past 2^53 that a driver may already have rounded) is rejected with a clear error. Drivers must return large ids as decimal strings or `bigint`, both of which are accepted as-is.

`plan.verifyBackfill(runner)` returns `{ ok, problems, orphans }`: completeness (no NULL shadow values where a legacy value exists), `uuid_id` uniqueness per table, and join-based referential consistency (every reference shadow value equals the referenced row's `uuid_id` — this catches namespace drift without knowing the namespace). For polymorphic columns, in addition to the per-mapping checks (also byte-exact/case-sensitive), a relationship-wide check fails closed on every row that has a non-null source id but whose discriminator is not one of the declared mappings (or is NULL), **regardless of what the shadow UUID currently holds** — such a row has no safe backfill target, so an arbitrary pre-populated UUID must not let it pass. The report names the offending discriminator values so the missing mappings can be added. Orphaned legacy references (pointing at no row) are reported without failing the gate; they still receive derived UUIDs. Verification only reads; gating is the caller's decision, typically `if (!report.ok) throw`.

`verifyBackfill` runs each check as an independent read and opens no transaction of its own, so against a live, actively-written database successive queries can observe different snapshots. Treat it as a cutover gate only with writes quiesced, or pass a runner/transaction that serves every query one consistent snapshot.

## Staged migration after expand and backfill

Application owners must implement and deploy later phases separately: dual-write plus UUID-first/legacy-fallback reads; then a separately reviewed contract migration and primary-key cutover. None of these phases is represented by a no-op or pretend API.

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
