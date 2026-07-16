set -eu

rm -rf .pack-test
mkdir -p .pack-test/consumer
npm pack --pack-destination .pack-test >/tmp/velocious-int-to-uuid-pack-name
tarball="$(cat /tmp/velocious-int-to-uuid-pack-name)"
cd .pack-test/consumer
npm init --yes >/dev/null
npm pkg set type=module >/dev/null
# Do not install the declared peer here: this proves the packed runtime has no private/runtime import.
npm install --ignore-scripts --legacy-peer-deps "../$tarball" >/dev/null
npm install --ignore-scripts --legacy-peer-deps --save-dev /package/node_modules/typescript >/dev/null
cp /package/fixtures/consumer/runtime.js .
cp /package/fixtures/consumer/typecheck.ts .
cp /package/fixtures/consumer/tsconfig.json .
node runtime.js
npx --no-install tsc --project tsconfig.json
