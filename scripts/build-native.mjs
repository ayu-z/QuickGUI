import { cp, mkdir, access, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateIcons } from './icons.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
if (targetIndex >= 0 && !target) throw new Error('--target requires a Rust target triple');
const release = !args.includes('--debug');
const profile = release ? 'release' : 'debug';

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  if (result.error?.code === 'ENOENT')
    throw new Error(`Required build tool is missing: ${command}`);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed (${result.signal ?? result.status})`,
    );
  return result;
}
async function exists(file) {
  if (!file) return false;
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!['win32', 'darwin'].includes(process.platform))
    throw new Error('The supported native packaging hosts are Windows and macOS.');
  if (
    target &&
    ((process.platform === 'darwin' && !target.includes('apple-darwin')) ||
      (process.platform === 'win32' && !target.includes('windows')))
  )
    throw new Error(
      'Build installers on the target operating system; this script does not pretend to cross-package native windows.',
    );
  run('rustc', ['--version']);
  run('cargo', ['--version']);
  const cargoArgs = ['build', '-p', 'quickgui-c-runner'];
  if (release) cargoArgs.push('--release');
  if (target) cargoArgs.push('--target', target);
  const directory = path.join(root, 'src-tauri/resources/c-runner');
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory))
    if (entry !== 'README.txt')
      await rm(path.join(directory, entry), { recursive: true, force: true });
  const executable = process.platform === 'win32' ? 'quickgui-c-runner.exe' : 'quickgui-c-runner';
  const aot =
    args.includes('--aot') ||
    (!args.includes('--jit') && (await exists(path.join(root, 'project.json'))));
  if (aot) {
    const project = path.join(root, 'project.json');
    if (!(await exists(project)))
      throw new Error('AOT packaging requires an exported project.json.');
    run(process.execPath, [
      path.join(root, 'scripts/build-aot.mjs'),
      project,
      directory,
      ...(target ? ['--target', target] : []),
    ]);
  } else {
    run('cargo', cargoArgs);
    const libraryNames =
      process.platform === 'win32' ? ['libtcc.dll', 'tcc.dll'] : ['libtcc.dylib'];
    const candidates = [
      process.env.QG_LIBTCC,
      ...libraryNames.flatMap((name) => [
        path.join(root, '.toolchain/lib', name),
        path.join(root, '.toolchain/bin', name),
      ]),
    ];
    let library;
    for (const candidate of candidates)
      if (await exists(candidate)) {
        library = candidate;
        break;
      }
    if (!library)
      throw new Error(
        'TinyCC shared library is missing. Run node scripts/setup-tcc.mjs or set QG_LIBTCC to a compatible libtcc; no runtime package was built.',
      );
    const runtime = process.env.QG_TCC_HOME ?? path.join(root, '.toolchain/lib/tcc');
    if (!(await exists(runtime)))
      throw new Error(
        'TinyCC support files are missing. Set QG_TCC_HOME to the directory containing include/ and libtcc1.a.',
      );
    const binary = path.join(root, 'target', ...(target ? [target] : []), profile, executable);
    await cp(binary, path.join(directory, executable));
    await cp(library, path.join(directory, libraryNames[0]));
    await cp(runtime, path.join(directory, 'tcc'), { recursive: true });
    await rm(path.join(directory, 'aot-manifest.json'), { force: true });
    run(path.join(directory, executable), ['--self-test'], {
      env: {
        ...process.env,
        QG_LIBTCC: path.join(directory, libraryNames[0]),
        QG_TCC_HOME: path.join(directory, 'tcc'),
      },
    });
    const notice = path.join(root, '.toolchain/licenses/TinyCC-COPYING');
    if (!(await exists(notice)))
      throw new Error(
        'TinyCC redistribution notice is missing: .toolchain/licenses/TinyCC-COPYING',
      );
    await cp(notice, path.join(directory, 'TinyCC-LICENSE.txt'));
    const provenance = path.join(root, '.toolchain/tinycc-build.json');
    if (await exists(provenance)) await cp(provenance, path.join(directory, 'tinycc-build.json'));
  }
  await generateIcons(root);
  const manifest = {
    platform: process.platform,
    arch: process.arch,
    target: target ?? 'host',
    profile,
    mode: aot ? 'aot' : 'jit',
    builtAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(directory, 'build-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  if (args.includes('--prepare')) {
    console.log(`Native resources prepared in ${directory}`);
    return;
  }
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  run(process.execPath, [
    cli,
    'build',
    ...(release ? [] : ['--debug']),
    ...(target ? ['--target', target] : []),
  ]);
}

main().catch((error) => {
  console.error(`Native build failed: ${error.message}`);
  process.exitCode = 1;
});
