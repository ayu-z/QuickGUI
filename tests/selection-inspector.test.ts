import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, createProject, createWidget } from '../src/core/project';
import { EditorStore } from '../src/core/store';

const stores: EditorStore[] = [];
const open = (project = createProject()) => {
  const store = new EditorStore(project);
  stores.push(store);
  return store;
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.useFakeTimers();
});
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('selection inspector defaults', () => {
  it('returns to window properties on deselect without changing the project or CODE drafts', () => {
    const store = open();
    store.select('start_button');
    store.setDraft('start_button', '{ unfinished CODE');
    const before = store.getSnapshot();
    store.select(null);
    expect(store.getSnapshot()).toMatchObject({
      inspector: 'window',
      selectedId: null,
      selectedIds: [],
      project: before.project,
      dirty: before.dirty,
      past: before.past,
      drafts: { start_button: '{ unfinished CODE' },
    });
    store.select('start_button');
    expect(store.getSnapshot().inspector).toBe('widget');
  });

  it('treats empty and invalid selections as window properties while retaining a valid primary', () => {
    const store = open();
    store.setSelection(['heading', 'subtitle'], 'heading');
    expect(store.getSnapshot()).toMatchObject({ inspector: 'widget', selectedId: 'heading' });
    store.setSelection(['subtitle'], 'heading');
    expect(store.getSnapshot()).toMatchObject({ inspector: 'widget', selectedId: 'subtitle' });
    store.setSelection([]);
    expect(store.getSnapshot()).toMatchObject({ inspector: 'window', selectedIds: [] });
    store.setSelection(['missing']);
    expect(store.getSnapshot()).toMatchObject({ inspector: 'window', selectedId: null });
    store.select('missing');
    expect(store.getSnapshot()).toMatchObject({ inspector: 'window', selectedId: null });
  });

  it('preserves selection during property edits and prunes only removed widgets', () => {
    const store = open();
    store.setSelection(['heading', 'subtitle'], 'subtitle');
    store.updateWidget('subtitle', { name: 'Edited subtitle' });
    expect(store.getSnapshot()).toMatchObject({
      inspector: 'widget',
      selectedId: 'subtitle',
      selectedIds: ['heading', 'subtitle'],
    });
    store.update((project) => {
      project.widgets = project.widgets.filter((widget) => widget.id !== 'subtitle');
    });
    expect(store.getSnapshot()).toMatchObject({
      inspector: 'widget',
      selectedId: 'heading',
      selectedIds: ['heading'],
    });
    store.update((project) => {
      project.widgets = project.widgets.filter((widget) => widget.id !== 'heading');
    });
    expect(store.getSnapshot()).toMatchObject({
      inspector: 'window',
      selectedId: null,
      selectedIds: [],
    });
  });

  it('keeps a deleted selection cleared across undo and redo', () => {
    const store = open();
    store.select('start_button');
    store.deleteWidget('start_button');
    for (const action of [() => {}, store.undo, store.redo]) {
      action();
      expect(store.getSnapshot()).toMatchObject({
        inspector: 'window',
        selectedId: null,
        selectedIds: [],
      });
    }
  });

  it('uses window properties when undo removes the only selected newly created control', () => {
    const store = open(createEmptyProject());
    store.addWidget('button');
    expect(store.getSnapshot().inspector).toBe('widget');
    store.undo();
    expect(store.getSnapshot()).toMatchObject({ inspector: 'window', selectedId: null });
    store.redo();
    expect(store.getSnapshot()).toMatchObject({ inspector: 'window', selectedId: null });
  });

  it('keeps window selection and the inspector aligned when windows change or disappear', () => {
    const store = open();
    const childId = store.addWindow('Child')!;
    store.addWidget('button');
    store.select(null);
    expect(store.getSnapshot()).toMatchObject({ activeWindowId: childId, inspector: 'window' });
    store.setActiveWindow('main');
    expect(store.getSnapshot()).toMatchObject({
      activeWindowId: 'main',
      inspector: 'window',
      selectedId: null,
    });
    store.setActiveWindow(childId);
    store.deleteWindow(childId);
    expect(store.getSnapshot()).toMatchObject({ activeWindowId: 'main', inspector: 'window' });
  });

  it('retains module selection on property edits and restores it when a transaction is canceled', () => {
    const project = createProject(),
      widget = { ...createWidget('button'), id: 'module_control' };
    project.modules.push({
      id: 'module',
      name: 'Module',
      version: '1.0.0',
      width: 320,
      height: 200,
      widgets: [widget],
      exposedProps: {},
    });
    const store = open(project);
    store.select(widget.id);
    store.update((next) => {
      next.modules[0].widgets[0].name = 'Module control';
    });
    expect(store.getSnapshot()).toMatchObject({ inspector: 'widget', selectedId: widget.id });
    store.beginTransaction();
    store.setSelection([]);
    expect(store.getSnapshot().inspector).toBe('window');
    store.cancelTransaction();
    expect(store.getSnapshot()).toMatchObject({ inspector: 'widget', selectedId: widget.id });
    store.update((next) => {
      next.modules[0].widgets = [];
    });
    expect(store.getSnapshot()).toMatchObject({ inspector: 'window', selectedId: null });
  });

  it('shows window properties for an empty project and selects a valid control when replacing it', () => {
    const store = open(createEmptyProject());
    expect(store.getSnapshot().inspector).toBe('window');
    const populated = createProject();
    store.replaceProject(populated);
    expect(store.getSnapshot()).toMatchObject({
      inspector: 'widget',
      selectedId: populated.widgets[0].id,
      selectedIds: [populated.widgets[0].id],
    });
    store.replaceProject(createEmptyProject());
    expect(store.getSnapshot()).toMatchObject({ inspector: 'window', selectedId: null });
  });
});
