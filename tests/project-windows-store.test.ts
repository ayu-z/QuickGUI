import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore, STORAGE_KEY } from '../src/core/store';
import { createProject } from '../src/core/project';
import { getProjectWindow, MAX_ADDITIONAL_WINDOWS } from '../src/core/windows';

const stores: EditorStore[] = [];
const values = new Map<string, string>();
function store() {
  const result = new EditorStore(createProject());
  stores.push(result);
  return result;
}
beforeEach(() => {
  values.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.useFakeTimers();
});
afterEach(() => {
  stores.splice(0).forEach((item) => item.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('multiple-window editor state', () => {
  it('adds a separate empty window, upgrades only on creation and keeps the main scene intact', () => {
    const editor = store(),
      original = structuredClone(editor.getSnapshot().project!);
    expect(editor.getSnapshot().activeWindowId).toBe('main');
    const id = editor.addWindow('  设备详情  ')!;
    const state = editor.getSnapshot();
    expect(state.project!.schemaVersion).toBe(2);
    expect(state.project!.id).toBe(original.id);
    expect(state.project!.window).toEqual(original.window);
    expect(state.project!.widgets).toEqual(original.widgets);
    expect(state.project!.windows).toHaveLength(1);
    expect(getProjectWindow(state.project!, id)).toMatchObject({
      id,
      name: '设备详情',
      config: { title: '设备详情', fullscreen: false, maximized: false },
      widgets: [],
      openOnStart: false,
    });
    expect(state.activeWindowId).toBe(id);
    expect(state.selectedId).toBeNull();
  });
  it('routes add, update, duplicate and delete to the active scene and preserves stable IDs', () => {
    const editor = store(),
      originalMain = structuredClone(editor.getSnapshot().project!.widgets);
    const id = editor.addWindow('Child')!;
    editor.addWidget('button', 72, 80);
    const widgetId = editor.getSnapshot().selectedId!;
    editor.updateWidget(widgetId, { name: 'Child action', id: 'must-not-replace' });
    editor.duplicateWidget(widgetId);
    const duplicatedId = editor.getSnapshot().selectedId!;
    expect(duplicatedId).not.toBe(widgetId);
    let widgets = getProjectWindow(editor.getSnapshot().project!, id).widgets;
    expect(widgets).toHaveLength(2);
    expect(widgets[0]).toMatchObject({
      id: widgetId,
      name: 'Child action',
      layout: { x: 72, y: 80 },
    });
    editor.deleteWidget(duplicatedId);
    expect(getProjectWindow(editor.getSnapshot().project!, id).widgets).toHaveLength(1);
    expect(editor.getSnapshot().project!.widgets).toEqual(originalMain);
    editor.setDraft(widgetId, '{ child draft');
    editor.setActiveWindow('main');
    editor.deleteWidget(widgetId);
    expect(editor.getSnapshot().drafts[widgetId]).toBe('{ child draft');
    editor.addWidget('text');
    expect(editor.getSnapshot().project!.widgets).toHaveLength(originalMain.length + 1);
    widgets = getProjectWindow(editor.getSnapshot().project!, id).widgets;
    expect(widgets[0].id).toBe(widgetId);
  });
  it('keeps independent name, native configuration and startup settings', () => {
    const editor = store(),
      main = structuredClone(editor.getSnapshot().project!.window);
    const id = editor.addWindow('Details')!;
    editor.renameWindow(id, 'Renamed details');
    editor.updateWindow(id, {
      title: 'Native details title',
      width: 800,
      height: 500,
      minWidth: 300,
      minHeight: 200,
    });
    editor.setWindowOpenOnStart(id, true);
    expect(getProjectWindow(editor.getSnapshot().project!, id)).toMatchObject({
      id,
      name: 'Renamed details',
      config: { title: 'Native details title', width: 800, height: 500 },
      openOnStart: true,
    });
    expect(editor.getSnapshot().project!.window).toEqual(main);
    expect(() => editor.deleteWindow('main')).toThrow(/main|主窗口/);
    expect(() => editor.setWindowOpenOnStart('main', false)).toThrow(/main|主窗口/);
  });
  it('switches windows without applying or losing CODE drafts or recording a project edit', () => {
    const editor = store();
    editor.setDraft('start_button', '{ unfinished main');
    const id = editor.addWindow('Child')!;
    editor.addWidget('text');
    const childId = editor.getSnapshot().selectedId!;
    editor.setDraft(childId, '{ unfinished child');
    const revision = editor.getSnapshot().project!.revision,
      past = editor.getSnapshot().past.length;
    editor.setActiveWindow('main');
    editor.setActiveWindow(id);
    expect(editor.getSnapshot().drafts).toEqual({
      start_button: '{ unfinished main',
      [childId]: '{ unfinished child',
    });
    expect(editor.getSnapshot().project!.revision).toBe(revision);
    expect(editor.getSnapshot().past).toHaveLength(past);
    expect(editor.getSnapshot().selectedId).toBeNull();
  });
  it('refuses window deletion with unapplied drafts or referenced window actions', () => {
    const editor = store(),
      id = editor.addWindow('Child')!;
    editor.addWidget('text');
    const widgetId = editor.getSnapshot().selectedId!;
    editor.setDraft(widgetId, '{ unfinished');
    const previous = editor.getSnapshot();
    expect(() => editor.deleteWindow(id)).toThrow(/CODE/);
    expect(editor.getSnapshot()).toBe(previous);
    editor.setDraft(widgetId, undefined);
    editor.update((project) => {
      project.flows[0].nodes.push({
        id: 'open-child',
        kind: 'window',
        label: 'Open child',
        position: { x: 100, y: 300 },
        config: { action: 'open', windowId: id },
      });
    });
    expect(() => editor.deleteWindow(id)).toThrow(/引用|references/);
    expect(getProjectWindow(editor.getSnapshot().project!, id).widgets[0].id).toBe(widgetId);
  });
  it('deletes and restores a complete window with undo/redo without exposing an invalid active scene', () => {
    const editor = store(),
      id = editor.addWindow('Child')!;
    editor.addWidget('button');
    editor.setWindowOpenOnStart(id, true);
    const original = structuredClone(getProjectWindow(editor.getSnapshot().project!, id));
    const unsubscribe = editor.subscribe(() => {
      const state = editor.getSnapshot();
      if (state.project)
        expect(() => getProjectWindow(state.project!, state.activeWindowId)).not.toThrow();
    });
    editor.deleteWindow(id);
    expect(editor.getSnapshot().activeWindowId).toBe('main');
    expect(editor.getSnapshot().selectedId).toBeNull();
    editor.undo();
    expect(getProjectWindow(editor.getSnapshot().project!, id)).toEqual(original);
    editor.setActiveWindow(id);
    editor.select(original.widgets[0].id);
    editor.redo();
    expect(editor.getSnapshot().activeWindowId).toBe('main');
    expect(editor.getSnapshot().selectedId).toBeNull();
    unsubscribe();
  });
  it('returns to main when creation is undone and reuses the same window ID on redo', () => {
    const editor = store(),
      id = editor.addWindow('Child')!;
    editor.undo();
    expect(editor.getSnapshot().project!.schemaVersion).toBe(1);
    expect(editor.getSnapshot().activeWindowId).toBe('main');
    editor.redo();
    expect(getProjectWindow(editor.getSnapshot().project!, id).id).toBe(id);
    expect(() => editor.setActiveWindow('missing')).toThrow(/Unknown/);
  });
  it('persists the active window and its drafts across save, close and restore', () => {
    const editor = store(),
      id = editor.addWindow('Child')!;
    editor.addWidget('input');
    const widgetId = editor.getSnapshot().selectedId!;
    editor.setDraft(widgetId, '{ pending');
    editor.saveRecovery();
    const reloaded = new EditorStore();
    stores.push(reloaded);
    expect(reloaded.getSnapshot().activeWindowId).toBe(id);
    expect(reloaded.getSnapshot().drafts[widgetId]).toBe('{ pending');
    reloaded.beginClose();
    reloaded.finishClose();
    const closed = new EditorStore();
    stores.push(closed);
    expect(closed.getSnapshot().project).toBeNull();
    closed.restoreClosedProject();
    expect(closed.getSnapshot().activeWindowId).toBe(id);
    expect(closed.getSnapshot().drafts[widgetId]).toBe('{ pending');
    expect(getProjectWindow(closed.getSnapshot().project!, id).widgets[0].id).toBe(widgetId);
  });
  it('loads old recovery without a window ID and rejects additional windows above the limit', () => {
    values.set(STORAGE_KEY, JSON.stringify({ project: createProject(), drafts: {} }));
    const editor = new EditorStore();
    stores.push(editor);
    expect(editor.getSnapshot().activeWindowId).toBe('main');
    for (let index = 0; index < MAX_ADDITIONAL_WINDOWS; index++)
      editor.addWindow(`Window ${index}`);
    expect(() => editor.addWindow('Overflow')).toThrow(/最多|Too many/);
    expect(editor.getSnapshot().project!.windows).toHaveLength(MAX_ADDITIONAL_WINDOWS);
  });
});
