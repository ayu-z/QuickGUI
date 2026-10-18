import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, createProject } from '../src/core/project';
import { CLOSED_STORAGE_KEY, EditorStore, STORAGE_KEY } from '../src/core/store';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: () => values.clear(),
  };
}
let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('project close lifecycle', () => {
  it('preserves the latest edits and unapplied drafts before stopping, then clears the active workspace', () => {
    const store = new EditorStore(createProject());
    store.update((p) => {
      p.name = 'Edited before auto-save';
    });
    store.setDraft('start_button', '{ invalid but valuable');
    store.beginClose();
    expect(store.getSnapshot().closing).toBe(true);
    expect(store.getSnapshot().project?.name).toBe('Edited before auto-save');
    const backup = JSON.parse(storage.getItem(CLOSED_STORAGE_KEY)!);
    expect(backup.project.name).toBe('Edited before auto-save');
    expect(backup.drafts.start_button).toBe('{ invalid but valuable');
    store.finishClose();
    vi.runAllTimers();
    expect(store.getSnapshot().project).toBeNull();
    expect(store.getSnapshot().drafts).toEqual({});
    expect(store.getSnapshot().past).toEqual([]);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({ closed: true });
    store.dispose();
  });
  it('stays closed after reload and restores the complete recovery including drafts', () => {
    const original = createProject();
    const first = new EditorStore(original);
    first.setDraft('heading', '{ broken');
    first.beginClose();
    first.finishClose();
    const reloaded = new EditorStore();
    expect(reloaded.getSnapshot().project).toBeNull();
    reloaded.restoreClosedProject();
    expect(reloaded.getSnapshot().project).toEqual(original);
    expect(reloaded.getSnapshot().drafts.heading).toBe('{ broken');
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).closed).toBeUndefined();
    first.dispose();
    reloaded.dispose();
  });
  it('does not mutate a closing or closed project from stale callbacks', () => {
    const store = new EditorStore(createProject());
    const revision = store.getSnapshot().project!.revision;
    store.beginClose();
    store.update((p) => {
      p.name = 'late';
    });
    store.setDraft('late', 'late');
    store.undo();
    expect(store.getSnapshot().project!.revision).toBe(revision);
    expect(store.getSnapshot().drafts.late).toBeUndefined();
    store.finishClose();
    store.addWidget('button');
    store.update((p) => {
      p.name = 'late';
    });
    vi.runAllTimers();
    expect(store.getSnapshot().project).toBeNull();
    store.dispose();
  });
  it('retains the active editor when creating the recovery copy fails', () => {
    const store = new EditorStore(createProject());
    const original = store.getSnapshot().project;
    storage.setItem.mockImplementation(() => {
      throw new Error('Quota exceeded');
    });
    expect(() => store.beginClose()).toThrow('Quota exceeded');
    expect(store.getSnapshot().project).toBe(original);
    expect(store.getSnapshot().closing).toBe(false);
    store.dispose();
  });
  it('rolls back the closed startup marker if runtime close fails', () => {
    const store = new EditorStore(createProject());
    store.beginClose();
    store.cancelClose();
    expect(store.getSnapshot().closing).toBe(false);
    expect(new EditorStore().getSnapshot().project?.id).toBe(store.getSnapshot().project?.id);
    store.dispose();
  });
  it('creates an empty new project and gives each open a fresh workspace session', () => {
    const store = new EditorStore(createProject());
    const before = store.getSnapshot().sessionId;
    store.beginClose();
    store.finishClose();
    const next = createEmptyProject();
    store.replaceProject(next);
    expect(store.getSnapshot().project?.widgets).toEqual([]);
    expect(store.getSnapshot().project?.flows).toEqual([]);
    expect(store.getSnapshot().sessionId).toBeGreaterThan(before);
    store.dispose();
  });
  it('keeps an incompatible recovery untouched instead of silently replacing it with a sample', () => {
    const raw = JSON.stringify({ project: { ...createProject(), schemaVersion: 999 }, drafts: {} });
    storage.setItem(STORAGE_KEY, raw);
    const store = new EditorStore();
    expect(store.getSnapshot().project).toBeNull();
    expect(store.getSnapshot().recoveryError).toBeTruthy();
    store.saveRecovery();
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
    store.dispose();
  });
});
