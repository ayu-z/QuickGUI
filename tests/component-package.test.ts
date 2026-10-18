import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  importComponentPackage,
  exportComponentPackage,
  isSafeComponentPath,
} from '../src/core/componentPackage';
import { importProject, exportProject } from '../src/core/archive';
import { createProject, createWidget } from '../src/core/project';
import type { ComponentModule } from '../src/core/types';

function component(): ComponentModule {
  const manifest = {
    schemaVersion: 1,
    id: 'sample.badge',
    name: 'Badge',
    version: '1.0.0',
    entry: 'src/Badge.tsx',
    width: 240,
    height: 100,
    props: { label: 'Ready', value: 4 },
    events: ['activate'],
  };
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    width: manifest.width,
    height: manifest.height,
    widgets: [],
    exposedProps: {
      label: { widgetId: '$component', property: 'label', default: 'Ready' },
      value: { widgetId: '$component', property: 'value', default: 4 },
    },
    implementation: {
      kind: 'react',
      files: {
        'manifest.json': JSON.stringify(manifest),
        'src/Badge.tsx': 'export default function Badge() { return <button>Ready</button> }',
      },
      bundle: 'export function mount() { return { update() {}, unmount() {} }; }',
      events: ['activate'],
    },
  };
}

describe('trusted React component package', () => {
  it('exports source resources and restores package identity after local remapping', () => {
    const project = createProject(),
      module = component();
    module.packageIdentity = {
      id: module.id,
      name: module.name,
      version: module.version,
      width: module.width,
      height: module.height,
    };
    module.id = 'local-copy';
    module.name = 'Local name';
    project.assets = [
      { id: 'logo', name: 'Logo', mime: 'image/png', data: 'data:image/png;base64,YQ==' },
    ];
    const imported = importComponentPackage(exportComponentPackage(module, project));
    expect(imported.id).toBe('sample.badge');
    expect(imported.implementation).toEqual(module.implementation);
    expect(imported.embeddedResourceScope?.theme).toEqual(project.theme);
    expect(imported.embeddedResourceScope?.assets).toEqual(project.assets);
    expect(module.id).toBe('local-copy');
  });
  it('keeps embedded asset precedence and materializes aliases without duplicate IDs', () => {
    const project = createProject(),
      module = component();
    const asset = {
      id: 'asset',
      name: 'Embedded',
      mime: 'image/png',
      data: 'data:image/png;base64,YQ==',
    };
    project.assets = [{ ...asset, id: 'mapped', name: 'Global' }];
    module.embeddedResourceScope = {
      id: 'source',
      theme: project.theme,
      translations: {},
      locale: 'en',
      assetAliases: { asset: 'mapped' },
      assets: [asset],
    };
    const imported = importComponentPackage(exportComponentPackage(module, project));
    expect(imported.embeddedResourceScope?.assets?.filter((entry) => entry.id === 'asset')).toEqual(
      [asset],
    );
    expect(imported.embeddedResourceScope?.assetAliases).toBeUndefined();
  });
  it('round-trips complete original sources, defaults, event declarations and bundle', () => {
    const original = component();
    expect(importComponentPackage(exportComponentPackage(original))).toEqual(original);
  });
  it('accepts equivalent property defaults regardless of object-key order', () => {
    const module = component();
    module.exposedProps = { value: module.exposedProps.value, label: module.exposedProps.label };
    expect(importComponentPackage(exportComponentPackage(module)).exposedProps).toEqual(
      module.exposedProps,
    );
  });
  it('preserves implementation through the original project format', () => {
    const project = createProject(),
      module = component(),
      widget = createWidget('module');
    widget.moduleId = module.id;
    project.modules.push(module);
    project.widgets.push(widget);
    expect(importProject(exportProject(project)).modules[0]).toEqual(module);
  });
  it('parses code without evaluating it', () => {
    const module = component();
    module.implementation!.bundle = 'globalThis.__quickgui_package_test_executed__ = true;';
    importComponentPackage(exportComponentPackage(module));
    expect(Object.hasOwn(globalThis, '__quickgui_package_test_executed__')).toBe(false);
  });
  it.each([
    '../escape.ts',
    '/absolute.ts',
    'src/../../escape.ts',
    'src\\escape.ts',
    'C:/escape.ts',
    'src//file.ts',
    'src/./file.ts',
    'src/\u0000file.ts',
    '__proto__/file.ts',
  ])('rejects unsafe source path %s', (path) => {
    expect(isSafeComponentPath(path)).toBe(false);
    const module = component();
    module.implementation!.files[path] = 'source';
    expect(() => exportComponentPackage(module)).toThrow(/path/i);
  });
  it('rejects incorrect archive shape and invalid source manifests', () => {
    expect(() => importComponentPackage(strToU8('{}'))).toThrow(/ZIP/);
    expect(() => importComponentPackage(zipSync({ '../module.json': strToU8('{}') }))).toThrow(
      /missing/,
    );
    const module = component();
    module.implementation!.files['manifest.json'] = '{}';
    expect(() => exportComponentPackage(module)).toThrow(/manifest/);
  });
  it('rejects source/bundle metadata drift and undeclared source entries', () => {
    const module = component();
    module.implementation!.events.push('other');
    expect(() => exportComponentPackage(module)).toThrow(/event declarations/);
    module.implementation!.events.pop();
    delete module.implementation!.files['src/Badge.tsx'];
    expect(() => exportComponentPackage(module)).toThrow(/entry is missing/);
    const renamed = component();
    renamed.name = 'Changed without source';
    expect(() => exportComponentPackage(renamed)).toThrow(/source manifest/);
  });
  it('enforces UTF-8 file, file count, bundle and input limits', () => {
    const module = component();
    module.implementation!.files['src/large.txt'] = '界'.repeat(334_000);
    expect(() => exportComponentPackage(module)).toThrow(/1 MB/);
    delete module.implementation!.files['src/large.txt'];
    for (let index = 0; index < 128; index++) module.implementation!.files[`src/f${index}.ts`] = '';
    expect(() => exportComponentPackage(module)).toThrow(/128/);
    const bundle = component();
    bundle.implementation!.bundle = 'x'.repeat(8_000_001);
    expect(() => exportComponentPackage(bundle)).toThrow();
    expect(() => importComponentPackage(new Uint8Array(16_000_001))).toThrow(/16 MB/);
  });
});
