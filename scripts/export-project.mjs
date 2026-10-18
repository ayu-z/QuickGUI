import { mkdir, readFile, writeFile, cp, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = [
  'src/core',
  'src/runtime',
  'src/renderer',
  'src/native',
  'crates',
  'sdk',
  'templates',
  'scripts',
  'src-tauri/src',
  'src-tauri/icons',
  'src-tauri/capabilities',
  'src-tauri/resources/c-runner/README.txt',
  'src-tauri/Cargo.toml',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'Cargo.toml',
  'Cargo.lock',
  'LICENSE',
  'LICENSE-MIT',
  'LICENSE-APACHE',
];

export function decodeProject(bytes) {
  if (bytes.length > 30_000_000) throw new Error('Project exceeds the 30 MB import limit');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let oversized = false;
    const files = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name !== 'quickgui.json') return false;
        if (entry.originalSize > 30_000_000) {
          oversized = true;
          return false;
        }
        return true;
      },
    });
    if (oversized) throw new Error('Expanded project exceeds the 30 MB import limit');
    if (!files['quickgui.json']) throw new Error('Archive is missing quickgui.json');
    return JSON.parse(strFromU8(files['quickgui.json']));
  }
  return JSON.parse(strFromU8(bytes));
}

export function runtimeConfig(base, project) {
  const config = structuredClone(base);
  const publish = project.publish;
  for (const [target, source] of [
    ['productName', 'appName'],
    ['identifier', 'identifier'],
    ['version', 'version'],
  ])
    if (publish[source]) config[target] = publish[source];
  if (publish.publisher) config.bundle.publisher = publish.publisher;
  config.app.windows = [
    {
      label: 'preview',
      url: 'index.html?runtime=1',
      decorations: true,
      ...Object.fromEntries(
        [
          'title',
          'width',
          'height',
          'minWidth',
          'minHeight',
          'resizable',
          'alwaysOnTop',
          'fullscreen',
          'maximized',
          'center',
        ].map((key) => [key, project.window[key]]),
      ),
    },
  ];
  return config;
}

export async function exportProject(project, outputDir, root = sourceRoot) {
  if (project.schemaVersion !== 1 || !project.publish || !project.window)
    throw new Error('Invalid project: expected schemaVersion 1, window and publish settings');
  const output = path.resolve(outputDir);
  if (output === root || root.startsWith(output + path.sep))
    throw new Error('Export destination cannot contain the source repository');
  for (const entry of paths)
    if (output === path.join(root, entry) || output.startsWith(path.join(root, entry) + path.sep))
      throw new Error('Export destination cannot be inside a copied source directory');
  try {
    if ((await readdir(output)).length)
      throw new Error('Source export requires an empty output directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(output, { recursive: true });
  for (const relative of paths) {
    const from = path.join(root, relative);
    try {
      await access(from);
    } catch {
      continue;
    }
    await cp(from, path.join(output, relative), {
      recursive: true,
      dereference: false,
      filter: (source) =>
        !source
          .split(path.sep)
          .some((segment) =>
            ['node_modules', 'target', 'dist', 'gen', '.git', '.toolchain'].includes(segment),
          ),
    });
  }
  await cp(path.join(root, 'templates/runtime'), output, { recursive: true, force: true });
  await writeFile(path.join(output, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  const configPath = path.join(output, 'src-tauri/tauri.conf.json');
  const config = runtimeConfig(JSON.parse(await readFile(configPath, 'utf8')), project);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  await mkdir(path.join(output, 'project-scripts'), { recursive: true });
  for (const [i, script] of (project.scripts ?? []).entries())
    await writeFile(path.join(output, 'project-scripts', `script-${i}.c`), script.source);
  for (const [index, component] of (project.modules ?? []).entries()) {
    const files = component.implementation?.files;
    if (!files) continue;
    const id =
      typeof component.id === 'string' &&
      component.id.match(/^[A-Za-z][A-Za-z0-9._-]{0,99}$/)?.[0] === component.id
        ? component.id
        : `module-${index}`;
    for (const [relative, text] of Object.entries(files)) {
      if (
        typeof text !== 'string' ||
        !relative ||
        /[\x00-\x1f\x7f]/.test(relative) ||
        relative.includes('\\') ||
        relative.includes(':') ||
        relative.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error(`Unsafe component source path: ${relative}`);
      const destination = path.join(output, 'components', id, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, text);
    }
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , projectFile, destination] = process.argv;
  if (!projectFile || !destination) {
    console.error(
      'Usage: node scripts/export-project.mjs <project.qgui|json> <empty-output-directory>',
    );
    process.exitCode = 1;
  } else
    exportProject(decodeProject(await readFile(projectFile)), destination)
      .then((dir) =>
        console.log(`Source exported to ${dir}\nBuild with npm install && npm run desktop:build`),
      )
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
