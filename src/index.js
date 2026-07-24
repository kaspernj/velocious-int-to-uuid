import { uuidForRecord, uuidV5 } from "./uuid-v5.js"

export { uuidForRecord, uuidV5 }

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_IDENTIFIER_LENGTH = 64
const DEFAULT_BATCH_SIZE = 1000
const MAX_BATCH_SIZE = 50000

/** @typedef {{type: "varchar", length: 36}} UuidStorage */
/** @typedef {{type: string, target: string}} PolymorphicMapping */
/** @typedef {{name: string, target: string}} ReferenceSpec */
/** @typedef {{name: string, typeColumn: string, mappings: readonly PolymorphicMapping[]}} PolymorphicSpec */
/** @typedef {{table: string, references: readonly ReferenceSpec[], polymorphic: readonly PolymorphicSpec[]}} TableSpec */
/** @typedef {{uuidStorage?: UuidStorage, tables: readonly TableSpec[]}} MigrationSpec */
/** @typedef {{maxLength: 36, null: true}} AddColumnOptions */
/** @typedef {{name: string, unique: false}} IndexOptions */
/** @typedef {{kind: "rename-column", table: string, from: string, to: string}} CutoverStep */
/** @typedef {{table: string, sourceColumn: string, retainedAs: string, restoreTo: string, phase: string}} RetainedColumn */
/** @typedef {{table: string, liveColumn: string, shadowColumn: string, retainedColumn: string}} CutoverColumn */
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

/**
 * Structural adapter for explicit cutover/rollback column renames. This helper
 * deliberately does not attempt generic MySQL/MariaDB primary-key, foreign-key,
 * or contract cleanup DDL: callers must review and execute those separately.
 *
 * @typedef {object} CutoverAdapterLike
 * @property {(table: string, column: string) => boolean | Promise<boolean>} columnExists
 * @property {(table: string, from: string, to: string) => void | Promise<void>} renameColumn
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

/**
 * The deliberately narrow SQL surface used by backfill() and
 * verifyBackfill(). Velocious drivers (and migration `execute`-style
 * wrappers) satisfy it structurally; no runtime import is made.
 *
 * @typedef {object} RunnerLike
 * @property {(sql: string) => Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[]} query
 */

/**
 * @typedef {object} BackfillOptions
 * @property {string} namespace Application namespace UUID for deterministic derivation.
 * @property {number} [batchSize] Rows per batch, 1..50000, default 1000.
 * @property {(progress: {table: string, column: string, updated: number}) => void} [onProgress] Called after every written batch.
 */

/**
 * @typedef {object} BackfillVerificationReport
 * @property {boolean} ok True when no completeness, uniqueness, or consistency problem was found. A polymorphic row whose discriminator is not one of the declared mappings (or is NULL) but still has a non-null source id is never backfilled and blocks ok.
 * @property {string[]} problems Human-readable gate failures; empty when ok. Includes per-mapping completeness/consistency failures and, for polymorphic columns, a relationship-wide failure naming any unmapped discriminator values that leave rows unbackfilled.
 * @property {{table: string, column: string, count: number}[]} orphans Legacy references without a target row (informational; these rows still received derived UUIDs).
 */

/**
 * @typedef {object} CutoverVerificationReport
 * @property {boolean} ok True when the verification gate passed and every rename pair is in a safe pre-cutover, cutover-complete, or resumable partial state.
 * @property {string[]} problems Human-readable cutover blockers.
 * @property {"pre-cutover" | "partial-cutover" | "cutover-retained"} state Current schema naming phase.
 * @property {readonly CutoverStep[]} steps Deterministic forward rename steps.
 * @property {readonly CutoverStep[]} rollbackSteps Deterministic rollback rename steps.
 * @property {readonly RetainedColumn[]} retained Legacy integer columns that must remain during the retention window for rollback.
 */

