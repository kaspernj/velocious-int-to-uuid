import { UuidKeyMigration } from "velocious-int-to-uuid"

const plan = UuidKeyMigration.define({
  tables: [{ table: "users", references: [], polymorphic: [] }]
})

const valid: boolean = plan.validate()
await plan.expand({
  columnExists: async (_table, _column) => false,
  indexExists: async (_table, _name) => false,
  addColumn: async (_table, _column, type, args) => {
    const expectedType: "string" = type
    const expectedLength: 36 = args.maxLength
    const expectedNull: true = args.null
    void [expectedType, expectedLength, expectedNull]
  },
  addIndex: async (_table, _columns, _options) => {}
})

void valid

import { uuidForRecord, uuidV5 } from "velocious-int-to-uuid"

const derived: string = uuidForRecord({ namespace: uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "app"), table: "users", id: 1n })
const report = await plan.verifyBackfill({ query: async (_sql: string) => [{ c: 0 }] })
const reportOk: boolean = report.ok
const problems: string[] = report.problems
await plan.backfill({ query: async (_sql: string) => [] }, {
  namespace: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  batchSize: 100,
  onProgress: (progress) => { const updated: number = progress.updated; void updated }
})
void [derived, reportOk, problems]
