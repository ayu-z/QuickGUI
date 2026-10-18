# C alias contract tests

`aliases.c` is compiled unchanged by both TinyCC JIT and the native AOT build.
The Rust contract test executes both workers, including two mappings for the same
source, read-after-write through different aliases, name/ID collisions, empty and
unknown scopes, readonly mixed writes, and rollback of C state on failure.

```sh
npm run setup:c
node scripts/build-aot.mjs sdk/tests/aliases.c .toolchain/alias-aot-workers
QG_TEST_AOT_RUNNER="$PWD/.toolchain/alias-aot-workers/quickgui-c-runner" cargo test -p quickgui-c-runner --test aliases -- --ignored
npm run test:c
```

`QG_TEST_AOT_RUNNER` names a lookup location: the host reads the sibling
`aot-manifest.json` and selects the actual executable by source SHA-256. The
source hash intentionally excludes alias maps, so changing a map needs no C
rebuild. These tests cover compilation and execution contracts on the current
host. They do not verify deployment signing, target hardware, or performance.

The C ABI remains 2. A worker must advertise `variableAliases: true` before the
host sends a request containing that field. An explicit empty map is a closed
scope with no accessible variables; omitting it retains legacy names/IDs.
