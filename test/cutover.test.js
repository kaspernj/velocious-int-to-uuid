import assert from "node:assert/strict"
import test from "node:test"
import { UuidKeyMigration } from "../src/index.js"

const RETENTION_PHASE = "legacy-columns-retained"

const spec = () => ({
  tables: [
    { table: "users", references: [{ name: "manager", target: "users" }], polymorphic: [] },
    {
      table: "posts",
      references: [{ name: "author", target: "users" }],
      polymorphic: [{ name: "subject", typeColumn: "subject_type", mappings: [{ type: "User", target: "users" }] }]
    }
  ]
})

class FakeCutoverAdapter {
  /** @param {readonly string[]} columns */
  constructor(columns) {
    this.columns = new Set(columns)
    this.calls = []
  }
  async columnExists(table, column) {
    return this.columns.has(`${table}.${column}`)
  }
  async renameColumn(table, from, to) {
    const fromKey = `${table}.${from}`
    const toKey = `${table}.${to}`
    if (!this.columns.has(fromKey)) throw new Error(`missing ${fromKey}`)
    if (this.columns.has(toKey)) throw new Error(`existing ${toKey}`)
    this.columns.delete(fromKey)
    this.columns.add(toKey)
    this.calls.push(["renameColumn", table, from, to])
  }
}

function expandedColumns() {
  return [
    "users.id",
    "users.uuid_id",
    "users.manager_id",
    "users.uuid_manager_id",
    "posts.id",
    "posts.uuid_id",
    "posts.author_id",
    "posts.uuid_author_id",
    "posts.subject_id",
    "posts.uuid_subject_id",
    "posts.subject_type"
  ]
}

test("planCutover returns deterministic retained-column and rollback plans", () => {
  const cutover = UuidKeyMigration.define(spec()).planCutover({ legacyColumnPrefix: "legacy_" })
  assert.equal(cutover.retentionPhase, RETENTION_PHASE)
  assert.equal(cutover.verificationGate, "verifyBackfill.ok")
  assert.deepEqual(cutover.retained, [
    { table: "users", sourceColumn: "id", retainedAs: "legacy_id", restoreTo: "id", phase: RETENTION_PHASE },
    { table: "users", sourceColumn: "manager_id", retainedAs: "legacy_manager_id", restoreTo: "manager_id", phase: RETENTION_PHASE },
    { table: "posts", sourceColumn: "id", retainedAs: "legacy_id", restoreTo: "id", phase: RETENTION_PHASE },
    { table: "posts", sourceColumn: "author_id", retainedAs: "legacy_author_id", restoreTo: "author_id", phase: RETENTION_PHASE },
    { table: "posts", sourceColumn: "subject_id", retainedAs: "legacy_subject_id", restoreTo: "subject_id", phase: RETENTION_PHASE }
  ])
  assert.deepEqual(cutover.steps, [
    { kind: "rename-column", table: "users", from: "id", to: "legacy_id" },
    { kind: "rename-column", table: "users", from: "uuid_id", to: "id" },
    { kind: "rename-column", table: "users", from: "manager_id", to: "legacy_manager_id" },
    { kind: "rename-column", table: "users", from: "uuid_manager_id", to: "manager_id" },
    { kind: "rename-column", table: "posts", from: "id", to: "legacy_id" },
    { kind: "rename-column", table: "posts", from: "uuid_id", to: "id" },
    { kind: "rename-column", table: "posts", from: "author_id", to: "legacy_author_id" },
    { kind: "rename-column", table: "posts", from: "uuid_author_id", to: "author_id" },
    { kind: "rename-column", table: "posts", from: "subject_id", to: "legacy_subject_id" },
    { kind: "rename-column", table: "posts", from: "uuid_subject_id", to: "subject_id" }
  ])
  assert.deepEqual(cutover.rollbackSteps, [
    { kind: "rename-column", table: "posts", from: "id", to: "uuid_id" },
    { kind: "rename-column", table: "posts", from: "legacy_id", to: "id" },
    { kind: "rename-column", table: "posts", from: "author_id", to: "uuid_author_id" },
    { kind: "rename-column", table: "posts", from: "legacy_author_id", to: "author_id" },
    { kind: "rename-column", table: "posts", from: "subject_id", to: "uuid_subject_id" },
    { kind: "rename-column", table: "posts", from: "legacy_subject_id", to: "subject_id" },
    { kind: "rename-column", table: "users", from: "id", to: "uuid_id" },
    { kind: "rename-column", table: "users", from: "legacy_id", to: "id" },
    { kind: "rename-column", table: "users", from: "manager_id", to: "uuid_manager_id" },
    { kind: "rename-column", table: "users", from: "legacy_manager_id", to: "manager_id" }
  ])
})

test("cutover verify fails closed when backfill verification did not pass", async () => {
  const adapter = new FakeCutoverAdapter(expandedColumns())
  const cutover = UuidKeyMigration.define(spec()).planCutover({ legacyColumnPrefix: "legacy_" })
  const report = await cutover.verify(adapter, {
    verificationReport: { ok: false, problems: ["posts.uuid_author_id: 1 rows whose UUID disagrees"], orphans: [] }
  })
  assert.equal(report.ok, false)
  assert.deepEqual(report.problems, [
    "verifyBackfill must report ok before cutover: posts.uuid_author_id: 1 rows whose UUID disagrees"
  ])
})

