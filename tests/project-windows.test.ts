import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { strFromU8, unzipSync } from 'fflate';
import { createProject, createWidget } from '../src/core/project';
import { exportProject, importProject } from '../src/core/archive';
import { validateProject } from '../src/core/validation';
import { getProjectWindow, listProjectWindows, projectForWindow } from '../src/core/windows';
import type { Project, ProjectWindow } from '../src/core/types';

function fixture(): Project {
  const project = createProject();
  project.schemaVersion = 2;
  project.locale = 'en';
  const panel = { ...createWidget('panel'), id: 'details-panel' };
  const value = { ...createWidget('text'), id: 'details-value', parentId: panel.id };
  value.bindings.text = { variable: project.variables[0].id, mode: 'oneWay' };
  value.events.click = project.flows[0].id;
  project.windows = [
    {
      id: 'details',
      name: 'Details',
      config: {
        ...project.window,
        title: 'Details window',
        width: 720,
        height: 480,
        minWidth: 300,
        minHeight: 200,
      },
      widgets: [panel, value],
      openOnStart: false,
    },
  ];
  return project;
}

function addAction(project: Project, action: string, windowId: string) {
  const flow = project.flows[0];
  flow.nodes.push({
    id: 'window-action',
    kind: 'window',
    label: 'Window',
    position: { x: 0, y: 0 },
    config: { action, windowId },
  });
  flow.edges.push({ id: 'window-entry', source: flow.nodes[0].id, target: 'window-action' });
}

function freezeDeep(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeDeep(child);
  Object.freeze(value);
}

