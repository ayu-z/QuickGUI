import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModuleFromSelection,
  deleteModuleDefinition,
  duplicateModuleDefinition,
  insertModuleInstance,
  moduleReferences,
  updateModuleDefinition,
} from '../src/core/modules';
import { createEmptyProject, createWidget } from '../src/core/project';
import { validateProject } from '../src/core/validation';
import { EditorStore } from '../src/core/store';
import { exportComponentPackage, importComponentPackage } from '../src/core/componentPackage';
import type { ComponentModule, Project } from '../src/core/types';

const main = { kind: 'window' as const, id: 'main' };
const stores: EditorStore[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const blank = () => createEmptyProject('Modules');
const createBlank = (project: Project, name: string) =>
  createModuleFromSelection(project, { name, scope: main, selectedIds: [] });
function numberModule(project: Project, name = 'Numeric'): ComponentModule {
  const widget = createWidget('number', 40, 60, 2);
  project.widgets.push(widget);
  const module = createModuleFromSelection(project, {
    name,
    scope: main,
    selectedIds: [widget.id],
  });
  updateModuleDefinition(project, module.id, {
    exposedProps: { value: { widgetId: module.widgets[0].id, property: 'value', default: 3 } },
  });
  return project.modules.find((entry) => entry.id === module.id)!;
}
function sourceModule(): ComponentModule {
  const manifest = {
    schemaVersion: 1,
    id: 'example.badge',
    name: 'Badge',
    version: '1.0.0',
    entry: 'src/Badge.tsx',
    width: 200,
    height: 80,
    props: { label: 'Ready' },
    events: [],
  };
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    width: manifest.width,
    height: manifest.height,
    widgets: [],
    exposedProps: { label: { widgetId: '$component', property: 'label', default: 'Ready' } },
    implementation: {
      kind: 'react',
      files: {
        'manifest.json': JSON.stringify(manifest),
        'src/Badge.tsx': 'export default function Badge() { return <span>Ready</span> }',
      },
      bundle: 'export function mount() { return { update() {}, unmount() {} }; }',
      events: [],
    },
  };
}

