import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { importComponentPackage } from '../src/core/componentPackage';
import { createProject, createWidget } from '../src/core/project';
import { upgradeProject } from '../src/core/migration';
import { validateProject } from '../src/core/validation';
import type { ComponentModule, Project } from '../src/core/types';

interface BuildOptions {
  project?: string;
  module?: string;
}
const compiler = (await import(
  /* @vite-ignore */ new URL('../scripts/build-component.mjs', import.meta.url).href
)) as {
  buildComponent(
    source: string,
    output?: string,
    options?: BuildOptions,
  ): Promise<{ module: ComponentModule; destination: string; bytes: number }>;
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
async function fixture(version: 1 | 2 = 2) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quickgui-component-rebuild-'));
  directories.push(directory);
  const source = path.join(directory, 'components/local_copy');
  await mkdir(path.join(source, 'src'), { recursive: true });
  const definition = {
    key: 'label',
    label: { zh: '文字', en: 'Label' },
    group: 'content',
    type: 'string',
    editor: 'text',
    initialValue: 'Ready',
    fallbackValue: 'Ready',
  };
  const manifest = {
    schemaVersion: version,
    id: 'original.card',
    name: 'Original card',
    version: '1.0.0',
    width: 100,
    height: 80,
    entry: 'src/Card.tsx',
    props: { label: 'Ready' },
    events: [],
    ...(version === 2 ? { propertyDefinitions: { label: definition } } : {}),
  };
  const sourceText =
    'export default function Card({props}) { return <span>{props.label}</span>; }\n';
  await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(source, 'src/Card.tsx'), sourceText);
  const built = await compiler.buildComponent(source, path.join(directory, 'initial.qgcomponent'));
  return { directory, source, manifest, sourceText, module: built.module };
}
function projectFor(module: ComponentModule): Project {
  const project = upgradeProject(createProject());
  project.widgets = [];
  project.windows = [];
  project.flows = [];
  project.connections = [];
  project.variables = [{ id: 'count', name: 'count', type: 'number', initial: 2 }];
  project.scripts = [
    {
      id: 'script-copy',
      name: 'Script',
      source:
        '#include "quickgui.h"\nvoid qg_process(void){qg_emit_number(qg_get_number("old_count"));}\n',
      timeoutMs: 5000,
      variableAliases: { old_count: 'count' },
    },
  ];
  const identity = {
    id: module.id,
    name: module.name,
    version: module.version,
    width: module.width,
    height: module.height,
  };
  project.modules = [
    {
      ...structuredClone(module),
      id: 'local_copy',
      name: 'Local copy',
      width: 320,
      height: 200,
      packageIdentity: identity,
      resourceScopeId: 'source-resources',
    },
    {
      ...structuredClone(module),
      id: 'other_copy',
      name: 'Other copy',
      width: 240,
      height: 120,
      packageIdentity: identity,
      resourceScopeId: 'source-resources',
    },
  ];
  project.assets = [
    { id: 'project-logo', name: 'Logo', mime: 'image/png', data: 'data:image/png;base64,aGVsbG8=' },
  ];
  project.resourceScopes = [
    {
      id: 'source-resources',
      theme: structuredClone(project.theme),
      translations: { en: { ready: 'Ready' }, 'zh-CN': { ready: '就绪' } },
      locale: 'en',
      assetAliases: { originalLogo: 'project-logo' },
    },
  ];
  const widget = createWidget('module', 12, 24, 2);
  widget.id = 'instance';
  widget.moduleId = 'local_copy';
  widget.props = { label: 'Instance label' };
  project.widgets = [widget];
  validateProject(project);
  return project;
}

