import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../src/core/project';
import type { Project, RuntimeSnapshot } from '../src/core/types';

const mocks = vi.hoisted(() => ({
  listener: undefined as undefined | ((snapshot: RuntimeSnapshot) => void),
  start: vi.fn(),
  validate: vi.fn(),
  run: vi.fn(),
  write: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../src/native/bridge', () => ({
  isDesktop: () => true,
  executeC: vi.fn(),
  validateC: mocks.validate,
  onRuntimeSnapshot: async (listener: (snapshot: RuntimeSnapshot) => void) => {
    mocks.listener = listener;
    return () => {};
  },
  onStorageError: async () => () => {},
  runtimeStart: mocks.start,
  runFlow: mocks.run,
  setVariable: mocks.write,
  stop: mocks.stop,
  closeProject: mocks.close,
}));
import { NativeRuntimeController } from '../src/runtime/controller';

function snapshot(project: Project, sequence: number, cycles: number): RuntimeSnapshot {
  return {
    projectId: project.id,
    revision: project.revision,
    sequence,
    values: { cycles: { value: cycles, quality: 'good', timestamp: Date.now() } },
    logs: [],
    running: true,
    activeNodes: [],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listener = undefined;
  mocks.validate.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue({ generation: 1 });
});

describe('native snapshot ordering', () => {
  it('prevents a late candidate compilation from reopening a closed project', async () => {
    const project = createProject();
    mocks.start.mockImplementation(async (p: Project) => snapshot(p, 1, 0));
    const engine = new NativeRuntimeController(project);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    let finishValidation!: () => void;
    mocks.validate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishValidation = resolve;
        }),
    );
    const next = structuredClone(project);
    next.revision++;
    next.scripts[0].source += '\n/* candidate */';
    engine.applyProject(next);
    await vi.waitFor(() => expect(mocks.validate).toHaveBeenCalledTimes(1));
    await engine.closeProject();
    finishValidation();
    await expect(engine.runFlow('start-cycle')).rejects.toThrow(/closed/);
    engine.start();
    engine.setVariable('cycles', 99);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('allows retry or resume after native close reports a persistence failure', async () => {
    const project = createProject();
    mocks.start.mockImplementation(async (p: Project) => snapshot(p, 1, 0));
    const engine = new NativeRuntimeController(project);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    mocks.close.mockRejectedValueOnce(new Error('SQLite flush failed'));
    await expect(engine.closeProject()).rejects.toThrow('SQLite flush failed');
    engine.start();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    await engine.closeProject();
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it('checks changed C without execution and retains the previous runtime on compilation failure', async () => {
    const project = createProject();
    mocks.start.mockImplementation(async (p: Project) => snapshot(p, 1, 0));
    const engine = new NativeRuntimeController(project);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    const invalid = structuredClone(project);
    invalid.revision = 1;
    invalid.scripts[0].source = 'invalid C';
    mocks.validate.mockRejectedValueOnce(new Error('module.c:1: compiler error'));
    engine.applyProject(invalid);
    await vi.waitFor(() =>
      expect(engine.getSnapshot().logs.some((log) => log.message.includes('compiler error'))).toBe(
        true,
      ),
    );
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(engine.getProject().scripts[0].source).toBe(project.scripts[0].source);
    expect(engine.getSnapshot().revision).toBe(0);
    const fixed = structuredClone(project);
    fixed.revision = 2;
    fixed.scripts[0].source += '\n/* fixed */';
    engine.applyProject(fixed);
    await vi.waitFor(() => expect(engine.getSnapshot().revision).toBe(2));
    expect(engine.getProject().scripts[0].source).toBe(fixed.scripts[0].source);
    expect(mocks.run).not.toHaveBeenCalled();
    engine.dispose();
  });
  it('installs listeners before startup and does not overwrite a newer startup event with an older response', async () => {
    const project = createProject();
    mocks.start.mockImplementation(async (p: Project) => {
      expect(mocks.listener).toBeTypeOf('function');
      mocks.listener!(snapshot(p, 2, 1));
      return snapshot(p, 1, 0);
    });
    const engine = new NativeRuntimeController(project);
    await vi.waitFor(() => expect(engine.getSnapshot().values.cycles.value).toBe(1));
    mocks.listener!(snapshot(project, 1, -99));
    expect(engine.getSnapshot().values.cycles.value).toBe(1);
    engine.dispose();
  });
  it('rejects late snapshots from another project even when revision numbers match', async () => {
    const first = createProject(),
      second = createProject();
    mocks.start.mockImplementation(async (p: Project) => snapshot(p, 1, p.id === first.id ? 7 : 0));
    const engine = new NativeRuntimeController(first);
    await vi.waitFor(() => expect(engine.getSnapshot().values.cycles.value).toBe(7));
    engine.applyProject(second);
    await vi.waitFor(() => expect(engine.getSnapshot().values.cycles.value).toBe(0));
    mocks.listener!(snapshot(first, 100, 99));
    expect(engine.getSnapshot().values.cycles.value).toBe(0);
    engine.dispose();
  });
});
