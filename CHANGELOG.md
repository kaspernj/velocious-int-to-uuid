# Changelog

## Unreleased

- Add deterministic, batched, resumable backfill (plan.backfill) deriving RFC 4122 v5 UUIDs from a caller-supplied namespace, with progress callbacks.
- Add read-only verification gates (plan.verifyBackfill): completeness, uuid_id uniqueness, join-based referential consistency, and informational orphan counts.
- Export uuidForRecord and uuidV5 so application dual-writes derive byte-identical UUIDs.

## 0.1.1

- Type MigrationLike.addIndex columns as a mutable array so checkJs consumers can satisfy the contract with real Velocious migrations.
- Build the package automatically on pack/publish (prepack), so publishing from a clean checkout can no longer produce a tarball without dist/. The npm velocious-int-to-uuid@0.1.0 tarball is missing dist/ and is uninstallable; republish as a patch release (this release).

## 0.1.0

- Add strict manifest validation and additive, idempotent UUID shadow schema expansion.
- Document explicit safety boundaries and deferred migration phases.
