#!/usr/bin/env node
/** Standard-tool standalone build: node scripts/build-aot.mjs project.json [output-dir]
 * Also accepts a single .c file. Outputs one native worker per distinct source. */
import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const targetAt = args.indexOf('--target');
let requestedTarget;
if (targetAt >= 0) {
  requestedTarget = args[targetAt + 1];
  if (!requestedTarget) throw new Error('--target requires a Rust target triple');
  args.splice(targetAt, 2);
}
if (args.some((arg) => arg.startsWith('--'))) throw new Error('Unknown option to build-aot');
const rustInfo = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
const hostTarget = rustInfo.stdout?.match(/^host: (.+)$/m)?.[1];
if (!hostTarget) throw new Error('Cannot determine the installed Rust host target');
const targetTriple = requestedTarget || hostTarget;
if (targetTriple !== hostTarget)
  throw new Error(
    `AOT cross compilation is not configured: host=${hostTarget}, target=${targetTriple}. Build natively on the target CI runner.`,
  );
const input = resolve(args[0] || join(root, 'sdk/aot/example.c'));
const output = resolve(args[1] || join(root, '.toolchain/aot-workers'));
const content = await readFile(input, 'utf8');
const scripts = input.endsWith('.c')
  ? [{ id: 'module', source: content }]
  : JSON.parse(content).scripts;
if (!Array.isArray(scripts))
  throw new Error('Expected a QuickGUI project with scripts[] or a C source file');
await mkdir(output, { recursive: true });
const manifest = {};
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}
for (const script of scripts) {
  const hash = createHash('sha256').update(script.source).digest('hex');
  if (manifest[hash]) continue;
  const work = join(root, '.toolchain/aot', hash);
  await mkdir(work, { recursive: true });
  const source = join(work, 'script.c');
  await writeFile(source, script.source);
  const build = join(work, 'build');
  const compiler = process.env.CC || (process.platform === 'win32' ? undefined : 'clang');
  run('cmake', [
    '-S',
    join(root, 'sdk/aot'),
    '-B',
    build,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DQG_SCRIPT_SOURCE=${source}`,
    ...(compiler ? [`-DCMAKE_C_COMPILER=${compiler}`] : []),
  ]);
  run('cmake', ['--build', build, '--config', 'Release']);
  // Reuse Rust dependency artifacts; the source/library env changes rerun build.rs.
  const target = join(root, '.toolchain/aot-target');
  run(
    'cargo',
    [
      'build',
      '--release',
      '-p',
      'quickgui-c-runner',
      '--features',
      'aot',
      '--target',
      targetTriple,
    ],
    { QG_AOT_LIBRARY_DIR: join(build, 'lib'), QG_AOT_SOURCE: source, CARGO_TARGET_DIR: target },
  );
  const executable = process.platform === 'win32' ? 'quickgui-c-runner.exe' : 'quickgui-c-runner';
  const name = `qg-c-${hash.slice(0, 16)}${process.platform === 'win32' ? '.exe' : ''}`;
  await copyFile(join(target, targetTriple, 'release', executable), join(output, name));
  if (process.platform !== 'win32') await chmod(join(output, name), 0o755);
  manifest[hash] = name;
}
await writeFile(join(output, 'aot-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `AOT workers: ${output}\nPackage this directory and sign the workers for the target platform.`,
);
