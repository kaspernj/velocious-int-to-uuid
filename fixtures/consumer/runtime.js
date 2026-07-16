import { UuidKeyMigration } from "velocious-int-to-uuid"

const plan = UuidKeyMigration.define({
  tables: [{ table: "users", references: [], polymorphic: [] }]
})

if (plan.validate() !== true) process.exit(1)
