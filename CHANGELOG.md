# Changelog

## 0.1.1

- Type MigrationLike.addIndex columns as a mutable array so checkJs consumers can satisfy the contract with real Velocious migrations.
- Build the package automatically on pack/publish (prepack), so publishing from a clean checkout can no longer produce a tarball without dist/. The npm velocious-int-to-uuid@0.1.0 tarball is missing dist/ and is uninstallable; republish as a patch release (this release).

## 0.1.0

- Add strict manifest validation and additive, idempotent UUID shadow schema expansion.
- Document explicit safety boundaries and deferred migration phases.
