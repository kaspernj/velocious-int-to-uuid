# Changelog

## Unreleased

- Add deterministic, batched, resumable backfill (plan.backfill) deriving RFC 4122 v5 UUIDs from a caller-supplied namespace, with progress callbacks.
- Add read-only verification gates (plan.verifyBackfill): completeness, uuid_id uniqueness, join-based referential consistency, and informational orphan counts.
- verifyBackfill now fails closed on polymorphic rows whose discriminator is not one of the declared mappings (or is NULL): such rows have no safe backfill target and are flagged regardless of what the shadow UUID currently holds (an arbitrary pre-populated UUID no longer lets them pass), and the report names the unmapped discriminator values instead of silently passing.
- Compare polymorphic discriminators byte-exactly (case-sensitive) via the MariaDB/MySQL BINARY operator in backfill selection/update, per-mapping verification, and unmapped detection, so distinct manifest mappings (e.g. `User` vs `user`) cannot alias under a case-insensitive column collation.
- Reject unsafe JavaScript `number` ids (values past 2^53 that a driver may have rounded) at the boundary in backfill and uuidForRecord, directing callers to return large ids as strings or bigint; valid integer strings and bigint are unchanged.
- Document that verifyBackfill performs independent reads and is a valid cutover gate only with writes quiesced or a caller-supplied consistent-snapshot transaction/runner.
- Export uuidForRecord and uuidV5 so application dual-writes derive byte-identical UUIDs.

## 0.1.1

- Type MigrationLike.addIndex columns as a mutable array so checkJs consumers can satisfy the contract with real Velocious migrations.
- Build the package automatically on pack/publish (prepack), so publishing from a clean checkout can no longer produce a tarball without dist/. The npm velocious-int-to-uuid@0.1.0 tarball is missing dist/ and is uninstallable; republish as a patch release (this release).

## 0.1.0

- Add strict manifest validation and additive, idempotent UUID shadow schema expansion.
- Document explicit safety boundaries and deferred migration phases.
