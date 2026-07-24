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

test("uuidForRecord rejects unsafe integer numbers but keeps string and bigint for large ids", () => {
  assert.throws(() => uuidForRecord({ namespace: NAMESPACE, table: "users", id: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/)
  assert.throws(() => uuidForRecord({ namespace: NAMESPACE, table: "users", id: 1e21 }), /safe integer/)
  assert.equal(
    uuidForRecord({ namespace: NAMESPACE, table: "users", id: "9007199254740993" }),
    uuidForRecord({ namespace: NAMESPACE, table: "users", id: 9007199254740993n })
  )
})

test("backfill fills primary keys, references, and scoped polymorphic mappings with derived UUIDs", async () => {
  const runner = new FakeRunner([
    [{ __uuid_row_id: "1", __uuid_source_id: "1" }, { __uuid_row_id: "2", __uuid_source_id: "2" }],
    [{ __uuid_row_id: "7", __uuid_source_id: "7" }],
    [{ __uuid_row_id: "7", __uuid_source_id: "1" }],
    [{ __uuid_row_id: "7", __uuid_source_id: "2" }]
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
  assert.equal(updates[0], `UPDATE \`users\` SET \`uuid_id\` = CASE \`id\` WHEN 1 THEN '${user1}' WHEN 2 THEN '${user2}' END WHERE \`id\` IN (1, 2) AND \`uuid_id\` IS NULL AND ((\`id\` = 1 AND \`id\` = 1) OR (\`id\` = 2 AND \`id\` = 2))`)
  assert.equal(updates[1], `UPDATE \`posts\` SET \`uuid_id\` = CASE \`id\` WHEN 7 THEN '${post7}' END WHERE \`id\` IN (7) AND \`uuid_id\` IS NULL AND ((\`id\` = 7 AND \`id\` = 7))`)
  assert.equal(updates[2], `UPDATE \`posts\` SET \`uuid_author_id\` = CASE \`id\` WHEN 7 THEN '${user1}' END WHERE \`id\` IN (7) AND \`uuid_author_id\` IS NULL AND ((\`id\` = 7 AND \`author_id\` = 1))`)
  assert.equal(updates[3], `UPDATE \`posts\` SET \`uuid_subject_id\` = CASE \`id\` WHEN 7 THEN '${user2}' END WHERE \`id\` IN (7) AND \`uuid_subject_id\` IS NULL AND ((\`id\` = 7 AND \`subject_id\` = 2)) AND BINARY \`subject_type\` = 'User'`)
  assert.ok(runner.queries.some((sql) => sql.includes("BINARY `subject_type` = 'User'")))
  assert.ok(runner.queries.every((sql) => !sql.startsWith("SELECT") || sql.includes("IS NULL")))
  assert.deepEqual(progress, [
    { table: "users", column: "uuid_id", updated: 2 },
    { table: "posts", column: "uuid_id", updated: 1 },
    { table: "posts", column: "uuid_author_id", updated: 1 },
    { table: "posts", column: "uuid_subject_id", updated: 1 }
  ])
})

test("backfill loops full batches until a short batch and validates row values", async () => {
  const full = Array.from({ length: 2 }, (_, i) => ({ __uuid_row_id: String(i + 1), __uuid_source_id: String(i + 1) }))
  const runner = new FakeRunner([full, [{ __uuid_row_id: "3", __uuid_source_id: "3" }]])
  await UuidKeyMigration.define({ tables: [{ table: "users", references: [], polymorphic: [] }] })
    .backfill(runner, { namespace: NAMESPACE, batchSize: 2 })
  assert.equal(runner.queries.filter((sql) => sql.startsWith("UPDATE")).length, 2)

  const poisoned = new FakeRunner([[{ __uuid_row_id: "1 OR 1=1", __uuid_source_id: "1 OR 1=1" }]])
  await assert.rejects(
    UuidKeyMigration.define({ tables: [{ table: "users", references: [], polymorphic: [] }] })
      .backfill(poisoned, { namespace: NAMESPACE }),
    TypeError
  )
})

test("backfill rejects unsafe integer numbers returned by the driver", async () => {
  const unsafe = new FakeRunner([[{ __uuid_row_id: Number.MAX_SAFE_INTEGER + 1, __uuid_source_id: Number.MAX_SAFE_INTEGER + 1 }]])
  await assert.rejects(
    UuidKeyMigration.define({ tables: [{ table: "users", references: [], polymorphic: [] }] })
      .backfill(unsafe, { namespace: NAMESPACE }),
    /safe integer/
  )
})

test("backfill selects every UUID and cursor integer as an exact decimal string", async () => {
  const runner = new FakeRunner()
  await UuidKeyMigration.define(spec()).backfill(runner, { namespace: NAMESPACE })

  const selects = runner.queries.filter((sql) => sql.startsWith("SELECT"))
  assert.equal(selects.length, 4)
  assert.ok(selects.every((sql) => sql.includes("CAST(source.`id` AS CHAR) AS `__uuid_row_id`")))
  assert.ok(selects.some((sql) => sql.includes("CAST(source.`id` AS CHAR) AS `__uuid_source_id` FROM `users` AS source")))
  assert.ok(selects.some((sql) => sql.includes("CAST(source.`author_id` AS CHAR) AS `__uuid_source_id` FROM `posts` AS source")))
  assert.ok(selects.some((sql) => sql.includes("CAST(source.`subject_id` AS CHAR) AS `__uuid_source_id` FROM `posts` AS source")))
})

test("backfill preserves adjacent bigint strings without UUID collision or cursor skip", async () => {
  const first = "9007199254740995"
  const second = "9007199254740996"
  const runner = new FakeRunner([
    [
      { __uuid_row_id: first, __uuid_source_id: first },
      { __uuid_row_id: second, __uuid_source_id: second }
    ]
  ])

  await UuidKeyMigration.define({ tables: [{ table: "users", references: [], polymorphic: [] }] })
    .backfill(runner, { namespace: NAMESPACE, batchSize: 2 })

  const update = runner.queries.find((sql) => sql.startsWith("UPDATE"))
  assert.ok(update)
  assert.match(update, new RegExp(`WHEN ${first} THEN '${uuidForRecord({ namespace: NAMESPACE, table: "users", id: first })}'`))
  assert.match(update, new RegExp(`WHEN ${second} THEN '${uuidForRecord({ namespace: NAMESPACE, table: "users", id: second })}'`))
  assert.ok(update.includes(`WHERE \`id\` IN (${first}, ${second})`))
  assert.equal(runner.queries.filter((sql) => sql.startsWith("SELECT")).length, 2)
})

test("backfill updates compare the selected reference source and polymorphic type", async () => {
  const runner = new FakeRunner([
    [],
    [],
    [{ __uuid_row_id: "7", __uuid_source_id: "1" }],
    [{ __uuid_row_id: "7", __uuid_source_id: "2" }]
  ])
  await UuidKeyMigration.define(spec()).backfill(runner, { namespace: NAMESPACE })

  const updates = runner.queries.filter((sql) => sql.startsWith("UPDATE"))
  assert.equal(updates.length, 2)
  assert.match(updates[0], /`uuid_author_id` IS NULL AND \(\(`id` = 7 AND `author_id` = 1\)\)$/)
  assert.match(updates[1], /`uuid_subject_id` IS NULL AND \(\(`id` = 7 AND `subject_id` = 2\)\) AND BINARY `subject_type` = 'User'$/)
})

test("backfill compares polymorphic discriminators case-sensitively via BINARY in select and update", async () => {
  const runner = new FakeRunner([[], [], [], [{ __uuid_row_id: "7", __uuid_source_id: "2" }]])
  await UuidKeyMigration.define(spec()).backfill(runner, { namespace: NAMESPACE })
  const selects = runner.queries.filter((sql) => sql.startsWith("SELECT") && sql.includes("subject_type"))
  const updates = runner.queries.filter((sql) => sql.startsWith("UPDATE") && sql.includes("subject_type"))
  assert.ok(selects.length > 0 && selects.every((sql) => sql.includes("BINARY `subject_type` = 'User'")))
  assert.ok(updates.length > 0 && updates.every((sql) => sql.includes("BINARY `subject_type` = 'User'")))
  assert.ok(runner.queries.every((sql) => !sql.includes("subject_type") || sql.includes("BINARY `subject_type`")))
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
  const perReference = 4
  const perPolymorphicCompleteness = 1
  assert.equal(clean.queries.length, spec().tables.length * perTable + 2 * perReference + perPolymorphicCompleteness)
  assert.ok(clean.queries.every((sql) => sql.startsWith("SELECT COUNT")))

  const dirty = new FakeRunner([], 4)
  const dirtyReport = await UuidKeyMigration.define(spec()).verifyBackfill(dirty)
  assert.equal(dirtyReport.ok, false)
  assert.ok(dirtyReport.problems.some((problem) => problem.includes("users.uuid_id: 4 rows without a backfilled UUID")))
  assert.ok(dirtyReport.problems.some((problem) => problem.includes("posts.uuid_author_id: 4 rows whose UUID disagrees")))
  assert.deepEqual(dirtyReport.orphans.filter((orphan) => orphan.column === "uuid_subject_id"), [{ table: "posts", column: "uuid_subject_id", count: 4 }])
})

test("verifyBackfill rejects counts that cannot be represented exactly", async () => {
  await assert.rejects(
    UuidKeyMigration.define(spec()).verifyBackfill(new FakeRunner([], "9007199254740995")),
    /safe-integer count/
  )
})

test("verifyBackfill fails closed when a polymorphic row has an unmapped discriminator", async () => {
  const runner = new FakeRunner()
  runner.query = async function (sql) {
    this.queries.push(sql)
    if (sql.includes("NOT IN")) return [{ c: 3, t: "Comment" }]
    return [{ c: 0 }]
  }

  const report = await UuidKeyMigration.define(spec()).verifyBackfill(runner)
  assert.equal(report.ok, false)
  assert.ok(report.problems.some((problem) => problem.includes("uuid_subject_id") && problem.includes("Comment")))
  assert.ok(runner.queries.some((sql) => sql.includes("`subject_type`") && sql.includes("NOT IN") && sql.includes("GROUP BY")))
})

test("verifyBackfill detects unmapped/NULL discriminators regardless of shadow UUID state", async () => {
  // Structural: detection must gate on the legacy source id, never on the shadow UUID being NULL,
  // otherwise a row with an arbitrary pre-populated UUID evades the check.
  const captured = new FakeRunner([], 0)
  await UuidKeyMigration.define(spec()).verifyBackfill(captured)
  const detection = captured.queries.find((sql) => sql.includes("NOT IN") && sql.includes("GROUP BY"))
  assert.ok(detection, "expected an unmapped-discriminator detection query")
  assert.ok(detection.includes("child.`subject_id` IS NOT NULL"))
  assert.ok(!detection.includes("`uuid_subject_id` IS NULL"))

  // Behavioral: a row whose shadow UUID is already populated is only surfaced once the shadow-NULL gate is gone.
  const populated = new FakeRunner()
  populated.query = async function (sql) {
    this.queries.push(sql)
    if (sql.includes("NOT IN") && !sql.includes("`uuid_subject_id` IS NULL")) return [{ c: 2, t: "Comment" }]
    return [{ c: 0 }]
  }
  const populatedReport = await UuidKeyMigration.define(spec()).verifyBackfill(populated)
  assert.equal(populatedReport.ok, false)
  assert.ok(populatedReport.problems.some((problem) => problem.includes("uuid_subject_id") && problem.includes("Comment")))

  // Behavioral: an explicit NULL discriminator with a populated shadow UUID is likewise flagged.
  const nullType = new FakeRunner()
  nullType.query = async function (sql) {
    this.queries.push(sql)
    if (sql.includes("NOT IN") && !sql.includes("`uuid_subject_id` IS NULL")) return [{ c: 1, t: null }]
    return [{ c: 0 }]
  }
  const nullReport = await UuidKeyMigration.define(spec()).verifyBackfill(nullType)
  assert.equal(nullReport.ok, false)
  assert.ok(nullReport.problems.some((problem) => problem.includes("uuid_subject_id") && problem.includes("NULL")))
})

test("verifyBackfill compares polymorphic discriminators case-sensitively via BINARY", async () => {
  const runner = new FakeRunner([], 0)
  await UuidKeyMigration.define(spec()).verifyBackfill(runner)
  assert.ok(runner.queries.some((sql) => sql.includes("BINARY child.`subject_type` = 'User'")))
  assert.ok(runner.queries.some((sql) => sql.includes("BINARY child.`subject_type` NOT IN ('User')")))
  assert.ok(runner.queries.every((sql) => !sql.includes("child.`subject_type`") || sql.includes("BINARY child.`subject_type`")))
})

test("verifyBackfill compares normal and polymorphic UUID references bytewise", async () => {
  const runner = new FakeRunner([], 0)
  await UuidKeyMigration.define(spec()).verifyBackfill(runner)
  const mismatchQueries = runner.queries.filter((sql) => (
    sql.includes("INNER JOIN") &&
    sql.includes("child.`uuid_") &&
    sql.includes("parent.`uuid_id`")
  ))

  assert.equal(mismatchQueries.length, 2)
  assert.ok(mismatchQueries.some((sql) => sql.includes("BINARY child.`uuid_author_id` <> BINARY parent.`uuid_id`")))
  assert.ok(mismatchQueries.some((sql) => sql.includes("BINARY child.`uuid_subject_id` <> BINARY parent.`uuid_id`")))
})

test("verifyBackfill rejects UUID references left behind after an optional legacy reference is cleared", async () => {
  const runner = new FakeRunner()
  runner.query = async function (sql) {
    this.queries.push(sql)
    return [{ c: sql.includes("child.`author_id` IS NULL AND child.`uuid_author_id` IS NOT NULL") ? 1 : 0 }]
  }

  const report = await UuidKeyMigration.define(spec()).verifyBackfill(runner)
  assert.equal(report.ok, false)
  assert.ok(report.problems.includes("posts.uuid_author_id: 1 rows with a backfilled UUID but no legacy reference"))
  assert.ok(runner.queries.includes("SELECT COUNT(*) AS c FROM `posts` AS child WHERE child.`subject_id` IS NULL AND child.`uuid_subject_id` IS NOT NULL"))
})

test("verifyBackfill aliases self-joins so self-references verify cleanly", async () => {
  const runner = new FakeRunner([], 0)
  await UuidKeyMigration.define({ tables: [{ table: "users", references: [{ name: "manager", target: "users" }], polymorphic: [] }] }).verifyBackfill(runner)
  const joins = runner.queries.filter((sql) => sql.includes("JOIN"))
  assert.ok(joins.length > 0)
  assert.ok(joins.every((sql) => sql.includes("AS child") && sql.includes("AS parent")))
})
