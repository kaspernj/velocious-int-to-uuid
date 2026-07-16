import assert from "node:assert/strict"
import test from "node:test"
import { UuidKeyMigration } from "../src/index.js"

const validSpec = () => ({
  tables: [
    { table: "users", references: [{ name: "manager", target: "users" }], polymorphic: [] },
    { table: "posts", references: [{ name: "author", target: "users" }], polymorphic: [{ name: "subject", typeColumn: "subject_type", mappings: [{ type: "User", target: "users" }, { type: "Post", target: "posts" }] }] }
  ]
})

class FakeMigration {
  constructor() { this.columns = new Set(); this.indexes = new Set(); this.calls = [] }
  async columnExists(table, column) { return this.columns.has(`${table}.${column}`) }
  async indexExists(table, name) { return this.indexes.has(`${table}.${name}`) }
  async addColumn(table, column, type, args) { this.calls.push(["addColumn", table, column, type, args]); this.columns.add(`${table}.${column}`) }
  async addIndex(table, columns, options) { this.calls.push(["addIndex", table, columns, options]); this.indexes.add(`${table}.${options.name}`) }
}

test("accepts self-references", () => assert.equal(UuidKeyMigration.define(validSpec()).validate(), true))

test("rejects invalid manifests", () => {
  const invalid = [
    { tables: [] },
    { tables: [{ table: "users" }] },
    { uuidStorage: { type: "binary", length: 16 }, tables: [{ table: "users", references: [], polymorphic: [] }] },
    { tables: [{ table: "bad-name", references: [], polymorphic: [] }] },
    { tables: [{ table: "users", references: [], polymorphic: [] }, { table: "users", references: [], polymorphic: [] }] },
    { tables: [{ table: "users", references: [{ name: "owner", target: "missing" }], polymorphic: [] }] },
    { tables: [{ table: "users", references: [{ name: "owner", target: "users" }, { name: "owner", target: "users" }], polymorphic: [] }] },
    { tables: [{ table: "users", references: [], polymorphic: [{ name: "subject", typeColumn: "subject_type", mappings: [] }] }] },
    { tables: [{ table: "users", references: [], polymorphic: [{ name: "subject", typeColumn: "subject_type", mappings: [{ type: "User", target: "users" }, { type: "User", target: "users" }] }] }] },
    { tables: [{ table: "users", references: [], polymorphic: [] }, { table: "posts", references: [], polymorphic: [{ name: "subject", typeColumn: "subject_type", mappings: [{ type: "User", target: "users" }, { type: "LegacyUser", target: "users" }] }] }] }
  ]
  for (const spec of invalid) assert.throws(() => UuidKeyMigration.define(spec))
})

test("expand is idempotent and uses only additive helpers", async () => {
  const migration = new FakeMigration()
  const plan = UuidKeyMigration.define(validSpec())
  await plan.expand(migration)
  const firstCalls = structuredClone(migration.calls)
  await plan.expand(migration)
  assert.deepEqual(migration.calls, firstCalls)
  assert.deepEqual(firstCalls, [
    ["addColumn", "users", "uuid_id", "string", { maxLength: 36, null: true }],
    ["addIndex", "users", ["uuid_id"], { name: "idx_users_uuid_id", unique: false }],
    ["addColumn", "users", "uuid_manager_id", "string", { maxLength: 36, null: true }],
    ["addIndex", "users", ["uuid_manager_id"], { name: "idx_users_uuid_manager_id", unique: false }],
    ["addColumn", "posts", "uuid_id", "string", { maxLength: 36, null: true }],
    ["addIndex", "posts", ["uuid_id"], { name: "idx_posts_uuid_id", unique: false }],
    ["addColumn", "posts", "uuid_author_id", "string", { maxLength: 36, null: true }],
    ["addIndex", "posts", ["uuid_author_id"], { name: "idx_posts_uuid_author_id", unique: false }],
    ["addColumn", "posts", "uuid_subject_id", "string", { maxLength: 36, null: true }],
    ["addIndex", "posts", ["subject_type", "uuid_subject_id"], { name: "idx_posts_subject_type_uuid_subject_id", unique: false }]
  ])
  assert.ok(firstCalls.every(([method]) => method === "addColumn" || method === "addIndex"))
})

test("skips independently pre-existing columns and indexes", async () => {
  const migration = new FakeMigration()
  migration.columns.add("users.uuid_id")
  migration.indexes.add("users.idx_users_uuid_manager_id")
  await UuidKeyMigration.define({ tables: [{ table: "users", references: [{ name: "manager", target: "users" }], polymorphic: [] }] }).expand(migration)
  assert.equal(migration.calls.some(call => call[0] === "addColumn" && call[2] === "uuid_id"), false)
  assert.equal(migration.calls.some(call => call[0] === "addIndex" && call[3].name === "idx_users_uuid_manager_id"), false)
})