/** @typedef {{legacyColumnPrefix: string}} CutoverPlanOptions */
/** @typedef {{verificationReport: BackfillVerificationReport}} CutoverVerifyOptions */
/** @typedef {{verificationReport: BackfillVerificationReport, retentionPhase: string}} CutoverExecuteOptions */
/** @typedef {{retentionPhase: string}} CutoverRollbackOptions */

/** @param {string} identifier */
function quoteIdentifier(identifier) {
  return `\`${identifier}\``
}

/** @param {string} value */
function sqlStringLiteral(value) {
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) {
      throw new TypeError("string values used in SQL must not contain control characters")
    }
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
}

/**
 * Case-sensitive, byte-exact discriminator equality. Manifest discriminator
 * uniqueness is enforced with JavaScript (case-sensitive) comparison, so the
 * generated SQL must match with the same exactness. A bare `col = 'x'` inherits
 * the column's collation, which under a common case-insensitive collation would
 * let `User` and `user` (distinct mappings) match the same rows ambiguously.
 * The MariaDB/MySQL `BINARY` operator forces a byte-exact comparison regardless
 * of the column's charset/collation.
 * @param {string} columnExpr Quoted (optionally qualified) discriminator column.
 * @param {string} value Declared discriminator value.
 */
function discriminatorEquals(columnExpr, value) {
  return `BINARY ${columnExpr} = ${sqlStringLiteral(value)}`
}

/**
 * Case-sensitive, byte-exact "not one of the declared values", mirroring
 * discriminatorEquals so unmapped-discriminator detection cannot be defeated by
 * a case-insensitive collation treating a stored value as one of the mappings.
 * @param {string} columnExpr Quoted (optionally qualified) discriminator column.
 * @param {readonly string[]} values Declared discriminator values.
 */
function discriminatorNotIn(columnExpr, values) {
  return `BINARY ${columnExpr} NOT IN (${values.map((value) => sqlStringLiteral(value)).join(", ")})`
}

/**
 * Byte-exact UUID inequality for cross-column verification. Applying the
 * MariaDB/MySQL BINARY operator to both operands prevents either varchar
 * column's collation from being selected for the comparison.
 * @param {string} leftExpr Quoted (optionally qualified) UUID column.
 * @param {string} rightExpr Quoted (optionally qualified) UUID column.
 */
function uuidNotEqual(leftExpr, rightExpr) {
  return `BINARY ${leftExpr} <> BINARY ${rightExpr}`
}

/** @param {unknown} value @param {string} context */
function integerIdString(value, context) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError(`${context} must be a safe integer; got the unsafe number ${String(value)} — return large ids as strings or bigint so precision is not lost`)
  }
  const idString = typeof value === "bigint" ? value.toString() : String(value)
  if (!/^[0-9]+$/.test(idString)) {
    throw new TypeError(`${context} must be a non-negative integer, got ${String(value)}`)
  }
  return idString
}

/** @param {unknown} value @param {string} context */
function countFrom(value, context) {
  const count = Number(value)
  if (!Number.isFinite(count)) throw new TypeError(`${context} did not return a numeric count`)
  return count
}

