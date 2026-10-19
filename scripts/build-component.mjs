import { build } from 'esbuild';
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  lstat,
  realpath,
  rename,
  rm,
  chmod,
} from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.md',
  '.txt',
  '.svg',
  '.html',
  '.yml',
  '.yaml',
]);
const ignored = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'artifacts', 'coverage']);
const safePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 240 &&
  !/^[/.]|[\\:\u0000-\u001f\u007f]/.test(value) &&
  value
    .split('/')
    .every(
      (part) => !!part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part),
    );
const contained = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};
let sharedContract;
async function contracts() {
  sharedContract ??= (async () => {
    // The exported source tree contains these same schemas. Compile them for Node
    // in memory so the CLI and designer accept exactly the same package/project.
    const result = await build({
      stdin: {
        contents: `export { componentManifestSchema, exportComponentPackage, importComponentPackage } from './src/core/componentPackage.ts';
export { validateProject } from './src/core/validation.ts';`,
        resolveDir: path.resolve(scriptRoot, '..'),
        sourcefile: 'quickgui-build-contracts.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    return import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
    );
  })();
  return sharedContract;
}

async function readSources(root) {
  const files = {};
  let total = 0;
  const walk = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.name.endsWith('.qgcomponent')) continue;
      const relative = prefix + entry.name;
      if (!safePath(relative)) throw new Error(`Unsupported component source path: ${relative}`);
      if (entry.isSymbolicLink())
        throw new Error(`Component source symlinks are not supported: ${relative}`);
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filename, `${relative}/`);
        continue;
      }
      if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase()))
        throw new Error(
          `Only UTF-8 source files are supported: ${relative}. Embed binary assets as data URLs.`,
        );
      const stats = await lstat(filename);
      if (stats.size > 1_000_000) throw new Error(`Source file exceeds 1 MB: ${relative}`);
      total += stats.size;
      if (total > 6_000_000 || Object.keys(files).length >= 128)
        throw new Error('Component sources exceed 6 MB or 128 files');
      files[relative] = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filename));
    }
  };
  await walk(root);
  return files;
}

function validateManifest(manifest, files, contract) {
  // componentManifestSchema includes the strict shared propertyDefinitionSchema.
  contract.componentManifestSchema.parse(manifest);
  if (!Object.hasOwn(files, manifest.entry))
    throw new Error('manifest.entry must name an included source file');
  if (
    manifest.styles !== undefined &&
    (!Object.hasOwn(files, manifest.styles) || !manifest.styles.endsWith('.css'))
  )
    throw new Error('manifest.styles must name an included CSS file');
}

const identityFields = ['id', 'name', 'version', 'width', 'height'];
function identity(module) {
  return Object.fromEntries(identityFields.map((key) => [key, module[key]]));
}
async function readProjectUpdate(options, contract) {
  if (Boolean(options.project) !== Boolean(options.module))
    throw new Error(
      '--project and --module must be supplied together; choose the exact local module ID',
    );
  if (!options.project) return undefined;
  const filename = await realpath(path.resolve(options.project));
  const stats = await lstat(filename);
  if (!stats.isFile() || stats.size > 30_000_000)
    throw new Error('Project must be a JSON file no larger than 30 MB');
  const text = await readFile(filename, 'utf8');
  const project = contract.validateProject(JSON.parse(text));
  const index = project.modules.findIndex((module) => module.id === options.module);
  if (index < 0)
    throw new Error(
      `No local module has ID ${options.module}; manifest IDs are not used for target selection`,
    );
  if (project.modules[index].implementation?.kind !== 'react')
    throw new Error('Only a React module can be rebuilt from component sources');
  return { filename, text, project, index, mode: stats.mode & 0o777 };
}
async function stageFile(destination, bytes, mode) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) await chmod(temporary, mode);
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
async function publishBuild(destination, bytes, update, candidate) {
  let packageTemp, projectTemp;
  try {
    packageTemp = await stageFile(destination, bytes);
    if (update) {
      const text = JSON.stringify(candidate, null, 2) + '\n';
      if (Buffer.byteLength(text) > 30_000_000)
        throw new Error('Rebuilt project exceeds the 30 MB limit');
      projectTemp = await stageFile(update.filename, text, update.mode);
      if ((await readFile(update.filename, 'utf8')) !== update.text)
        throw new Error('Project changed during the build; no project update was applied');
    }
    await rename(packageTemp, destination);
    packageTemp = undefined;
    if (update) {
      if ((await readFile(update.filename, 'utf8')) !== update.text)
        throw new Error('Project changed during the build; no project update was applied');
      // A same-directory rename publishes the whole validated document at once.
      await rename(projectTemp, update.filename);
      projectTemp = undefined;
    }
  } finally {
    await Promise.all(
      [packageTemp, projectTemp].filter(Boolean).map((file) => rm(file, { force: true })),
    );
  }
}

