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

## Staged migration after expand

Application owners must implement and deploy later phases separately: a resumable production backfill with observability; dual-write plus UUID-first/legacy-fallback reads; verification of completeness, uniqueness, referential consistency, and rollback readiness; then a separately reviewed contract migration and primary-key cutover. AwesomeTasks integration is intentionally deferred. None of these phases is represented by a no-op or pretend API in v0.1.

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