describe('module definition operations', () => {
  it('creates a named blank module without changing the source scene or project schema', () => {
    const project = blank(),
      before = structuredClone(project);
    const module = createBlank(project, '  Empty module  ');
    expect(module).toMatchObject({
      name: 'Empty module',
      width: 300,
      height: 180,
      widgets: [],
      exposedProps: {},
    });
    expect({ ...project, modules: [] }).toEqual(before);
    expect(validateProject(project).schemaVersion).toBe(before.schemaVersion);
  });

  it('copies multiple roots and complete subtrees once, normalizing their relative placement', () => {
    const project = blank();
    const panel = createWidget('panel', 100, 80, 2),
      child = createWidget('number', 20, 40, 2),
      button = createWidget('button', 500, 90, 2);
    child.parentId = panel.id;
    project.variables.push({ id: 'speed', name: 'Speed', type: 'number', initial: 2 });
    child.bindings.value = { variable: 'speed', mode: 'twoWay' };
    project.widgets = [panel, child, button];
    const source = structuredClone(project.widgets);
    const module = createModuleFromSelection(project, {
      name: 'Controls',
      scope: main,
      selectedIds: [panel.id, child.id, button.id],
    });
    expect(module.widgets).toHaveLength(3);
    expect(new Set(module.widgets.map((widget) => widget.id)).size).toBe(3);
    expect(
      module.widgets
        .map((widget) => widget.id)
        .some((id) => source.some((widget) => widget.id === id)),
    ).toBe(false);
    const nextPanel = module.widgets.find((widget) => widget.type === 'panel')!,
      nextChild = module.widgets.find((widget) => widget.type === 'number')!,
      nextButton = module.widgets.find((widget) => widget.type === 'button')!;
    expect(nextPanel.layout).toMatchObject({ x: 0, y: 0 });
    expect(nextButton.layout).toMatchObject({ x: 400, y: 10 });
    expect(nextChild.layout).toEqual(child.layout);
    expect(nextChild.parentId).toBe(nextPanel.id);
    expect(nextChild.bindings).toEqual(child.bindings);
    expect(module).toMatchObject({ width: 540, height: 180 });
    expect(project.widgets).toEqual(source);
    expect(project.variables[0].id).toBe('speed');
    nextChild.props.value = 17;
    expect(child.props.value).not.toBe(17);
  });

  it('uses the selected additional window and retains inherited resource scopes from omitted ancestors', () => {
    const project = blank(),
      panel = createWidget('panel', 100, 70, 2),
      child = createWidget('text', 30, 20, 2);
    project.resourceScopes = [
      {
        id: 'foreign',
        theme: structuredClone(project.theme),
        translations: { en: { greeting: 'Hello' } },
        locale: 'en',
      },
    ];
    panel.resourceScopeId = 'foreign';
    child.parentId = panel.id;
    project.windows = [
      {
        id: 'details',
        name: 'Details',
        config: structuredClone(project.window),
        widgets: [panel, child],
        openOnStart: false,
      },
    ];
    const module = createModuleFromSelection(project, {
      name: 'Foreign label',
      scope: { kind: 'window', id: 'details' },
      selectedIds: [child.id],
    });
    expect(module.widgets[0]).toMatchObject({ resourceScopeId: 'foreign', layout: { x: 0, y: 0 } });
    expect(module.widgets[0].parentId).toBeUndefined();
    expect(project.widgets).toEqual([]);
    expect(project.windows[0].widgets).toHaveLength(2);
    expect(project.resourceScopes[0].translations.en.greeting).toBe('Hello');
  });

  it('prefers measured canvas root positions while retaining nested coordinates', () => {
    const project = blank(),
      panel = createWidget('panel', 100, 80),
      child = createWidget('text', 10, 20),
      sibling = createWidget('button', 400, 100);
    child.parentId = panel.id;
    project.widgets = [panel, child, sibling];
    const module = createModuleFromSelection(project, {
      name: 'Measured',
      scope: main,
      selectedIds: [panel.id, child.id, sibling.id],
      positions: { [panel.id]: { x: 110, y: 90 }, [sibling.id]: { x: 460, y: 120 } },
    });
    expect(module.widgets.find((widget) => widget.type === 'panel')!.layout).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(module.widgets.find((widget) => widget.type === 'button')!.layout).toMatchObject({
      x: 350,
      y: 30,
    });
    expect(module.widgets.find((widget) => widget.type === 'text')!.layout).toEqual(child.layout);
    expect(module.width).toBe(490);
    const before = structuredClone(project);
    expect(() =>
      createModuleFromSelection(project, {
        name: 'Invalid measurement',
        scope: main,
        selectedIds: [panel.id],
        positions: { [panel.id]: { x: NaN, y: 1 } },
      }),
    ).toThrow(/positions must be finite/);
    expect(project).toEqual(before);
  });

  it('preserves an owning module’s embedded resources when creating a definition from its widgets', () => {
    const project = blank(),
      original = numberModule(project);
    original.embeddedResourceScope = {
      id: 'embedded',
      theme: structuredClone(project.theme),
      translations: { en: { value: 'Value' } },
      locale: 'en',
    };
    const next = createModuleFromSelection(project, {
      name: 'Child copy',
      scope: { kind: 'module', id: original.id },
      selectedIds: [original.widgets[0].id],
    });
    expect(next.embeddedResourceScope).toEqual(original.embeddedResourceScope);
    expect(next.embeddedResourceScope).not.toBe(original.embeddedResourceScope);
  });

  it('requires the containing flex/grid layout when extracting its children', () => {
    const project = blank(),
      panel = createWidget('panel', 100, 50, 2),
      child = createWidget('text', 30, 40, 2);
    panel.layout.mode = 'flex';
    child.parentId = panel.id;
    project.widgets = [panel, child];
    const before = structuredClone(project);
    expect(() =>
      createModuleFromSelection(project, {
        name: 'Invalid placement',
        scope: main,
        selectedIds: [child.id],
      }),
    ).toThrow(/flex or grid/);
    expect(project).toEqual(before);
    const module = createModuleFromSelection(project, {
      name: 'Flex layout',
      scope: main,
      selectedIds: [panel.id],
    });
    expect(module.widgets[0].layout.mode).toBe('flex');
    expect(module.widgets[1].layout).toEqual(child.layout);
  });

  it('rejects foreign selections and unapplied descendant CODE drafts without partial mutation', () => {
    const project = blank(),
      panel = createWidget('panel'),
      child = createWidget('text');
    child.parentId = panel.id;
    project.widgets = [panel, child];
    const before = structuredClone(project);
    expect(() =>
      createModuleFromSelection(project, {
        name: 'Unknown',
        scope: main,
        selectedIds: ['unknown'],
      }),
    ).toThrow(/outside/);
    const drafts = { [`${project.id}/window/main::${child.id}`]: '{ invalid CODE' };
    expect(() =>
      createModuleFromSelection(project, {
        name: 'Unapplied',
        scope: main,
        selectedIds: [panel.id],
        drafts,
      }),
    ).toThrow(/CODE/);
    expect(project).toEqual(before);
    expect(Object.values(drafts)).toEqual(['{ invalid CODE']);
  });

  it('inserts a typed independent instance into the requested scope', () => {
    const project = blank(),
      module = numberModule(project);
    project.windows = [
      {
        id: 'details',
        name: 'Details',
        config: structuredClone(project.window),
        widgets: [],
        openOnStart: false,
      },
    ];
    const widget = insertModuleInstance(
      project,
      module.id,
      { kind: 'window', id: 'details' },
      { x: 12, y: 24 },
    );
    expect(widget).toMatchObject({
      type: 'module',
      moduleId: module.id,
      props: { value: 3 },
      layout: { x: 12, y: 24, width: module.width, height: module.height },
    });
    expect(project.windows[0].widgets[0]).toEqual(widget);
    widget.props.value = 9;
    expect(project.modules[0].exposedProps.value.default).toBe(3);
    expect(project.widgets).toHaveLength(1);
    validateProject(project);
  });

  it('refuses direct and indirect module cycles atomically', () => {
    const project = blank(),
      a = createBlank(project, 'A'),
      b = createBlank(project, 'B');
    const before = structuredClone(project);
    expect(() => insertModuleInstance(project, a.id, { kind: 'module', id: a.id })).toThrow(
      /Cyclic/,
    );
    expect(project).toEqual(before);
    insertModuleInstance(project, b.id, { kind: 'module', id: a.id });
    const beforeIndirect = structuredClone(project);
    expect(() => insertModuleInstance(project, a.id, { kind: 'module', id: b.id })).toThrow(
      /Cyclic/,
    );
    expect(project).toEqual(beforeIndirect);
  });

  it('counts references in every window and nested definition and blocks deletion', () => {
    const project = blank(),
      a = createBlank(project, 'A'),
      b = createBlank(project, 'B');
    project.windows = [
      {
        id: 'details',
        name: 'Details',
        config: structuredClone(project.window),
        widgets: [],
        openOnStart: false,
      },
    ];
    insertModuleInstance(project, a.id, main);
    insertModuleInstance(project, a.id, { kind: 'window', id: 'details' });
    insertModuleInstance(project, a.id, { kind: 'module', id: b.id });
    expect(moduleReferences(project, a.id)).toHaveLength(3);
    expect(
      moduleReferences(project, a.id).some((reference) => reference.startsWith('Details')),
    ).toBe(true);
    const before = structuredClone(project);
    expect(() => deleteModuleDefinition(project, a.id)).toThrow(/Remove module instances/);
    expect(project).toEqual(before);
  });

  it('duplicates definitions with fresh widget IDs, retargeted public properties and retained shared resources', () => {
    const project = blank(),
      original = numberModule(project);
    project.resourceScopes = [
      { id: 'shared', theme: structuredClone(project.theme), translations: {}, locale: 'en' },
    ];
    original.resourceScopeId = 'shared';
    const copy = duplicateModuleDefinition(project, original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.widgets[0].id).not.toBe(original.widgets[0].id);
    expect(copy.exposedProps.value.widgetId).toBe(copy.widgets[0].id);
    expect(copy.resourceScopeId).toBe('shared');
    expect(copy.name).not.toBe(original.name);
    updateModuleDefinition(project, copy.id, { width: 321, height: 123 });
    expect(project.modules.find((module) => module.id === original.id)!.width).toBe(original.width);
  });

  it('protects module CODE drafts on duplicate and delete; a clean unused definition can be removed', () => {
    const project = blank(),
      module = numberModule(project);
    const drafts = {
      [`${project.id}/module/${module.id}::${module.widgets[0].id}`]: '{ unfinished',
    };
    const before = structuredClone(project);
    expect(() => duplicateModuleDefinition(project, module.id, undefined, drafts)).toThrow(/CODE/);
    expect(() => deleteModuleDefinition(project, module.id, drafts)).toThrow(/CODE/);
    expect(project).toEqual(before);
    deleteModuleDefinition(project, module.id);
    expect(project.modules).toEqual([]);
    expect(project.widgets).toEqual(before.widgets);
  });

  it('rejects invalid names, versions and dimensions before mutating the definition', () => {
    const project = blank(),
      module = createBlank(project, 'First');
    createBlank(project, 'Other');
    for (const patch of [
      { name: ' ' },
      { name: 'Other' },
      { version: 'bad' },
      { width: 0 },
      { height: Infinity },
      { width: 10001 },
    ]) {
      const before = structuredClone(project);
      expect(() => updateModuleDefinition(project, module.id, patch)).toThrow();
      expect(project).toEqual(before);
    }
    updateModuleDefinition(project, module.id, {
      name: 'Renamed',
      version: '2.0.0-beta.1',
      width: 200.5,
      height: 140,
    });
    expect(project.modules[0]).toMatchObject({
      id: module.id,
      name: 'Renamed',
      version: '2.0.0-beta.1',
      width: 200.5,
      height: 140,
    });
  });

  it('validates exposed targets and defaults, rejecting invalid API changes without losing valid properties', () => {
    const project = blank(),
      module = numberModule(project);
    const invalidProperties: ComponentModule['exposedProps'][] = [
      { value: { widgetId: 'missing', property: 'value', default: 1 } },
      { value: { widgetId: module.widgets[0].id, property: 'missing', default: 1 } },
      { value: { widgetId: module.widgets[0].id, property: 'value', default: 'bad' } },
      { constructor: { widgetId: module.widgets[0].id, property: 'value', default: 1 } },
    ];
    for (const exposedProps of invalidProperties) {
      const before = structuredClone(project);
      expect(() => updateModuleDefinition(project, module.id, { exposedProps })).toThrow();
      expect(project).toEqual(before);
    }
    const instance = insertModuleInstance(project, module.id, main);
    const before = structuredClone(project);
    expect(() => updateModuleDefinition(project, module.id, { exposedProps: {} })).toThrow(
      /Remove instances/,
    );
    expect(project).toEqual(before);
    updateModuleDefinition(project, module.id, {
      exposedProps: { ...module.exposedProps, value: { ...module.exposedProps.value, default: 7 } },
    });
    expect(project.modules[0].exposedProps.value.default).toBe(7);
    expect(project.widgets.find((widget) => widget.id === instance.id)!.props.value).toBe(3);
  });

  it('checks exposed default asset references and dependent numeric constraints', () => {
    const project = blank(),
      image = createWidget('image'),
      slider = createWidget('slider');
    project.widgets = [image, slider];
    const module = createModuleFromSelection(project, {
      name: 'Assets',
      scope: main,
      selectedIds: [image.id, slider.id],
    });
    const exposedImage = module.widgets.find((widget) => widget.type === 'image')!,
      exposedSlider = module.widgets.find((widget) => widget.type === 'slider')!;
    const before = structuredClone(project);
    expect(() =>
      updateModuleDefinition(project, module.id, {
        exposedProps: {
          image: { widgetId: exposedImage.id, property: 'assetId', default: 'missing-asset' },
        },
      }),
    ).toThrow(/Image asset/);
    expect(() =>
      updateModuleDefinition(project, module.id, {
        exposedProps: { max: { widgetId: exposedSlider.id, property: 'max', default: 0 } },
      }),
    ).toThrow(/Maximum must exceed/);
    expect(project).toEqual(before);
  });

  it('preserves source package identity on local rename or duplicate and keeps manifest-owned fields read-only', () => {
    const project = blank(),
      module = sourceModule();
    project.modules.push(module);
    const original = structuredClone(module);
    updateModuleDefinition(project, module.id, { name: 'Local badge' });
    const renamed = project.modules[0];
    expect(renamed.packageIdentity).toMatchObject({
      id: original.id,
      name: original.name,
      version: original.version,
    });
    expect(importComponentPackage(exportComponentPackage(renamed, project)).name).toBe('Badge');
    expect(renamed.implementation).toEqual(original.implementation);
    const copy = duplicateModuleDefinition(project, module.id);
    expect(copy.implementation).toEqual(original.implementation);
    expect(importComponentPackage(exportComponentPackage(copy, project)).id).toBe(original.id);
    const before = structuredClone(project);
    expect(() => updateModuleDefinition(project, module.id, { version: '2.0.0' })).toThrow(
      /source package/,
    );
    expect(() =>
      createModuleFromSelection(project, {
        name: 'Unsupported',
        scope: { kind: 'module', id: module.id },
        selectedIds: [],
      }),
    ).toThrow(/Source components/);
    expect(project).toEqual(before);
  });

  it('commits each operation as one undoable model change without changing existing CODE drafts', () => {
    const project = blank(),
      widget = createWidget('text');
    project.widgets.push(widget);
    const store = new EditorStore(project);
    stores.push(store);
    store.setDraft('elsewhere', '{ unrelated draft');
    const before = store.getSnapshot().project!;
    let moduleId = '';
    store.update((next) => {
      moduleId = createModuleFromSelection(next, {
        name: 'Reusable',
        scope: main,
        selectedIds: [widget.id],
        drafts: store.getSnapshot().drafts,
      }).id;
    });
    expect(store.getSnapshot().past).toHaveLength(1);
    store.undo();
    expect(store.getSnapshot().project!.modules).toEqual([]);
    expect(store.getSnapshot().project!.widgets).toEqual(before.widgets);
    expect(store.getSnapshot().drafts.elsewhere).toBe('{ unrelated draft');
    store.redo();
    store.update((next) => updateModuleDefinition(next, moduleId, { name: 'Updated', width: 420 }));
    store.undo();
    expect(store.getSnapshot().project!.modules[0]).toMatchObject({
      name: 'Reusable',
      width: widget.layout.width,
    });
    expect(store.getSnapshot().drafts.elsewhere).toBe('{ unrelated draft');
  });
});