describe('project window format and read-only helpers', () => {
  it('keeps legacy v1 documents byte-equivalent and synthesizes only their main window', () => {
    const project = createProject();
    const original = structuredClone(project);
    freezeDeep(project);
    const windows = listProjectWindows(project);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      id: 'main',
      name: project.window.title,
      config: project.window,
      widgets: project.widgets,
      openOnStart: true,
    });
    expect(getProjectWindow(project)).toEqual(windows[0]);
    expect(projectForWindow(project)).toBe(project);
    expect(importProject(exportProject(project))).toEqual(original);
    expect(Object.hasOwn(project, 'windows')).toBe(false);
    expect(project.schemaVersion).toBe(1);
  });

  it('retains every v2 scene, global reference and optional value through ZIP round trips', () => {
    const project = fixture();
    addAction(project, 'open', 'details');
    project.windows![0].openOnStart = true;
    const original = structuredClone(project);
    freezeDeep(project);
    expect(validateProject(project)).toEqual(original);
    const bytes = exportProject(project);
    expect(importProject(bytes)).toEqual(original);
    expect(strFromU8(unzipSync(bytes)['README.txt'])).toContain('format v2');
    expect(project).toEqual(original);
  });

  it('makes a child rendering projection without mutating canonical main-window data', () => {
    const project = fixture();
    const original = structuredClone(project);
    freezeDeep(project);
    const child = getProjectWindow(project, 'details');
    const view = projectForWindow(project, 'details');
    expect(view.window).toBe(child.config);
    expect(view.widgets).toBe(child.widgets);
    expect(view.variables).toBe(project.variables);
    expect(view.flows).toBe(project.flows);
    expect(view.id).toBe(project.id);
    expect(project.window.title).not.toBe(child.config.title);
    expect(project).toEqual(original);
    expect(() => getProjectWindow(project, 'missing')).toThrow('Unknown project window');
    expect(() => projectForWindow(project, 'missing')).toThrow('Unknown project window');
  });

  it.each([[], undefined])('rejects a windows field on v1, including %s', (windows) => {
    const project = { ...createProject(), windows };
    expect(() => validateProject(project)).toThrow('$.windows');
    expect(() => listProjectWindows(project)).toThrow('schemaVersion 1');
  });

  it('requires an array on v2 and allows an empty one without silently downgrading', () => {
    const project = fixture();
    delete project.windows;
    expect(() => validateProject(project)).toThrow();
    expect(() => listProjectWindows(project)).toThrow('requires a windows array');
    project.windows = [];
    expect(validateProject(project).schemaVersion).toBe(2);
    expect(importProject(exportProject(project)).windows).toEqual([]);
  });

  it.each([1, 2] as const)('rejects explicit null windows in schemaVersion %s', (schemaVersion) => {
    expect(() => validateProject({ ...fixture(), schemaVersion, windows: null })).toThrow();
  });

  it.each(['', '   ', '\t\n', '\u3000', '\ufeff'])(
    'rejects blank window name %j without normalizing the document',
    (name) => {
      const project = fixture();
      project.windows![0].name = name;
      const original = structuredClone(project);
      freezeDeep(project);
      expect(() => validateProject(project)).toThrow();
      expect(project).toEqual(original);
    },
  );

  it('keeps meaningful name whitespace and uses the same UTF-16 length bound', () => {
    const project = fixture();
    project.windows![0].name = '  Details  ';
    expect(validateProject(project).windows![0].name).toBe('  Details  ');
    project.windows![0].name = '😀'.repeat(100);
    expect(validateProject(project).windows![0].name).toBe(project.windows![0].name);
    project.windows![0].name += '😀';
    expect(() => validateProject(project)).toThrow();
  });

  it.each([
    'main',
    '',
    '../escape',
    'two words',
    '子窗口',
    'child/name',
    'child.name',
    'child:name',
    'child\n',
    'a'.repeat(65),
  ])('rejects unsafe or reserved additional ID %j', (id) => {
    const project = fixture();
    project.windows![0].id = id;
    expect(() => validateProject(project)).toThrow();
  });

  it('limits the project to one fixed main window and at most 31 additional windows', () => {
    const project = fixture();
    const child = project.windows![0];
    project.windows = Array.from({ length: 31 }, (_, i) => ({
      ...child,
      id: `pane_${i}`,
      widgets: [],
    }));
    expect(listProjectWindows(validateProject(project))).toHaveLength(32);
    project.windows.push({ ...child, id: 'overflow', widgets: [] });
    expect(() => validateProject(project)).toThrow();
    project.windows = [child, { ...child, widgets: [] }];
    expect(() => validateProject(project)).toThrow('Duplicate window IDs');
  });

  it('requires globally unique scene widget IDs while retaining module-local scopes', () => {
    const project = fixture();
    const duplicate = project.widgets[0].id;
    project.windows![0].widgets[1].id = duplicate;
    expect(() => validateProject(project)).toThrow('unique across all project windows');
    project.windows![0].widgets[1].id = 'details-value';
    const scopedWidget = { ...createWidget('text'), id: duplicate };
    project.modules.push({
      id: 'module-a',
      name: 'A',
      version: '1.0.0',
      width: 300,
      height: 180,
      widgets: [scopedWidget],
      exposedProps: {},
    });
    project.modules.push({ ...structuredClone(project.modules[0]), id: 'module-b' });
    expect(validateProject(project)).toEqual(project);
  });

  it('rejects cross-window parents and cycles without changing the input', () => {
    const project = fixture();
    project.windows![0].widgets[1].parentId = project.widgets[0].id;
    const original = structuredClone(project);
    freezeDeep(project);
    expect(() => validateProject(project)).toThrow('Missing parent');
    expect(project).toEqual(original);
    const cyclic = fixture();
    cyclic.windows![0].widgets[0].parentId = cyclic.windows![0].widgets[1].id;
    expect(() => validateProject(cyclic)).toThrow('Cyclic parent reference');
  });

  it.each([
    [
      'icon',
      (child: ProjectWindow) => {
        child.config.icon = 'missing';
      },
      'Missing icon asset',
    ],
    [
      'minimum size',
      (child: ProjectWindow) => {
        child.config.minWidth = child.config.width + 1;
      },
      'minimum size',
    ],
    [
      'binding',
      (child: ProjectWindow) => {
        child.widgets[1].bindings.text.variable = 'missing';
      },
      'Missing variable',
    ],
    [
      'flow',
      (child: ProjectWindow) => {
        child.widgets[1].events.click = 'missing';
      },
      'Missing flow',
    ],
    [
      'module',
      (child: ProjectWindow) => {
        child.widgets[1].type = 'module';
        child.widgets[1].moduleId = 'missing';
      },
      'Missing module',
    ],
  ] as const)('validates child-window %s references and properties', (_name, change, error) => {
    const project = fixture();
    change(project.windows![0]);
    expect(() => validateProject(project)).toThrow(error);
  });

  it('reports unknown v2 nested fields and leaves future metadata untouched', () => {
    const project = fixture();
    Object.assign(project.windows![0].config, { platformHint: 'future' });
    const original = structuredClone(project);
    freezeDeep(project);
    expect(() => validateProject(project)).toThrow('$.windows[0].config.platformHint');
    expect(() => validateProject(project)).toThrow('Do not save over the original file');
    expect(project).toEqual(original);
  });

  it('validates unused module internals and rejects cross-scope exposed properties', () => {
    const project = fixture();
    const nested = createWidget('text');
    nested.bindings.text = { variable: 'missing', mode: 'oneWay' };
    project.modules.push({
      id: 'unused',
      name: 'Unused',
      version: '1.0.0',
      width: 200,
      height: 100,
      widgets: [nested],
      exposedProps: {},
    });
    expect(() => validateProject(project)).toThrow('Missing variable');
    nested.bindings = {};
    nested.events.click = 'missing';
    expect(() => validateProject(project)).toThrow('Missing flow');
    nested.events = {};
    project.modules[0].exposedProps.text = {
      widgetId: project.windows![0].widgets[0].id,
      property: 'text',
      default: '',
    };
    expect(() => validateProject(project)).toThrow('Missing exposed widget target');
    project.modules[0].exposedProps.text.widgetId = nested.id;
    expect(validateProject(project)).toEqual(project);
  });

  it('rejects missing nested module targets and cycles between module definitions', () => {
    const project = fixture();
    const first = { ...createWidget('module'), id: 'nested', moduleId: 'second' };
    project.modules.push({
      id: 'first',
      name: 'First',
      version: '1.0.0',
      width: 200,
      height: 100,
      widgets: [first],
      exposedProps: {},
    });
    expect(() => validateProject(project)).toThrow('Missing module');
    project.modules.push({
      ...structuredClone(project.modules[0]),
      id: 'second',
      widgets: [{ ...createWidget('module'), id: 'nested', moduleId: 'first' }],
    });
    expect(() => validateProject(project)).toThrow('Cyclic module reference');
  });
});