function mountEntry(entry, styles) {
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import Component from ${JSON.stringify(entry)};
${styles ? `import ${JSON.stringify(styles)};` : ''}
class ComponentBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error: String(error) }; }
  componentDidUpdate(previous) { if (this.state.error && previous.revision !== this.props.revision) this.setState({ error: null }); }
  render() { return this.state.error ? React.createElement('div', { role: 'alert', style: { padding: 12, color: '#f87171', fontSize: 12 } }, this.state.error) : this.props.children; }
}
export function mount(container, initialProps, emit, initialContext) {
  const shadow = container.shadowRoot || container.attachShadow({ mode: 'open' });
  shadow.replaceChildren();
  const styles = document.createElement('style');
  styles.textContent = ':host{display:block;width:100%;height:100%;font:inherit;color:inherit}*,*::before,*::after{box-sizing:border-box}' + __QUICKGUI_SHADOW_CSS__;
  const point = document.createElement('div');
  point.style.cssText = 'width:100%;height:100%;overflow:hidden';
  shadow.append(styles, point);
  const root = createRoot(point);
  let props = initialProps, context = initialContext, alive = true, revision = 0, tokenNames = [];
  const dispatch = (name, payload = null) => { if (alive && context.interactive) emit(name, payload); };
  const render = () => {
    for (const name of tokenNames) point.style.removeProperty(name);
    tokenNames = [];
    for (const [key, value] of Object.entries(context.theme.tokens)) { const name = '--qg-' + key.replace('color.', ''); tokenNames.push(name); point.style.setProperty(name, value); }
    point.dataset.theme = context.theme.mode; point.lang = context.locale;
    root.render(React.createElement(ComponentBoundary, { revision }, React.createElement(Component, { props, emit: dispatch, context })));
  };
  render();
  return {
    update(nextProps, nextContext) { if (!alive) return; props = nextProps; context = nextContext; revision++; render(); },
    unmount() { if (!alive) return; alive = false; root.unmount(); shadow.replaceChildren(); }
  };
}`;
}

export async function buildComponent(sourceDirectory, outputFilename, options = {}) {
  const contract = await contracts();
  const update = await readProjectUpdate(options, contract);
  const root = await realpath(path.resolve(sourceDirectory));
  const files = await readSources(root);
  if (!files['manifest.json'])
    throw new Error('The component directory must contain manifest.json');
  const manifest = JSON.parse(files['manifest.json']);
  validateManifest(manifest, files, contract);
  if (update) {
    const previous = update.project.modules[update.index];
    const expected = previous.packageIdentity ?? identity(previous);
    for (const key of identityFields)
      if (manifest[key] !== expected[key])
        throw new Error(
          `Source manifest ${key} differs from this module's immutable package identity; import it as a new component instead`,
        );
  }
  const dependencies = path.resolve(scriptRoot, '../node_modules');
  const result = await build({
    stdin: {
      contents: mountEntry(
        path.join(root, manifest.entry),
        manifest.styles ? path.join(root, manifest.styles) : null,
      ),
      resolveDir: root,
      sourcefile: 'quickgui-component-entry.tsx',
      loader: 'tsx',
    },
    absWorkingDir: root,
    outfile: path.join(root, 'component.js'),
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    legalComments: 'inline',
    charset: 'utf8',
    metafile: true,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [dependencies],
    loader: { '.svg': 'dataurl' },
    plugins: [
      {
        name: 'component-boundaries',
        setup(build) {
          build.onResolve({ filter: /^https?:\/\// }, (args) => ({
            errors: [{ text: `Remote imports are not supported: ${args.path}` }],
          }));
          build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
            const file = await realpath(args.path);
            if (!contained(root, file) && !contained(dependencies, file))
              return {
                errors: [{ text: `Import escapes the component source directory: ${args.path}` }],
              };
            return undefined;
          });
        },
      },
    ],
  });
  const output = result.outputFiles.find((file) => file.path.endsWith('.js'));
  if (!output) throw new Error('The component did not produce JavaScript');
  for (const emitted of Object.values(result.metafile.outputs))
    if (emitted.imports.some((item) => item.external))
      throw new Error('The component bundle must not contain external module imports');
  const css = result.outputFiles
    .filter((file) => file.path.endsWith('.css'))
    .map((file) => file.text)
    .join('\n');
  const bundle = `const __QUICKGUI_SHADOW_CSS__=${JSON.stringify(css)};\n${output.text}`;
  if (Buffer.byteLength(bundle) > 8_000_000) throw new Error('Compiled component exceeds 8 MB');
  const module = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    width: manifest.width,
    height: manifest.height,
    widgets: [],
    ...(manifest.propertyDefinitions ? { propertyDefinitions: manifest.propertyDefinitions } : {}),
    exposedProps: Object.fromEntries(
      Object.entries(manifest.props).map(([name, value]) => [
        name,
        { widgetId: '$component', property: name, default: value },
      ]),
    ),
    implementation: { kind: 'react', files, bundle, events: manifest.events },
  };
  let rebuilt = module,
    candidate;
  if (update) {
    candidate = structuredClone(update.project);
    const previous = candidate.modules[update.index];
    rebuilt = {
      ...previous,
      implementation: module.implementation,
      exposedProps: module.exposedProps,
    };
    if (module.propertyDefinitions === undefined) delete rebuilt.propertyDefinitions;
    else rebuilt.propertyDefinitions = module.propertyDefinitions;
    candidate.modules[update.index] = rebuilt;
    candidate.revision += 1;
    candidate = contract.validateProject(candidate);
  }
  const portable =
    manifest.schemaVersion === 2 && !rebuilt.packageIdentity
      ? { ...rebuilt, packageIdentity: identity(manifest) }
      : rebuilt;
  const bytes = contract.exportComponentPackage(portable, candidate);
  // Do not publish an artifact that the designer's current importer will reject.
  contract.importComponentPackage(bytes);
  if (JSON.stringify(await readSources(root)) !== JSON.stringify(files))
    throw new Error(
      'Component source files changed during the build; retry from a stable source snapshot',
    );
  const requestedName = options.module ?? manifest.id;
  const artifactName = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/.test(requestedName)
    ? requestedName
    : `${manifest.id}-${createHash('sha256').update(requestedName).digest('hex').slice(0, 12)}`;
  const destination = path.resolve(
    outputFilename ?? path.join(root, '..', `${artifactName}.qgcomponent`),
  );
  if (
    destination === update?.filename ||
    (options.project && destination === path.resolve(options.project)) ||
    (contained(root, destination) &&
      Object.hasOwn(files, path.relative(root, destination).split(path.sep).join('/')))
  )
    throw new Error('Component package destination cannot overwrite a source or project file');
  await publishBuild(destination, bytes, update, candidate);
  return {
    module: rebuilt,
    destination,
    bytes: bytes.byteLength,
    ...(update ? { project: update.filename, localModuleId: options.module } : {}),
  };
}

function parseArguments(args) {
  const positional = [],
    options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project' || arg === '--module') {
      const key = arg.slice(2);
      if (options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--'))
        throw new Error(`${arg} requires one value and cannot be repeated`);
      options[key] = args[++i];
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (!positional.length || positional.length > 2)
    throw new Error(
      'Usage: node scripts/build-component.mjs <component-directory> [output.qgcomponent] [--project project.json --module localModuleId]',
    );
  if (Boolean(options.project) !== Boolean(options.module))
    throw new Error(
      '--project and --module must be supplied together; choose the exact local module ID',
    );
  return { source: positional[0], output: positional[1], options };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { source, output, options } = parseArguments(process.argv.slice(2));
    const result = await buildComponent(source, output, options);
    console.log(
      `Built ${result.module.name} v${result.module.version}: ${result.destination} (${result.bytes} bytes)${result.project ? `\nUpdated local module ${result.localModuleId} in ${result.project}` : ''}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
