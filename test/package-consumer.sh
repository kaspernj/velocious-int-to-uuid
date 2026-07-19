set -eu

package_root="$(pwd)"

rm -rf .pack-test
mkdir -p .pack-test/consumer
# npm pack runs prepack (build) and echoes its script banner to stdout; the
# tarball filename is always the last line.
npm pack --pack-destination .pack-test >/tmp/velocious-int-to-uuid-pack-name
tarball="$(tail -n 1 /tmp/velocious-int-to-uuid-pack-name)"
cd .pack-test/consumer
npm init --yes >/dev/null
npm pkg set type=module >/dev/null
# Do not install the declared peer here: this proves the packed runtime has no private/runtime import.
npm install --ignore-scripts --legacy-peer-deps "../$tarball" >/dev/null
npm install --ignore-scripts --legacy-peer-deps --save-dev "$package_root/node_modules/typescript" >/dev/null
cp "$package_root/fixtures/consumer/runtime.js" .
cp "$package_root/fixtures/consumer/typecheck.ts" .
cp "$package_root/fixtures/consumer/tsconfig.json" .
node runtime.js
npx --no-install tsc --project tsconfig.json
