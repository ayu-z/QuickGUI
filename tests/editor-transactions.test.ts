import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/core/store';
import { createProject } from '../src/core/project';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('editor transactions and selection', () => {
  it('records an entire drag once and restores the exact starting model with one undo', () => {
    const store = new EditorStore(createProject()),
      original = structuredClone(store.getSnapshot().project!.widgets[0]);
    store.beginTransaction('Move');
    for (let index = 0; index < 150; index++)
      store.updateWidget(original.id, {
        layout: { ...original.layout, x: original.layout.x + index + 1 },
      });
    expect(store.getSnapshot().past).toHaveLength(0);
    store.commitTransaction();
    expect(store.getSnapshot().past).toHaveLength(1);
    const revision = store.getSnapshot().project!.revision;
    store.undo();
    expect(store.getSnapshot().project!.widgets[0]).toEqual(original);
    expect(store.getSnapshot().project!.revision).toBeGreaterThan(revision);
    store.redo();
    expect(store.getSnapshot().project!.widgets[0].layout.x).toBe(original.layout.x + 150);
    store.dispose();
  });
  it('cancels without destroying existing redo and skips unchanged transactions', () => {
    const store = new EditorStore(createProject()),
      id = store.getSnapshot().project!.widgets[0].id;
    store.updateWidget(id, { name: 'Changed' });
    store.undo();
    const before = structuredClone(store.getSnapshot().project!),
      future = store.getSnapshot().future;
    store.beginTransaction('Cancelled');
    store.updateWidget(id, { name: 'Temporary' });
    const revision = store.getSnapshot().project!.revision;
    store.cancelTransaction();
    expect(store.getSnapshot().project!.widgets).toEqual(before.widgets);
    expect(store.getSnapshot().future).toEqual(future);
    expect(store.getSnapshot().past).toHaveLength(0);
    expect(store.getSnapshot().project!.revision).toBeGreaterThan(revision);
    store.beginTransaction('No change');
    store.updateWidget(id, { name: before.widgets[0].name });
    store.commitTransaction();
    expect(store.getSnapshot().past).toHaveLength(0);
    store.redo();
    expect(store.getSnapshot().project!.widgets[0].name).toBe('Changed');
    store.dispose();
  });
  it('keeps primary and multiple selection consistent and clears them across windows', () => {
    const store = new EditorStore(createProject());
    store.setSelection(['heading', 'subtitle'], 'heading');
    expect(store.getSnapshot().selectedIds).toEqual(['heading', 'subtitle']);
    expect(store.getSnapshot().selectedId).toBe('heading');
    store.select('start_button');
    expect(store.getSnapshot().selectedIds).toEqual(['start_button']);
    store.setActiveWindow('main');
    expect(store.getSnapshot().selectedIds).toEqual([]);
    expect(store.getSnapshot().selectedId).toBeNull();
    store.dispose();
  });
  it('isolates module draft buffers and reads existing bare-ID recovery', () => {
    const store = new EditorStore(createProject());
    store.setDraft('shared', 'legacy');
    expect(store.getDraft('shared', 'module/a')).toBe('legacy');
    store.setDraft('shared', 'first', 'module/a');
    store.setDraft('shared', 'second', 'module/b');
    expect(store.getDraft('shared', 'module/a')).toBe('first');
    expect(store.getDraft('shared', 'module/b')).toBe('second');
    store.setDraft('shared', undefined, 'module/a');
    expect(store.getDraft('shared', 'module/b')).toBe('second');
    expect(store.getDraft('shared', 'module/a')).toBeUndefined();
    store.dispose();
  });
  it('retains a valid primary after undo removes only part of a multiple selection', () => {
    const store = new EditorStore(createProject());
    store.addWidget('button');
    const added = store.getSnapshot().selectedId!;
    store.setSelection(['heading', added], added);
    store.undo();
    expect(store.getSnapshot().selectedIds).toEqual(['heading']);
    expect(store.getSnapshot().selectedId).toBe('heading');
    store.dispose();
  });
});
