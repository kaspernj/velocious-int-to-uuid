const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_IDENTIFIER_LENGTH = 64

/** @typedef {{type: "varchar", length: 36}} UuidStorage */
/** @typedef {{type: string, target: string}} PolymorphicMapping */
/** @typedef {{name: string, target: string}} ReferenceSpec */
/** @typedef {{name: string, typeColumn: string, mappings: readonly PolymorphicMapping[]}} PolymorphicSpec */
/** @typedef {{table: string, references: readonly ReferenceSpec[], polymorphic: readonly PolymorphicSpec[]}} TableSpec */
/** @typedef {{uuidStorage?: UuidStorage, tables: readonly TableSpec[]}} MigrationSpec */
/** @typedef {{maxLength: 36, null: true}} AddColumnOptions */
/** @typedef {{name: string, unique: false}} IndexOptions */
/**
 * The deliberately narrow migration surface used by expand(). Velocious migration
 * instances and test fakes can satisfy this structurally; no runtime import is made.
 *
 * @typedef {object} MigrationLike
 * @property {(table: string, column: string) => boolean | Promise<boolean>} columnExists
 * @property {(table: string, name: string) => boolean | Promise<boolean>} indexExists
 * @property {(table: string, column: string, type: "string", args: AddColumnOptions) => void | Promise<void>} addColumn
 * @property {(table: string, columns: string[], options: IndexOptions) => void | Promise<void>} addIndex
 */

/** @param {string} value @param {string} path */
function assertIdentifier(value, path) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(`${path} must be a valid MySQL identifier of at most 64 characters`)
  }
}

/** @param {Set<string>} seen @param {string} value @param {string} path */
function addUnique(seen, value, path) {
  if (seen.has(value)) throw new TypeError(`${path} duplicates ${value}`)
  seen.add(value)
}

/** @param {string} table @param {readonly string[]} columns */
function indexName(table, columns) {
  return `idx_${table}_${columns.join("_")}`
}

/** @param {MigrationSpec} spec */
function validateSpec(spec) {
  if (spec === null || typeof spec !== "object" || !Array.isArray(spec.tables) || spec.tables.length === 0) {
    throw new TypeError("spec.tables must be a non-empty array")
  }
  const storage = spec.uuidStorage ?? { type: "varchar", length: 36 }
  if (storage.type !== "varchar" || storage.length !== 36) {
    throw new TypeError('uuidStorage must be exactly { type: "varchar", length: 36 } in v0.1')
  }
  const tables = new Set()
  for (const [i, table] of spec.tables.entries()) {
    if (table === null || typeof table !== "object") throw new TypeError(`tables[${i}] must be an object`)
    assertIdentifier(table.table, `tables[${i}].table`)
    if (!Array.isArray(table.references)) throw new TypeError(`tables[${i}].references must be an array`)
    if (!Array.isArray(table.polymorphic)) throw new TypeError(`tables[${i}].polymorphic must be an array`)
    addUnique(tables, table.table, "table target")
  }
  for (const [i, table] of spec.tables.entries()) {
    const occupied = new Set(["uuid_id"])
    for (const [j, reference] of table.references.entries()) {
      if (reference === null || typeof reference !== "object") throw new TypeError(`tables[${i}].references[${j}] must be an object`)
      assertIdentifier(reference.name, `tables[${i}].references[${j}].name`)
      assertIdentifier(reference.target, `tables[${i}].references[${j}].target`)
      if (!tables.has(reference.target)) throw new TypeError(`unknown reference target ${reference.target}`)
      const column = `uuid_${reference.name}_id`
      assertIdentifier(column, "generated reference column")
      addUnique(occupied, column, "relationship shadow column")
      const name = indexName(table.table, [column])
      assertIdentifier(name, "generated index name")
    }
    for (const [j, polymorphic] of table.polymorphic.entries()) {
      if (polymorphic === null || typeof polymorphic !== "object") throw new TypeError(`tables[${i}].polymorphic[${j}] must be an object`)
      assertIdentifier(polymorphic.name, `tables[${i}].polymorphic[${j}].name`)
      assertIdentifier(polymorphic.typeColumn, `tables[${i}].polymorphic[${j}].typeColumn`)
      const column = `uuid_${polymorphic.name}_id`
      assertIdentifier(column, "generated polymorphic column")
      addUnique(occupied, column, "relationship shadow column")
      if (!Array.isArray(polymorphic.mappings) || polymorphic.mappings.length === 0) {
        throw new TypeError(`polymorphic ${polymorphic.name} requires explicit mappings`)
      }
      const types = new Set()
      const targets = new Set()
      for (const mapping of polymorphic.mappings) {
        if (mapping === null || typeof mapping !== "object") throw new TypeError("polymorphic mapping must be an object")
        if (typeof mapping.type !== "string" || mapping.type.length === 0) throw new TypeError("polymorphic mapping type must be non-empty")
        assertIdentifier(mapping.target, "polymorphic mapping target")
        if (!tables.has(mapping.target)) throw new TypeError(`unknown polymorphic target ${mapping.target}`)
        addUnique(types, mapping.type, "polymorphic discriminator")
        addUnique(targets, mapping.target, "ambiguous polymorphic target")
      }
      const name = indexName(table.table, [polymorphic.typeColumn, column])
      assertIdentifier(name, "generated index name")
    }
  }
  return true
}

/** @param {MigrationLike} migration @param {string} table @param {string} column */
async function addShadowColumn(migration, table, column) {
  if (!await migration.columnExists(table, column)) {
    await migration.addColumn(table, column, "string", { maxLength: 36, null: true })
  }
}

/** @param {MigrationLike} migration @param {string} table @param {readonly string[]} columns */
async function addShadowIndex(migration, table, columns) {
  const name = indexName(table, columns)
  if (!await migration.indexExists(table, name)) {
    await migration.addIndex(table, columns, { name, unique: false })
  }
}

export class UuidKeyMigration {
  /** @param {MigrationSpec} spec */
  static define(spec) {
    validateSpec(spec)
    const snapshot = structuredClone(spec)
    return Object.freeze({
      validate() { return validateSpec(snapshot) },
      /** @param {MigrationLike} migration */
      async expand(migration) {
        validateSpec(snapshot)
        for (const table of snapshot.tables) {
          await addShadowColumn(migration, table.table, "uuid_id")
          await addShadowIndex(migration, table.table, ["uuid_id"])
          for (const reference of table.references) {
            const column = `uuid_${reference.name}_id`
            await addShadowColumn(migration, table.table, column)
            await addShadowIndex(migration, table.table, [column])
          }
          for (const polymorphic of table.polymorphic) {
            const column = `uuid_${polymorphic.name}_id`
            await addShadowColumn(migration, table.table, column)
            await addShadowIndex(migration, table.table, [polymorphic.typeColumn, column])
          }
        }
      }
    })
  }
}
