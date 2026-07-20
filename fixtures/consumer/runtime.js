import { UuidKeyMigration } from "velocious-int-to-uuid"

const plan = UuidKeyMigration.define({
  tables: [{ table: "users", references: [], polymorphic: [] }]
})

if (plan.validate() !== true) process.exit(1)

const { uuidForRecord } = await import("velocious-int-to-uuid")
const derived = uuidForRecord({ namespace: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", table: "users", id: 1 })
if (!/^[0-9a-f-]{36}$/.test(derived)) process.exit(1)

const report = await plan.verifyBackfill({ query: async () => [{ c: 0 }] })
if (report.ok !== true || report.problems.length !== 0) process.exit(1)

await plan.backfill({ query: async (sql) => sql.startsWith("SELECT") ? [] : [] }, { namespace: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" })
