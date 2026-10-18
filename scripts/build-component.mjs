import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { readdir, readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
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
const isJson = (value) =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every(isJson)) ||
  (!!value && typeof value === 'object' && Object.values(value).every(isJson));

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

function validateManifest(manifest, files) {
  if (manifest.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1');
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,99}$/.test(manifest.id ?? ''))
    throw new Error('manifest.id must be an ASCII component identifier');
  if (typeof manifest.name !== 'string' || !manifest.name || manifest.name.length > 200)
    throw new Error('manifest.name is required (maximum 200 characters)');
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version ?? ''))
    throw new Error('manifest.version must be a semantic version');
  for (const key of ['width', 'height'])
    if (!Number.isFinite(manifest[key]) || manifest[key] <= 0 || manifest[key] > 10_000)
      throw new Error(`manifest.${key} must be between 0 and 10000`);
  if (!safePath(manifest.entry) || !Object.hasOwn(files, manifest.entry))
    throw new Error('manifest.entry must name an included source file');
  if (
    manifest.styles !== undefined &&
    (!safePath(manifest.styles) ||
      !Object.hasOwn(files, manifest.styles) ||
      !manifest.styles.endsWith('.css'))
  )
    throw new Error('manifest.styles must name an included CSS file');
  if (
    !manifest.props ||
    typeof manifest.props !== 'object' ||
    Array.isArray(manifest.props) ||
    !isJson(manifest.props)
  )
    throw new Error('manifest.props must be an object containing JSON defaults');
  for (const key of Object.keys(manifest.props))
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key) ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      throw new Error(`Unsupported property name: ${key}`);
  if (
    !Array.isArray(manifest.events) ||
    manifest.events.length > 64 ||
    new Set(manifest.events).size !== manifest.events.length ||
    manifest.events.some(
      (event) => typeof event !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(event),
    )
  )
    throw new Error('manifest.events must contain unique event names (maximum 64)');
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

export async function buildComponent(sourceDirectory, outputFilename) {
  const root = await realpath(path.resolve(sourceDirectory));
  const files = await readSources(root);
  if (!files['manifest.json'])
    throw new Error('The component directory must contain manifest.json');
  const manifest = JSON.parse(files['manifest.json']);
  validateManifest(manifest, files);
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
    exposedProps: Object.fromEntries(
      Object.entries(manifest.props).map(([name, value]) => [
        name,
        { widgetId: '$component', property: name, default: value },
      ]),
    ),
    implementation: { kind: 'react', files, bundle, events: manifest.events },
  };
  const json = strToU8(JSON.stringify(module, null, 2));
  if (json.byteLength > 20_000_000) throw new Error('Expanded component exceeds 20 MB');
  const bytes = zipSync({ 'module.json': json }, { level: 6 });
  if (bytes.byteLength > 16_000_000) throw new Error('Component package exceeds 16 MB');
  const destination = path.resolve(
    outputFilename ?? path.join(root, '..', `${manifest.id}.qgcomponent`),
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return { module, destination, bytes: bytes.byteLength };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) {
    console.error(
      'Usage: node scripts/build-component.mjs <component-directory> [output.qgcomponent]',
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await buildComponent(process.argv[2], process.argv[3]);
      console.log(
        `Built ${result.module.name} v${result.module.version}: ${result.destination} (${result.bytes} bytes)`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
