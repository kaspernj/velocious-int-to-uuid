import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {string} uuid */
function uuidToBytes(uuid) {
  if (typeof uuid !== "string" || !UUID.test(uuid)) {
    throw new TypeError("namespace must be a UUID string")
  }
  return Buffer.from(uuid.replace(/-/g, ""), "hex")
}

/** @param {Buffer} bytes */
function bytesToUuid(bytes) {
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * RFC 4122 version-5 (SHA-1, name-based) UUID.
 * @param {string} namespaceUuid Namespace UUID.
 * @param {string} name Name within the namespace.
 * @returns {string} Lowercase 36-character UUID.
 */
export function uuidV5(namespaceUuid, name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("name must be a non-empty string")
  }
  const hash = createHash("sha1").update(uuidToBytes(namespaceUuid)).update(name, "utf8").digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  return bytesToUuid(bytes)
}

/**
 * The deterministic UUID for a legacy integer-keyed row: uuidV5 of
 * `${table}:${id}` in the application's namespace. Backfill, verification,
 * and application dual-writes must all derive through this one function so
 * they agree byte-for-byte.
 * @param {object} args Arguments.
 * @param {string} args.namespace Application namespace UUID; keep it stable and treat it as a secret so public UUIDs are not enumerable from integer ids.
 * @param {string} args.table Target table name owning the row.
 * @param {number | bigint | string} args.id Legacy integer primary key.
 * @returns {string} Lowercase 36-character UUID.
 */
export function uuidForRecord({ namespace, table, id }) {
  if (typeof table !== "string" || table.length === 0) {
    throw new TypeError("table must be a non-empty string")
  }
  if (typeof id === "number" && !Number.isSafeInteger(id)) {
    throw new TypeError(`id must be a safe integer; got the unsafe number ${String(id)} — return large ids as strings or bigint so precision is not lost`)
  }
  const idString = typeof id === "bigint" ? id.toString() : String(id)
  if (!/^[0-9]+$/.test(idString)) {
    throw new TypeError(`id must be a non-negative integer, got ${String(id)}`)
  }
  return uuidV5(namespace, `${table}:${idString}`)
}
