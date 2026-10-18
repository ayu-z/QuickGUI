import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../src/core/project';
import type { Project, RuntimeSnapshot } from '../src/core/types';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  start: vi.fn(),
  validate: vi.fn(),
  window: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  unlisten: vi.fn(),
  listener: undefined as undefined | ((snapshot: RuntimeSnapshot) => void),
}));
vi.mock('../src/native/bridge', () => ({
  isDesktop: () => true,
  executeC: vi.fn(),
  validateC: mocks.validate,
  runtimeStart: mocks.start,
  attachRuntime: mocks.attach,
  windowAction: mocks.window,
  stop: mocks.stop,
  closeProject: mocks.close,
  onRuntimeSnapshot: async (listener: (snapshot: RuntimeSnapshot) => void) => {
    mocks.listener = listener;
    return mocks.unlisten;
  },
  onStorageError: async () => () => {},
}));
import { NativeRuntimeController } from '../src/runtime/controller';

function snapshot(project: Project, sequence: number): RuntimeSnapshot {
  return {
    projectId: project.id,
    revision: project.revision,
    sequence,
    values: { cycles: { value: 12, quality: 'good', timestamp: 1 } },
    logs: [],
    running: true,
    activeNodes: [],
    windowState: { open: ['main', 'details'], focused: 'details', revision: 1 },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listener = undefined;
});

describe('native child runtime attachment', () => {
  it('attaches to shared snapshots without starting or compiling another engine', async () => {
    const project = createProject();
    mocks.attach.mockImplementation(async () => {
      expect(mocks.listener).toBeTypeOf('function');
      return snapshot(project, 1);
    });
    const child = new NativeRuntimeController(project, { attachOnly: true });
    await vi.waitFor(() => expect(child.getSnapshot().values.cycles.value).toBe(12));
    child.applyProject(project);
    expect(mocks.attach).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
    const next = structuredClone(project);
    next.revision++;
    next.scripts[0].source += '\n/* already accepted by owner */';
    mocks.attach.mockResolvedValue(snapshot(next, 2));
    child.applyProject(next);
    await vi.waitFor(() => expect(child.getSnapshot().revision).toBe(1));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    child.applyProject(project);
    expect(child.getProject().revision).toBe(1);
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    child.dispose();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('sends window actions to the shared host and never resumes it when a child view is disposed', async () => {
    const project = createProject();
    mocks.attach.mockResolvedValue(snapshot(project, 1));
    const child = new NativeRuntimeController(project, { attachOnly: true });
    await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    const closed = snapshot(project, 2);
    closed.windowState = { open: ['main'], focused: 'main', revision: 2 };
    mocks.window.mockResolvedValue(closed);
    child.windowAction('close', 'details');
    await vi.waitFor(() => expect(mocks.window).toHaveBeenCalledWith('close', 'details'));
    expect(child.getSnapshot().windowState?.open).toEqual(['main']);
    expect(child.getSnapshot().values.cycles.value).toBe(12);
    child.dispose();
    child.start();
    child.windowAction('open', 'details');
    expect(mocks.attach).toHaveBeenCalledTimes(1);
    expect(mocks.window).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