test("cutover execute renames canonical UUID columns while retaining legacy integers and is idempotent", async () => {
  const adapter = new FakeCutoverAdapter(expandedColumns())
  const cutover = UuidKeyMigration.define(spec()).planCutover({ legacyColumnPrefix: "legacy_" })

  await cutover.execute(adapter, {
    verificationReport: { ok: true, problems: [], orphans: [] },
    retentionPhase: RETENTION_PHASE
  })
  const firstCalls = structuredClone(adapter.calls)
  await cutover.execute(adapter, {
    verificationReport: { ok: true, problems: [], orphans: [] },
    retentionPhase: RETENTION_PHASE
  })

  assert.deepEqual(adapter.calls, firstCalls)
  assert.deepEqual(firstCalls, cutover.steps.map((step) => ["renameColumn", step.table, step.from, step.to]))
  assert.equal(adapter.columns.has("users.id"), true)
  assert.equal(adapter.columns.has("users.legacy_id"), true)
  assert.equal(adapter.columns.has("users.uuid_id"), false)
  assert.equal(adapter.columns.has("users.manager_id"), true)
  assert.equal(adapter.columns.has("users.legacy_manager_id"), true)
  assert.equal(adapter.columns.has("users.uuid_manager_id"), false)
  assert.equal(adapter.columns.has("posts.id"), true)
  assert.equal(adapter.columns.has("posts.legacy_id"), true)
  assert.equal(adapter.columns.has("posts.uuid_id"), false)
  assert.equal(adapter.columns.has("posts.author_id"), true)
  assert.equal(adapter.columns.has("posts.legacy_author_id"), true)
  assert.equal(adapter.columns.has("posts.uuid_author_id"), false)
  assert.equal(adapter.columns.has("posts.subject_id"), true)
  assert.equal(adapter.columns.has("posts.legacy_subject_id"), true)
  assert.equal(adapter.columns.has("posts.uuid_subject_id"), false)
  assert.equal(adapter.columns.has("posts.subject_type"), true)
})

test("cutover execute resumes from a partial retained-column state", async () => {
  const adapter = new FakeCutoverAdapter([
    "users.legacy_id",
    "users.id",
    "users.manager_id",
    "users.uuid_manager_id",
    "posts.id",
    "posts.uuid_id",
    "posts.author_id",
    "posts.uuid_author_id",
    "posts.subject_id",
    "posts.uuid_subject_id",
    "posts.subject_type"
  ])
  const cutover = UuidKeyMigration.define(spec()).planCutover({ legacyColumnPrefix: "legacy_" })

  await cutover.execute(adapter, {
    verificationReport: { ok: true, problems: [], orphans: [] },
    retentionPhase: RETENTION_PHASE
  })

  assert.deepEqual(adapter.calls, [
    ["renameColumn", "users", "manager_id", "legacy_manager_id"],
    ["renameColumn", "users", "uuid_manager_id", "manager_id"],
    ["renameColumn", "posts", "id", "legacy_id"],
    ["renameColumn", "posts", "uuid_id", "id"],
    ["renameColumn", "posts", "author_id", "legacy_author_id"],
    ["renameColumn", "posts", "uuid_author_id", "author_id"],
    ["renameColumn", "posts", "subject_id", "legacy_subject_id"],
    ["renameColumn", "posts", "uuid_subject_id", "subject_id"]
  ])
})

test("cutover verify rejects ambiguous schema collisions before renaming", async () => {
  const adapter = new FakeCutoverAdapter([
    "users.id",
    "users.uuid_id",
    "users.legacy_id",
    "users.manager_id",
    "users.uuid_manager_id"
  ])
  const cutover = UuidKeyMigration.define({
    tables: [{ table: "users", references: [{ name: "manager", target: "users" }], polymorphic: [] }]
  }).planCutover({ legacyColumnPrefix: "legacy_" })

  const report = await cutover.verify(adapter, {
    verificationReport: { ok: true, problems: [], orphans: [] }
  })

  assert.equal(report.ok, false)
  assert.ok(report.problems.includes("users.id -> legacy_id: both columns exist; refusing ambiguous cutover state"))
})

test("rollback restores legacy names only during the retained legacy phase", async () => {
  const adapter = new FakeCutoverAdapter([
    "users.id",
    "users.legacy_id",
    "users.manager_id",
    "users.legacy_manager_id",
    "posts.id",
    "posts.legacy_id",
    "posts.author_id",
    "posts.legacy_author_id",
    "posts.subject_id",
    "posts.legacy_subject_id",
    "posts.subject_type"
  ])
  const cutover = UuidKeyMigration.define(spec()).planCutover({ legacyColumnPrefix: "legacy_" })

  await assert.rejects(
    cutover.rollback(adapter, { retentionPhase: "cleanup-complete" }),
    /rollback requires retentionPhase legacy-columns-retained/
  )

  await cutover.rollback(adapter, { retentionPhase: RETENTION_PHASE })
  const firstCalls = structuredClone(adapter.calls)
  await cutover.rollback(adapter, { retentionPhase: RETENTION_PHASE })

  assert.deepEqual(adapter.calls, firstCalls)
  assert.deepEqual(firstCalls, cutover.rollbackSteps.map((step) => ["renameColumn", step.table, step.from, step.to]))
  assert.equal(adapter.columns.has("users.id"), true)
  assert.equal(adapter.columns.has("users.uuid_id"), true)
  assert.equal(adapter.columns.has("users.legacy_id"), false)
  assert.equal(adapter.columns.has("posts.author_id"), true)
  assert.equal(adapter.columns.has("posts.uuid_author_id"), true)
  assert.equal(adapter.columns.has("posts.legacy_author_id"), false)
  assert.equal(adapter.columns.has("posts.subject_id"), true)
  assert.equal(adapter.columns.has("posts.uuid_subject_id"), true)
  assert.equal(adapter.columns.has("posts.legacy_subject_id"), false)
})