describe('window action validation', () => {
  it.each(['open', 'close', 'focus'])('accepts %s for an existing additional window', (action) => {
    const project = fixture();
    addAction(project, action, 'details');
    expect(validateProject(project)).toEqual(project);
  });
  it.each(['open', 'focus'])('accepts %s for the fixed main window', (action) => {
    const project = fixture();
    addAction(project, action, 'main');
    expect(validateProject(project)).toEqual(project);
  });
  it.each([
    ['close', 'main', 'cannot close the main window'],
    ['open', 'missing', 'Missing window target'],
    ['destroy', 'details', 'Invalid window action'],
  ])('rejects %s on %s', (action, id, error) => {
    const project = fixture();
    addAction(project, action, id);
    expect(() => validateProject(project)).toThrow(error);
  });
  it('rejects window nodes in v1 and prevents deleting their target in v2', () => {
    const legacy = createProject();
    addAction(legacy, 'focus', 'main');
    expect(() => validateProject(legacy)).toThrow('require schemaVersion 2');
    const project = fixture();
    addAction(project, 'open', 'details');
    project.windows = [];
    expect(() => validateProject(project)).toThrow('Missing window target');
  });
});

describe('standalone source export window metadata', () => {
  it('keeps all v2 scene data but declares only the native main preview window', async () => {
    const url = new URL('../scripts/export-project.mjs', import.meta.url).href;
    const exporter = (await import(/* @vite-ignore */ url)) as {
      exportProject(project: Project, output: string, root: string): Promise<string>;
    };
    const directory = await mkdtemp(path.join(tmpdir(), 'quickgui-windows-'));
    try {
      const root = path.join(directory, 'template');
      const output = path.join(directory, 'export');
      await mkdir(path.join(root, 'src-tauri'), { recursive: true });
      await mkdir(path.join(root, 'templates/runtime'), { recursive: true });
      await writeFile(
        path.join(root, 'src-tauri/tauri.conf.json'),
        JSON.stringify({
          app: { windows: [{ label: 'main' }, { label: 'old-child' }] },
          bundle: {},
        }),
      );
      await writeFile(path.join(root, 'templates/runtime/index.html'), '<div id="root"></div>');
      const project = fixture();
      addAction(project, 'open', 'details');
      const original = structuredClone(project);
      freezeDeep(project);
      await exporter.exportProject(project, output, root);
      expect(JSON.parse(await readFile(path.join(output, 'project.json'), 'utf8'))).toEqual(
        original,
      );
      const config = JSON.parse(
        await readFile(path.join(output, 'src-tauri/tauri.conf.json'), 'utf8'),
      );
      expect(config.app.windows).toHaveLength(1);
      expect(config.app.windows[0].label).toBe('preview');
      expect(config.app.windows[0].url).toBe('index.html?runtime=1&windowId=main');
      expect(config.app.windows[0].title).toBe(project.window.title);
      expect(project).toEqual(original);
      const unsupported = { ...project, schemaVersion: 4 } as unknown as Project;
      await expect(
        exporter.exportProject(unsupported, path.join(directory, 'unsupported'), root),
      ).rejects.toThrow('schemaVersion 1, 2 or 3');
      const disguised = { ...project, schemaVersion: 1 } as Project;
      await expect(
        exporter.exportProject(disguised, path.join(directory, 'disguised'), root),
      ).rejects.toThrow('schemaVersion 1 cannot contain windows');
      for (const [name, change, message] of [
        [
          'blank',
          (p: Project) => {
            p.windows![0].name = ' \ufeff ';
          },
          'Invalid window definition',
        ],
        [
          'binding',
          (p: Project) => {
            p.windows![0].widgets[1].bindings.text.variable = 'missing';
          },
          'Missing variable',
        ],
        [
          'event',
          (p: Project) => {
            p.windows![0].widgets[1].events.click = 'missing';
          },
          'Missing flow',
        ],
        [
          'icon',
          (p: Project) => {
            p.windows![0].config.icon = 'missing';
          },
          'Missing icon asset',
        ],
        [
          'parent-cycle',
          (p: Project) => {
            p.windows![0].widgets[0].parentId = p.windows![0].widgets[1].id;
          },
          'Cyclic parent',
        ],
      ] as const) {
        const bad = structuredClone(original);
        change(bad);
        await expect(exporter.exportProject(bad, path.join(directory, name), root)).rejects.toThrow(
          message,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
