#!/usr/bin/env node
/** Build an exact upstream revision. No third-party compiler code is vendored. */
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const commit = 'e23dabed154a8495f3ac1ff3cc9d04fa1c207893';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = join(root, '.toolchain');
const srcRoot = join(prefix, 'src');
const source = join(srcRoot, `tinycc-${commit}`);
const archive = join(srcRoot, `tinycc-${commit}.tar.gz`);
const windows = process.platform === 'win32';
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}
await mkdir(srcRoot, { recursive: true });
try {
  await access(archive);
} catch {
  const response = await fetch(`https://codeload.github.com/TinyCC/tinycc/tar.gz/${commit}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`TinyCC download failed (${response.status})`);
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
}
run('tar', ['-xzf', archive, '-C', srcRoot]);
const portablePrefix = prefix.replaceAll('\\', '/');
run(
  'sh',
  [
    'configure',
    `--prefix=${portablePrefix}`,
    `--libdir=${portablePrefix}/lib`,
    `--tccdir=${portablePrefix}/lib/tcc`,
    '--disable-static',
    '--config-bcheck=no',
    `--cc=${process.env.CC || (windows ? 'gcc' : 'clang')}`,
    ...(windows ? ['--config-mingw32'] : []),
  ],
  source,
);
// TinyCC's Darwin flat namespace can bind public internal variables (notably
// parse_flags) to unrelated Apple framework symbols. The upstream ONE_SOURCE
// build makes compiler internals static while preserving the public libtcc API.
run(process.env.MAKE || 'make', ['clean'], source);
run(process.env.MAKE || 'make', ['-j4', 'ONE_SOURCE=yes'], source);
run(process.env.MAKE || 'make', ['install', 'ONE_SOURCE=yes'], source);
await mkdir(join(prefix, 'lib'), { recursive: true });
const library = windows
  ? 'libtcc.dll'
  : process.platform === 'darwin'
    ? 'libtcc.dylib'
    : 'libtcc.so';
await copyFile(join(source, library), join(prefix, 'lib', library));
await mkdir(join(prefix, 'licenses'), { recursive: true });
await copyFile(join(source, 'COPYING'), join(prefix, 'licenses', 'TinyCC-COPYING'));
const sha256 = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
await writeFile(
  join(prefix, 'tinycc-build.json'),
  JSON.stringify(
    {
      commit,
      source: `https://github.com/TinyCC/tinycc/tree/${commit}`,
      archiveSha256: sha256,
      oneSource: true,
      platform: process.platform,
      arch: process.arch,
      library: `lib/${library}`,
      builtAt: new Date().toISOString(),
      note: 'Development compiler build only. Signed/notarized macOS JIT support requires separate verification and may require allocator adaptation.',
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `TinyCC installed: ${join(prefix, 'lib', library)}\nVerify with: cargo run -p quickgui-c-runner -- --self-test`,
);
