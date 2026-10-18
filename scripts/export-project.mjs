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

function checkWindowFormat(project) {
  if (
    ![1, 2].includes(project?.schemaVersion) ||
    !project.publish ||
    !project.window ||
    !Array.isArray(project.widgets)
  )
    throw new Error(
      'Invalid project: expected schemaVersion 1 or 2, window, widgets and publish settings',
    );
  if (project.schemaVersion === 1 && Object.hasOwn(project, 'windows'))
    throw new Error('schemaVersion 1 cannot contain windows; use schemaVersion 2');
  if (
    project.schemaVersion === 2 &&
    (!Array.isArray(project.windows) || project.windows.length > 31)
  )
    throw new Error(
      'schemaVersion 2 requires a windows array containing at most 31 additional windows',
    );
  const windows = [
    { id: 'main', config: project.window, widgets: project.widgets },
    ...(project.windows ?? []),
  ];
  const ids = new Set(['main']);
  for (const window of windows.slice(1)) {
    if (
      !window ||
      typeof window.id !== 'string' ||
      window.id.match(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)?.[0] !== window.id ||
      window.id === 'main'
    )
      throw new Error('Additional window ID must be safe ASCII and cannot be main');
    if (ids.has(window.id)) throw new Error(`Duplicate window ID: ${window.id}`);
    if (
      typeof window.name !== 'string' ||
      !window.name.trim() ||
      window.name.length > 200 ||
      !window.config ||
      !Array.isArray(window.widgets) ||
      typeof window.openOnStart !== 'boolean'
    )
      throw new Error(`Invalid window definition: ${window.id}`);
    ids.add(window.id);
  }
  const widgetIds = new Set();
  const variables = new Set(
    (project.variables ?? []).flatMap((variable) => [variable.id, variable.name]),
  );
  const flows = new Set((project.flows ?? []).map((flow) => flow.id));
  const modules = new Map((project.modules ?? []).map((module) => [module.id, module]));
  if (modules.size !== (project.modules ?? []).length) throw new Error('Duplicate module IDs');
  const checkWidgets = (widgets, scope) => {
    const byId = new Map(widgets.map((widget) => [widget.id, widget]));
    if (byId.size !== widgets.length) throw new Error(`Duplicate widget IDs in ${scope}`);
    for (const widget of widgets) {
      if (widget.parentId && !byId.has(widget.parentId))
        throw new Error(`Missing parent in ${scope}: ${widget.parentId}`);
      for (const binding of Object.values(widget.bindings ?? {}))
        if (!variables.has(binding.variable))
          throw new Error(`Missing variable: ${binding.variable}`);
      for (const flow of Object.values(widget.events ?? {}))
        if (!flows.has(flow)) throw new Error(`Missing flow: ${flow}`);
      if (widget.type === 'module' && !modules.has(widget.moduleId))
        throw new Error(`Missing module: ${widget.moduleId}`);
    }
    const complete = new Set();
    for (const widget of widgets) {
      const visiting = new Set();
      let cursor = widget.id;
      while (cursor && !complete.has(cursor)) {
        if (visiting.has(cursor)) throw new Error(`Cyclic parent reference in ${scope}`);
        visiting.add(cursor);
        cursor = byId.get(cursor)?.parentId;
      }
      for (const id of visiting) complete.add(id);
    }
    return new Set(byId.keys());
  };
  for (const window of windows) {
    checkWidgets(window.widgets, window.id);
    for (const widget of window.widgets) {
      if (widgetIds.has(widget.id))
        throw new Error('Widget IDs must be unique across all project windows');
      widgetIds.add(widget.id);
    }
  }
  const assets = new Set((project.assets ?? []).map((asset) => asset.id));
  for (const icon of [
    ...windows.map((window) => window.config.icon),
    project.publish.icon,
    project.publish.shortcutIcon,
  ])
    if (icon && !assets.has(icon)) throw new Error(`Missing icon asset: ${icon}`);
  const indegree = new Map([...modules.keys()].map((id) => [id, 0]));
  const edges = new Map();
  for (const [id, module] of modules) {
    if (!Array.isArray(module.widgets)) throw new Error(`Invalid widgets in module ${id}`);
    const local = checkWidgets(module.widgets, id);
    for (const property of Object.values(module.exposedProps ?? {})) {
      const valid =
        module.implementation?.kind === 'react'
          ? property.widgetId === '$component'
          : local.has(property.widgetId);
      if (!valid)
        throw new Error(`Missing exposed widget target in module ${id}: ${property.widgetId}`);
    }
    const children = module.widgets
      .filter((widget) => widget.type === 'module')
      .map((widget) => widget.moduleId);
    edges.set(id, children);
    for (const child of children) indegree.set(child, indegree.get(child) + 1);
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    visited++;
    for (const child of edges.get(queue[index]) ?? []) {
      const degree = indegree.get(child) - 1;
      indegree.set(child, degree);
      if (degree === 0) queue.push(child);
    }
  }
  if (visited !== modules.size) throw new Error('Cyclic module reference');
  for (const flow of project.flows ?? [])
    for (const node of flow.nodes ?? []) {
      if (node.kind !== 'window') continue;
      if (project.schemaVersion !== 2) throw new Error('Window flow nodes require schemaVersion 2');
      const { action, windowId } = node.config ?? {};
      if (!['open', 'close', 'focus'].includes(action) || !ids.has(windowId))
        throw new Error(`Invalid window action or target: ${node.id}`);
      if (action === 'close' && windowId === 'main')
        throw new Error('Window flow nodes cannot close the main window');
    }
}

export function runtimeConfig(base, project) {
  checkWindowFormat(project);
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
      url: 'index.html?runtime=1&windowId=main',
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
  checkWindowFormat(project);
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
