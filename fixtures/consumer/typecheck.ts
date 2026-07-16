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