/** @param {BackfillOptions} options */
function validateBackfillOptions(options) {
  if (options === null || typeof options !== "object") throw new TypeError("backfill options must be an object")
  uuidV5(options.namespace, "namespace-validation")
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new TypeError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`)
  }
  return { namespace: options.namespace, batchSize, onProgress: options.onProgress }
}

const CUTOVER_RETENTION_PHASE = "legacy-columns-retained"

/** @param {CutoverPlanOptions} options @param {readonly TableSpec[]} tables */
function validateCutoverOptions(options, tables) {
  if (options === null || typeof options !== "object") throw new TypeError("cutover options must be an object")
  assertIdentifier(options.legacyColumnPrefix, "legacyColumnPrefix")
  for (const table of tables) {
    assertIdentifier(`${options.legacyColumnPrefix}id`, `retained column for ${table.table}.id`)
    for (const reference of table.references) {
      assertIdentifier(`${options.legacyColumnPrefix}${reference.name}_id`, `retained column for ${table.table}.${reference.name}_id`)
    }
    for (const polymorphic of table.polymorphic) {
      assertIdentifier(`${options.legacyColumnPrefix}${polymorphic.name}_id`, `retained column for ${table.table}.${polymorphic.name}_id`)
    }
  }
  return { legacyColumnPrefix: options.legacyColumnPrefix }
}

/** @param {BackfillVerificationReport} report */
function validateVerificationReport(report) {
  if (report === null || typeof report !== "object") throw new TypeError("verificationReport must be an object")
  if (typeof report.ok !== "boolean" || !Array.isArray(report.problems) || !Array.isArray(report.orphans)) {
    throw new TypeError("verificationReport must be the result of verifyBackfill()")
  }
  return report
}

/** @param {readonly TableSpec[]} tables @param {{legacyColumnPrefix: string}} options */
function buildCutoverDescription(tables, options) {
  /** @type {CutoverColumn[]} */
  const columns = []
  /** @type {CutoverColumn[][]} */
  const columnGroups = []
  for (const table of tables) {
    /** @type {CutoverColumn[]} */
    const tableColumns = [{ table: table.table, liveColumn: "id", shadowColumn: "uuid_id", retainedColumn: `${options.legacyColumnPrefix}id` }]
    for (const reference of table.references) {
      tableColumns.push({
        table: table.table,
        liveColumn: `${reference.name}_id`,
        shadowColumn: `uuid_${reference.name}_id`,
        retainedColumn: `${options.legacyColumnPrefix}${reference.name}_id`
      })
    }
    for (const polymorphic of table.polymorphic) {
      tableColumns.push({
        table: table.table,
        liveColumn: `${polymorphic.name}_id`,
        shadowColumn: `uuid_${polymorphic.name}_id`,
        retainedColumn: `${options.legacyColumnPrefix}${polymorphic.name}_id`
      })
    }
    columnGroups.push(tableColumns)
    columns.push(...tableColumns)
  }
  /** @type {RetainedColumn[]} */
  const retained = columns.map((column) => ({
    table: column.table,
    sourceColumn: column.liveColumn,
    retainedAs: column.retainedColumn,
    restoreTo: column.liveColumn,
    phase: CUTOVER_RETENTION_PHASE
  }))
  /** @type {CutoverStep[]} */
  const steps = columns.flatMap((column) => ([
    { kind: "rename-column", table: column.table, from: column.liveColumn, to: column.retainedColumn },
    { kind: "rename-column", table: column.table, from: column.shadowColumn, to: column.liveColumn }
  ]))
  const rollbackColumns = [...columnGroups].reverse().flatMap((group) => group)
  /** @type {CutoverStep[]} */
  const rollbackSteps = rollbackColumns.flatMap((column) => ([
    { kind: "rename-column", table: column.table, from: column.liveColumn, to: column.shadowColumn },
    { kind: "rename-column", table: column.table, from: column.retainedColumn, to: column.liveColumn }
  ]))
  return {
    columns: Object.freeze(columns.map((column) => Object.freeze(column))),
    rollbackColumns: Object.freeze(rollbackColumns.map((column) => Object.freeze(column))),
    verificationGate: "verifyBackfill.ok",
    retentionPhase: CUTOVER_RETENTION_PHASE,
    steps: Object.freeze(steps.map((step) => Object.freeze(step))),
    rollbackSteps: Object.freeze(rollbackSteps.map((step) => Object.freeze(step))),
    retained: Object.freeze(retained.map((entry) => Object.freeze(entry)))
  }
}

/** @param {CutoverAdapterLike} adapter @param {CutoverColumn} column */
async function cutoverColumnState(adapter, column) {
  const liveExists = await adapter.columnExists(column.table, column.liveColumn)
  const shadowExists = await adapter.columnExists(column.table, column.shadowColumn)
  const retainedExists = await adapter.columnExists(column.table, column.retainedColumn)
  if (liveExists && shadowExists && !retainedExists) return "pre-cutover"
  if (!liveExists && shadowExists && retainedExists) return "mid-cutover"
  if (liveExists && !shadowExists && retainedExists) return "cutover-retained"
  if (!liveExists && !shadowExists && !retainedExists) return "missing"
  return "conflict"
}

/**
 * @param {CutoverAdapterLike} adapter
 * @param {{verificationReport: BackfillVerificationReport | undefined, columns: readonly CutoverColumn[], steps: readonly CutoverStep[], rollbackSteps: readonly CutoverStep[], retained: readonly RetainedColumn[]}} args
 * @returns {Promise<CutoverVerificationReport>}
 */
async function verifyCutoverState(adapter, { verificationReport, columns, steps, rollbackSteps, retained }) {
  /** @type {CutoverVerificationReport} */
  const report = {
    ok: true,
    problems: [],
    state: "pre-cutover",
    steps,
    rollbackSteps,
    retained
  }
  if (verificationReport !== undefined) {
    const validated = validateVerificationReport(verificationReport)
    if (!validated.ok) {
      report.problems.push(`verifyBackfill must report ok before cutover: ${validated.problems.join("; ") || "verification gate failed"}`)
    }
  }
  let preCutover = 0
  let retainedCutover = 0
  for (const column of columns) {
    const state = await cutoverColumnState(adapter, column)
    if (state === "conflict") {
      report.problems.push(`${column.table}.${column.liveColumn} -> ${column.retainedColumn}: both columns exist; refusing ambiguous cutover state`)
      continue
    }
    if (state === "missing") {
      report.problems.push(`${column.table}.${column.liveColumn} -> ${column.retainedColumn}: neither live, shadow, nor retained column combination is valid`)
      continue
    }
    if (state === "pre-cutover") preCutover += 1
    if (state === "cutover-retained") retainedCutover += 1
  }
  if (report.problems.length === 0) {
    if (preCutover === columns.length) report.state = "pre-cutover"
    else if (retainedCutover === columns.length) report.state = "cutover-retained"
    else report.state = "partial-cutover"
  }
  report.ok = report.problems.length === 0
  return report
}

/** @param {CutoverExecuteOptions | CutoverRollbackOptions} options @param {string} action */
function assertRetentionPhase(options, action) {
  if (options.retentionPhase !== CUTOVER_RETENTION_PHASE) {
    throw new TypeError(`${action} requires retentionPhase ${CUTOVER_RETENTION_PHASE}`)
  }
}

/** @param {CutoverAdapterLike} adapter @param {readonly CutoverColumn[]} columns */
async function applyCutoverColumns(adapter, columns) {
  for (const column of columns) {
    const state = await cutoverColumnState(adapter, column)
    if (state === "cutover-retained") continue
    if (state === "pre-cutover") {
      await adapter.renameColumn(column.table, column.liveColumn, column.retainedColumn)
      await adapter.renameColumn(column.table, column.shadowColumn, column.liveColumn)
      continue
    }
    if (state === "mid-cutover") {
      await adapter.renameColumn(column.table, column.shadowColumn, column.liveColumn)
      continue
    }
    throw new Error(`${column.table}.${column.liveColumn} is not in a safe resumable cutover state`)
  }
}

/** @param {CutoverAdapterLike} adapter @param {readonly CutoverColumn[]} columns */
async function rollbackCutoverColumns(adapter, columns) {
  for (const column of columns) {
    const state = await cutoverColumnState(adapter, column)
    if (state === "pre-cutover") continue
    if (state === "cutover-retained") {
      await adapter.renameColumn(column.table, column.liveColumn, column.shadowColumn)
      await adapter.renameColumn(column.table, column.retainedColumn, column.liveColumn)
      continue
    }
    if (state === "mid-cutover") {
      await adapter.renameColumn(column.table, column.retainedColumn, column.liveColumn)
      continue
    }
    throw new Error(`${column.table}.${column.liveColumn} is not in a safe rollback state`)
  }
}

/**
 * Fills one shadow column in batches: read rows whose shadow column is still
 * NULL, derive their UUIDs in process, write them back with a single CASE
 * update. NULL-only selection makes reruns resume where they stopped.
 * @param {RunnerLike} runner SQL runner.
 * @param {object} args Arguments.
 * @param {string} args.table Table being backfilled.
 * @param {string} args.column Shadow column being filled.
 * @param {string} args.sourceColumn Legacy integer column the UUID derives from.
 * @param {string} args.targetTable Table whose namespace the UUID belongs to.
 * @param {string | undefined} args.typeColumn Polymorphic discriminator column, when scoped.
 * @param {string | undefined} args.typeValue Polymorphic discriminator value, when scoped.
 * @param {{namespace: string, batchSize: number, onProgress: BackfillOptions["onProgress"]}} args.options Validated options.
 */
async function backfillColumn(runner, { table, column, sourceColumn, targetTable, typeColumn, typeValue, options }) {
  const conditions = [`${quoteIdentifier(column)} IS NULL`, `${quoteIdentifier(sourceColumn)} IS NOT NULL`]
  if (typeColumn !== undefined && typeValue !== undefined) {
    conditions.push(discriminatorEquals(quoteIdentifier(typeColumn), typeValue))
  }
  const select = `SELECT ${quoteIdentifier("id")}, ${quoteIdentifier(sourceColumn)} FROM ${quoteIdentifier(table)} ` +
    `WHERE ${conditions.join(" AND ")} ORDER BY ${quoteIdentifier("id")} LIMIT ${options.batchSize}`

  for (;;) {
    const rows = await runner.query(select)
    if (rows.length === 0) return
    const cases = []
    const ids = []
    const sourceMatches = []
    for (const row of rows) {
      const rowId = integerIdString(row.id, `${table}.id`)
      const sourceValue = integerIdString(row[sourceColumn], `${table}.${sourceColumn}`)
      const uuid = uuidForRecord({ namespace: options.namespace, table: targetTable, id: sourceValue })
      ids.push(rowId)
      cases.push(`WHEN ${rowId} THEN '${uuid}'`)
      sourceMatches.push(`(${quoteIdentifier("id")} = ${rowId} AND ${quoteIdentifier(sourceColumn)} = ${sourceValue})`)
    }
    const updateConditions = [
      `${quoteIdentifier(column)} IS NULL`,
      `(${sourceMatches.join(" OR ")})`
    ]
    if (typeColumn !== undefined && typeValue !== undefined) {
      updateConditions.push(discriminatorEquals(quoteIdentifier(typeColumn), typeValue))
    }
    await runner.query(
      `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = CASE ${quoteIdentifier("id")} ${cases.join(" ")} END ` +
      `WHERE ${quoteIdentifier("id")} IN (${ids.join(", ")}) AND ${updateConditions.join(" AND ")}`
    )
    options.onProgress?.({ table, column, updated: rows.length })
    if (rows.length < options.batchSize) return
  }
}

/**
 * Counts rows matching a condition.
 * @param {RunnerLike} runner SQL runner.
 * @param {string} sql Query returning one row with a `c` column.
 * @param {string} context Label for error messages.
 */
async function countQuery(runner, sql, context) {
  const rows = await runner.query(sql)
  return countFrom(rows[0]?.c, context)
}

/**
 * Runs the completeness, consistency, and orphan checks for one
 * reference-style column pair and appends findings to the report.
 * @param {RunnerLike} runner SQL runner.
 * @param {object} args Arguments.
 * @param {string} args.table Referencing table.
 * @param {string} args.column Shadow column under verification.
 * @param {string} args.sourceColumn Legacy integer column.
 * @param {string} args.targetTable Referenced table.
 * @param {string} args.typeFilter Extra SQL condition (already quoted) or empty string.
 * @param {boolean} args.checkNullSource Whether to run the relationship-wide NULL-source check.
 * @param {BackfillVerificationReport} args.report Report being built.
 */
async function verifyReferenceColumn(runner, { table, column, sourceColumn, targetTable, typeFilter, checkNullSource, report }) {
  const child = quoteIdentifier(table)
  const parent = quoteIdentifier(targetTable)
  const label = `${table}.${column}`
  const incomplete = await countQuery(
    runner,
    `SELECT COUNT(*) AS c FROM ${child} AS child WHERE child.${quoteIdentifier(sourceColumn)} IS NOT NULL AND child.${quoteIdentifier(column)} IS NULL${typeFilter}`,
    label
  )
  if (incomplete > 0) report.problems.push(`${label}: ${incomplete} rows with a legacy reference but no backfilled UUID`)
  if (checkNullSource) {
    const stale = await countQuery(
      runner,
      `SELECT COUNT(*) AS c FROM ${child} AS child WHERE child.${quoteIdentifier(sourceColumn)} IS NULL AND child.${quoteIdentifier(column)} IS NOT NULL`,
      label
    )
    if (stale > 0) report.problems.push(`${label}: ${stale} rows with a backfilled UUID but no legacy reference`)
  }
  const mismatched = await countQuery(
    runner,
    `SELECT COUNT(*) AS c FROM ${child} AS child INNER JOIN ${parent} AS parent ON child.${quoteIdentifier(sourceColumn)} = parent.${quoteIdentifier("id")} ` +
    `WHERE child.${quoteIdentifier(column)} IS NOT NULL AND parent.${quoteIdentifier("uuid_id")} IS NOT NULL AND ` +
    `${uuidNotEqual(`child.${quoteIdentifier(column)}`, `parent.${quoteIdentifier("uuid_id")}`)}${typeFilter}`,
    label
  )
  if (mismatched > 0) report.problems.push(`${label}: ${mismatched} rows whose UUID disagrees with the referenced ${targetTable}.uuid_id`)
  const orphaned = await countQuery(
    runner,
    `SELECT COUNT(*) AS c FROM ${child} AS child LEFT JOIN ${parent} AS parent ON child.${quoteIdentifier(sourceColumn)} = parent.${quoteIdentifier("id")} ` +
    `WHERE child.${quoteIdentifier(sourceColumn)} IS NOT NULL AND parent.${quoteIdentifier("id")} IS NULL${typeFilter}`,
    label
  )
  if (orphaned > 0) report.orphans.push({ table, column, count: orphaned })
}

/**
 * Fail-closed, relationship-wide check for one polymorphic shadow column. The
 * per-mapping checks only ever see rows whose discriminator equals a declared
 * mapping, so a row whose discriminator is NULL or is not one of the declared
 * mappings has no safe target and is never backfilled. Such a row must block
 * `ok` whatever its shadow UUID holds: gating only on a NULL shadow column
 * would let a row with an arbitrary pre-populated UUID evade every check. This
 * therefore groups every row with a non-null source id under an unmapped or
 * NULL discriminator regardless of shadow state, blocks `ok`, and names the
 * offending discriminator values so the caller can add the missing mappings.
 * The discriminator comparison is byte-exact (case-sensitive) to match the
 * JavaScript-case-sensitive manifest, independent of column collation.
 * @param {RunnerLike} runner SQL runner.
 * @param {object} args Arguments.
 * @param {string} args.table Referencing table.
 * @param {string} args.column Polymorphic shadow column.
 * @param {string} args.sourceColumn Legacy integer column.
 * @param {string} args.typeColumn Discriminator column.
 * @param {readonly string[]} args.mappedTypes Declared discriminator values.
 * @param {BackfillVerificationReport} args.report Report being built.
 */
async function verifyPolymorphicCompleteness(runner, { table, column, sourceColumn, typeColumn, mappedTypes, report }) {
  const child = quoteIdentifier(table)
  const label = `${table}.${column}`
  const quotedType = quoteIdentifier(typeColumn)
  const rows = await runner.query(
    `SELECT COUNT(*) AS c, child.${quotedType} AS t FROM ${child} AS child ` +
    `WHERE child.${quoteIdentifier(sourceColumn)} IS NOT NULL ` +
    `AND (child.${quotedType} IS NULL OR ${discriminatorNotIn(`child.${quotedType}`, mappedTypes)}) ` +
    `GROUP BY child.${quotedType}`
  )
  let affected = 0
  const values = []
  for (const row of rows) {
    const count = countFrom(row.c, label)
    if (count <= 0) continue
    affected += count
    const type = row.t
    values.push(`${type === null || type === undefined ? "NULL" : String(type)} (${count})`)
  }
  if (affected > 0) {
    report.problems.push(`${label}: ${affected} rows with a legacy reference under an unmapped or NULL ${typeColumn} discriminator (no safe backfill target): ${values.join(", ")}`)
  }
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
    // Velocious's addIndex takes a mutable array; hand it its own copy.
    await migration.addIndex(table, [...columns], { name, unique: false })
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
      },
      /**
       * Deterministically fills every shadow column added by expand().
       * Batched, resumable, and rerunnable: only rows whose shadow column is
       * still NULL are touched, and reruns with the same namespace derive the
       * same UUIDs.
       * @param {RunnerLike} runner @param {BackfillOptions} options
       */
      async backfill(runner, options) {
        validateSpec(snapshot)
        const validated = validateBackfillOptions(options)
        for (const table of snapshot.tables) {
          await backfillColumn(runner, {
            table: table.table,
            column: "uuid_id",
            sourceColumn: "id",
            targetTable: table.table,
            typeColumn: undefined,
            typeValue: undefined,
            options: validated
          })
          for (const reference of table.references) {
            await backfillColumn(runner, {
              table: table.table,
              column: `uuid_${reference.name}_id`,
              sourceColumn: `${reference.name}_id`,
              targetTable: reference.target,
              typeColumn: undefined,
              typeValue: undefined,
              options: validated
            })
          }
          for (const polymorphic of table.polymorphic) {
            for (const mapping of polymorphic.mappings) {
              await backfillColumn(runner, {
                table: table.table,
                column: `uuid_${polymorphic.name}_id`,
                sourceColumn: `${polymorphic.name}_id`,
                targetTable: mapping.target,
                typeColumn: polymorphic.typeColumn,
                typeValue: mapping.type,
                options: validated
              })
            }
          }
        }
      },
      /**
       * Verifies backfill completeness, uuid_id uniqueness, and join-based
       * referential consistency. Reads only; never repairs. Orphaned legacy
       * references are reported without failing the gate. For polymorphic
       * columns a relationship-wide check additionally fails closed on any row
       * whose discriminator is not one of the declared mappings (or is NULL) —
       * regardless of what its shadow UUID currently holds, since such a row
       * has no safe backfill target — which the per-mapping checks cannot see,
       * and names those discriminator values. All discriminator comparisons are
       * byte-exact (case-sensitive), matching the manifest, so a case-insensitive
       * column collation cannot make distinct mappings alias.
       *
       * Each check is an independent read: verifyBackfill does not open its own
       * transaction, so against a live, actively-written database the reads can
       * observe different snapshots. Use it as a cutover gate only with writes
       * quiesced, or pass a runner/transaction that gives every query one
       * consistent snapshot.
       * @param {RunnerLike} runner
       * @returns {Promise<BackfillVerificationReport>}
       */
      async verifyBackfill(runner) {
        validateSpec(snapshot)
        /** @type {BackfillVerificationReport} */
        const report = { ok: true, problems: [], orphans: [] }
        for (const table of snapshot.tables) {
          const quoted = quoteIdentifier(table.table)
          const missing = await countQuery(
            runner,
            `SELECT COUNT(*) AS c FROM ${quoted} WHERE ${quoteIdentifier("uuid_id")} IS NULL`,
            `${table.table}.uuid_id`
          )
          if (missing > 0) report.problems.push(`${table.table}.uuid_id: ${missing} rows without a backfilled UUID`)
          const duplicated = await countQuery(
            runner,
            `SELECT COUNT(*) AS c FROM (SELECT ${quoteIdentifier("uuid_id")} FROM ${quoted} WHERE ${quoteIdentifier("uuid_id")} IS NOT NULL ` +
            `GROUP BY ${quoteIdentifier("uuid_id")} HAVING COUNT(*) > 1) AS duplicated`,
            `${table.table}.uuid_id`
          )
          if (duplicated > 0) report.problems.push(`${table.table}.uuid_id: ${duplicated} UUID values are duplicated`)
          for (const reference of table.references) {
            await verifyReferenceColumn(runner, {
              table: table.table,
              column: `uuid_${reference.name}_id`,
              sourceColumn: `${reference.name}_id`,
              targetTable: reference.target,
              typeFilter: "",
              checkNullSource: true,
              report
            })
          }
          for (const polymorphic of table.polymorphic) {
            for (const [mappingIndex, mapping] of polymorphic.mappings.entries()) {
              await verifyReferenceColumn(runner, {
                table: table.table,
                column: `uuid_${polymorphic.name}_id`,
                sourceColumn: `${polymorphic.name}_id`,
                targetTable: mapping.target,
                typeFilter: ` AND ${discriminatorEquals(`child.${quoteIdentifier(polymorphic.typeColumn)}`, mapping.type)}`,
                checkNullSource: mappingIndex === 0,
                report
              })
            }
            await verifyPolymorphicCompleteness(runner, {
              table: table.table,
              column: `uuid_${polymorphic.name}_id`,
              sourceColumn: `${polymorphic.name}_id`,
              typeColumn: polymorphic.typeColumn,
              mappedTypes: polymorphic.mappings.map((mapping) => mapping.type),
              report
            })
          }
        }
        report.ok = report.problems.length === 0
        return report
      },
      /**
       * Builds an explicit, rollback-aware column-name cutover plan that keeps
       * legacy integer columns under retained names. It does not attempt
       * generic PK/FK/constraint cleanup.
       * @param {CutoverPlanOptions} options
       */
      planCutover(options) {
        validateSpec(snapshot)
        const validated = validateCutoverOptions(options, snapshot.tables)
        const description = buildCutoverDescription(snapshot.tables, validated)
        return Object.freeze({
          verificationGate: description.verificationGate,
          retentionPhase: description.retentionPhase,
          steps: description.steps,
          rollbackSteps: description.rollbackSteps,
          retained: description.retained,
          /**
           * @param {CutoverAdapterLike} adapter
           * @param {CutoverVerifyOptions} args
           * @returns {Promise<CutoverVerificationReport>}
           */
          async verify(adapter, args) {
            return verifyCutoverState(adapter, {
              verificationReport: args.verificationReport,
              columns: description.columns,
              steps: description.steps,
              rollbackSteps: description.rollbackSteps,
              retained: description.retained
            })
          },
          /**
           * @param {CutoverAdapterLike} adapter
           * @param {CutoverExecuteOptions} args
           */
          async execute(adapter, args) {
            assertRetentionPhase(args, "cutover")
            const report = await verifyCutoverState(adapter, {
              verificationReport: args.verificationReport,
              columns: description.columns,
              steps: description.steps,
              rollbackSteps: description.rollbackSteps,
              retained: description.retained
            })
            if (!report.ok) throw new Error(report.problems.join("; "))
            await applyCutoverColumns(adapter, description.columns)
          },
          /**
           * @param {CutoverAdapterLike} adapter
           * @param {CutoverRollbackOptions} args
           */
          async rollback(adapter, args) {
            assertRetentionPhase(args, "rollback")
            await rollbackCutoverColumns(adapter, description.rollbackColumns)
          }
        })
      }
    })
  }
}