describe('strict component rebuild and project integration', () => {
  it('rejects malformed v2 property metadata before publishing any package', async () => {
    const input = await fixture();
    const filename = path.join(input.source, 'manifest.json');
    const manifest = { ...input.manifest, propertyDefinitions: { label: { invalid: true } } };
    await writeFile(filename, JSON.stringify(manifest));
    const before = await readFile(filename),
      output = path.join(input.directory, 'invalid.qgcomponent');
    await expect(compiler.buildComponent(input.source, output)).rejects.toThrow();
    expect(await exists(output)).toBe(false);
    expect(await readFile(filename)).toEqual(before);
  });
  it('rebuilds the exact local module through the CLI while preserving its identity, geometry, resources and C aliases', async () => {
    const input = await fixture(),
      project = projectFor(input.module),
      filename = path.join(input.directory, 'project.json'),
      output = path.join(input.directory, 'rebuilt.qgcomponent');
    const changed =
      'export default function Card({props}) { return <strong data-rebuilt="yes">{props.label}</strong>; }\n';
    await writeFile(path.join(input.source, 'src/Card.tsx'), changed);
    await writeFile(filename, JSON.stringify(project, null, 2) + '\n');
    const manifestBefore = await readFile(path.join(input.source, 'manifest.json')),
      sourceBefore = await readFile(path.join(input.source, 'src/Card.tsx'));
    const result = spawnSync(
      process.execPath,
      [
        'scripts/build-component.mjs',
        input.source,
        output,
        '--project',
        filename,
        '--module',
        'local_copy',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const next = JSON.parse(await readFile(filename, 'utf8')) as Project;
    validateProject(next);
    expect(next.modules[0]).toMatchObject({
      id: 'local_copy',
      name: 'Local copy',
      width: 320,
      height: 200,
      packageIdentity: project.modules[0].packageIdentity,
      resourceScopeId: 'source-resources',
    });
    expect(next.modules[0].implementation!.bundle).not.toBe(
      project.modules[0].implementation!.bundle,
    );
    expect(next.modules[0].implementation!.files['src/Card.tsx']).toBe(changed);
    expect(next.modules[1]).toEqual(project.modules[1]);
    expect(next.widgets).toEqual(project.widgets);
    expect(next.resourceScopes).toEqual(project.resourceScopes);
    expect(next.assets).toEqual(project.assets);
    expect(next.scripts).toEqual(project.scripts);
    expect(hash(next.scripts[0].source)).toBe(hash(project.scripts[0].source));
    expect(next.revision).toBe(project.revision + 1);
    expect(await readFile(path.join(input.source, 'manifest.json'))).toEqual(manifestBefore);
    expect(await readFile(path.join(input.source, 'src/Card.tsx'))).toEqual(sourceBefore);
    const portable = importComponentPackage(await readFile(output));
    expect(portable.id).toBe('original.card');
    expect(portable.width).toBe(100);
    expect(portable.implementation).toEqual(next.modules[0].implementation);
    expect(portable.embeddedResourceScope?.assets?.map((a) => a.id)).toContain('originalLogo');
    expect(portable.embeddedResourceScope?.translations).toEqual(
      project.resourceScopes![0].translations,
    );
  });
  it('does not update a project or existing artifact when a rebuilt property conflicts with its instance', async () => {
    const input = await fixture(),
      project = projectFor(input.module),
      filename = path.join(input.directory, 'project.json'),
      output = path.join(input.directory, 'untouched.qgcomponent');
    await writeFile(filename, JSON.stringify(project));
    await writeFile(output, 'existing output');
    const before = await readFile(filename);
    const manifest = {
      ...input.manifest,
      props: { label: 3 },
      propertyDefinitions: {
        label: {
          key: 'label',
          label: { zh: '数值', en: 'Value' },
          group: 'content',
          type: 'number',
          editor: 'number',
          initialValue: 3,
          fallbackValue: 3,
        },
      },
    };
    await writeFile(path.join(input.source, 'manifest.json'), JSON.stringify(manifest));
    await expect(
      compiler.buildComponent(input.source, output, { project: filename, module: 'local_copy' }),
    ).rejects.toThrow();
    expect(await readFile(filename)).toEqual(before);
    expect(await readFile(output, 'utf8')).toBe('existing output');
  });
  it('rejects broken project references, immutable identity changes and ambiguous CLI target selection', async () => {
    const input = await fixture(),
      project = projectFor(input.module),
      filename = path.join(input.directory, 'project.json'),
      output = path.join(input.directory, 'rejected.qgcomponent');
    project.scripts[0].variableAliases = { old_count: 'missing' };
    await writeFile(filename, JSON.stringify(project));
    const before = await readFile(filename);
    await expect(
      compiler.buildComponent(input.source, output, { project: filename, module: 'local_copy' }),
    ).rejects.toThrow(/alias target/);
    expect(await readFile(filename)).toEqual(before);
    expect(await exists(output)).toBe(false);
    const valid = projectFor(input.module);
    await writeFile(filename, JSON.stringify(valid));
    await writeFile(
      path.join(input.source, 'manifest.json'),
      JSON.stringify({ ...input.manifest, id: 'another.package' }),
    );
    await expect(
      compiler.buildComponent(input.source, output, { project: filename, module: 'local_copy' }),
    ).rejects.toThrow(/immutable package identity/);
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(valid);
    const cli = spawnSync(
      process.execPath,
      ['scripts/build-component.mjs', input.source, '--project', filename],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toMatch(/--project and --module/);
    await expect(
      compiler.buildComponent(input.source, output, { project: filename, module: 'original.card' }),
    ).rejects.toThrow(/No local module/);
  });
  it('normalizes the project before inserting current component metadata', async () => {
    const input = await fixture(1),
      project = createProject();
    project.modules = [input.module];
    project.widgets = [];
    project.flows = [];
    project.scripts = [];
    project.variables = [];
    project.connections = [];
    const filename = path.join(input.directory, 'legacy.json'),
      output = path.join(input.directory, 'new.qgcomponent');
    await writeFile(filename, JSON.stringify(project));
    const before = await readFile(filename);
    await writeFile(
      path.join(input.source, 'manifest.json'),
      JSON.stringify({
        ...input.manifest,
        schemaVersion: 2,
        propertyDefinitions: {
          label: {
            key: 'label',
            label: { zh: '文字', en: 'Label' },
            group: 'content',
            type: 'string',
            editor: 'text',
            initialValue: 'Ready',
            fallbackValue: 'Ready',
          },
        },
      }),
    );
    await compiler.buildComponent(input.source, output, {
      project: filename,
      module: 'original.card',
    });
    expect(JSON.parse(await readFile(filename, 'utf8')).schemaVersion).toBe(5);
    expect(await exists(output)).toBe(true);
  });
  it('continues to build standalone v1 and v2 packages without editing source files or requiring a project', async () => {
    for (const version of [1, 2] as const) {
      const input = await fixture(version),
        filename = path.join(input.source, 'src/Card.tsx'),
        before = await readFile(filename);
      const result = await compiler.buildComponent(
        input.source,
        path.join(input.directory, 'standalone.qgcomponent'),
      );
      const parsed = importComponentPackage(await readFile(result.destination));
      expect(parsed.id).toBe('original.card');
      expect(parsed.implementation?.files['src/Card.tsx']).toBe(input.sourceText);
      expect(await readFile(filename)).toEqual(before);
    }
  });
});
