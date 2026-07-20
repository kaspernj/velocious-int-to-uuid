import assert from "node:assert/strict"
import test from "node:test"
import { UuidKeyMigration, uuidForRecord, uuidV5 } from "../src/index.js"

const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"

const spec = () => ({
  tables: [
    { table: "users", references: [], polymorphic: [] },
    { table: "posts", references: [{ name: "author", target: "users" }], polymorphic: [{ name: "subject", typeColumn: "subject_type", mappings: [{ type: "User", target: "users" }] }] }
  ]
})

/**
 * Scripted runner: SELECT queries consume the next scripted row batch; every
 * query is recorded for exact-SQL assertions.
 */
class FakeRunner {
  constructor(selectBatches = [], countValue = 0) {
    this.selectBatches = selectBatches
    this.countValue = countValue
    this.queries = []
  }
  async query(sql) {
    this.queries.push(sql)
    if (sql.startsWith("SELECT COUNT")) return [{ c: this.countValue }]
    if (sql.startsWith("SELECT")) return this.selectBatches.shift() ?? []
    return []
  }
}

test("uuidV5 matches the RFC 4122 reference vector and is deterministic", () => {
  assert.equal(uuidV5(NAMESPACE, "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d")
  assert.equal(uuidV5(NAMESPACE, "python.org"), uuidV5(NAMESPACE, "python.org"))
  assert.notEqual(uuidV5(NAMESPACE, "python.org"), uuidV5(NAMESPACE, "python.orh"))
  assert.match(uuidV5(NAMESPACE, "x"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("uuidForRecord derives from table and integer id and rejects non-integers", () => {
  assert.equal(uuidForRecord({ namespace: NAMESPACE, table: "users", id: 42 }), uuidV5(NAMESPACE, "users:42"))
  assert.equal(uuidForRecord({ namespace: NAMESPACE, table: "users", id: "42" }), uuidForRecord({ namespace: NAMESPACE, table: "users", id: 42n }))
  assert.throws(() => uuidForRecord({ namespace: NAMESPACE, table: "users", id: "42; DROP TABLE" }))
  assert.throws(() => uuidForRecord({ namespace: "not-a-uuid", table: "users", id: 1 }))
})

test("backfill fills primary keys, references, and scoped polymorphic mappings with derived UUIDs", async () => {
  const runner = new FakeRunner([
    [{ id: 1 }, { id: 2 }],
    [{ id: 7 }],
    [{ id: 7, author_id: 1 }],
    [{ id: 7, subject_id: 2 }]
  ])
  const progress = []
  await UuidKeyMigration.define({ tables: [
    { table: "users", references: [], polymorphic: [] },
    { table: "posts", references: [{ name: "author", target: "users" }], polymorphic: [{ name: "subject", typeColumn: "subject_type", mappings: [{ type: "User", target: "users" }] }] }
  ] }).backfill(runner, { namespace: NAMESPACE, batchSize: 500, onProgress: (p) => progress.push(p) })

  const updates = runner.queries.filter((sql) => sql.startsWith("UPDATE"))
  const user1 = uuidForRecord({ namespace: NAMESPACE, table: "users", id: 1 })
  const user2 = uuidForRecord({ namespace: NAMESPACE, table: "users", id: 2 })
  const post7 = uuidForRecord({ namespace: NAMESPACE, table: "posts", id: 7 })
  assert.equal(updates.length, 4)
  assert.equal(updates[0], `UPDATE \`users\` SET \`uuid_id\` = CASE \`id\` WHEN 1 THEN '${user1}' WHEN 2 THEN '${user2}' END WHERE \`id\` IN (1, 2)`)
  assert.equal(updates[1], `UPDATE \`posts\` SET \`uuid_id\` = CASE \`id\` WHEN 7 THEN '${post7}' END WHERE \`id\` IN (7)`)
  assert.equal(updates[2], `UPDATE \`posts\` SET \`uuid_author_id\` = CASE \`id\` WHEN 7 THEN '${user1}' END WHERE \`id\` IN (7)`)
  assert.equal(updates[3], `UPDATE \`posts\` SET \`uuid_subject_id\` = CASE \`id\` WHEN 7 THEN '${user2}' END WHERE \`id\` IN (7)`)
  assert.ok(runner.queries.some((sql) => sql.includes("`subject_type` = 'User'")))
  assert.ok(runner.queries.every((sql) => !sql.startsWith("SELECT") || sql.includes("IS NULL")))
  assert.deepEqual(progress, [
    { table: "users", column: "uuid_id", updated: 2 },
    { table: "posts", column: "uuid_id", updated: 1 },
    { table: "posts", column: "uuid_author_id", updated: 1 },
    { table: "posts", column: "uuid_subject_id", updated: 1 }
  ])
})

test("backfill loops full batches until a short batch and validates row values", async () => {
  const full = Array.from({ length: 2 }, (_, i) => ({ id: i + 1 }))
  const runner = new FakeRunner([full, [{ id: 3 }]])
  await UuidKeyMigration.define({ tables: [{ table: "users", references: [], polymorphic: [] }] })
    .backfill(runner, { namespace: NAMESPACE, batchSize: 2 })
  assert.equal(runner.queries.filter((sql) => sql.startsWith("UPDATE")).length, 2)

  const poisoned = new FakeRunner([[{ id: "1 OR 1=1" }]])
  await assert.rejects(
    UuidKeyMigration.define({ tables: [{ table: "users", references: [], polymorphic: [] }] })
      .backfill(poisoned, { namespace: NAMESPACE }),
    TypeError
  )
})

test("backfill rejects bad options and control characters in discriminators", async () => {
  const plan = UuidKeyMigration.define(spec())
  await assert.rejects(plan.backfill(new FakeRunner(), { namespace: "nope" }), TypeError)
  await assert.rejects(plan.backfill(new FakeRunner(), { namespace: NAMESPACE, batchSize: 0 }), TypeError)
  const evil = UuidKeyMigration.define({ tables: [
    { table: "users", references: [], polymorphic: [] },
    { table: "posts", references: [], polymorphic: [{ name: "subject", typeColumn: "subject_type", mappings: [{ type: "User\nOR", target: "users" }] }] }
  ] })
  await assert.rejects(evil.backfill(new FakeRunner(), { namespace: NAMESPACE }), TypeError)
})

test("verifyBackfill reports ok with zero counts and collects problems and orphans otherwise", async () => {
  const clean = new FakeRunner([], 0)
  const cleanReport = await UuidKeyMigration.define(spec()).verifyBackfill(clean)
  assert.deepEqual(cleanReport, { ok: true, problems: [], orphans: [] })
  const perTable = 2
  const perReference = 3
  assert.equal(clean.queries.length, spec().tables.length * perTable + 2 * perReference)
  assert.ok(clean.queries.every((sql) => sql.startsWith("SELECT COUNT")))

  const dirty = new FakeRunner([], 4)
  const dirtyReport = await UuidKeyMigration.define(spec()).verifyBackfill(dirty)
  assert.equal(dirtyReport.ok, false)
  assert.ok(dirtyReport.problems.some((problem) => problem.includes("users.uuid_id: 4 rows without a backfilled UUID")))
  assert.ok(dirtyReport.problems.some((problem) => problem.includes("posts.uuid_author_id: 4 rows whose UUID disagrees")))
  assert.deepEqual(dirtyReport.orphans.filter((orphan) => orphan.column === "uuid_subject_id"), [{ table: "posts", column: "uuid_subject_id", count: 4 }])
})

test("verifyBackfill aliases self-joins so self-references verify cleanly", async () => {
  const runner = new FakeRunner([], 0)
  await UuidKeyMigration.define({ tables: [{ table: "users", references: [{ name: "manager", target: "users" }], polymorphic: [] }] }).verifyBackfill(runner)
  const joins = runner.queries.filter((sql) => sql.includes("JOIN"))
  assert.ok(joins.length > 0)
  assert.ok(joins.every((sql) => sql.includes("AS child") && sql.includes("AS parent")))
})
