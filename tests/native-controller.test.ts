import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../src/core/project';
import type { Project, RuntimeLog, RuntimeSnapshot } from '../src/core/types';

const mocks = vi.hoisted(() => ({
  listener: undefined as undefined | ((snapshot: RuntimeSnapshot) => void),
  start: vi.fn(),
  attach: vi.fn(),
  validate: vi.fn(),
  run: vi.fn(),
  script: vi.fn(),
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
  attachRuntime: mocks.attach,
  runFlow: mocks.run,
  runScript: mocks.script,
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
  it.each([false, true])(
    'waits for the first accepted native snapshot before exposing a ready runtime (attachOnly=%s)',
    async (attachOnly) => {
      const project = createProject();
      let complete!: (value: RuntimeSnapshot) => void;
      const pending = new Promise<RuntimeSnapshot>((resolve) => {
        complete = resolve;
      });
      const begin = attachOnly ? mocks.attach : mocks.start;
      begin.mockReturnValueOnce(pending);
      const engine = new NativeRuntimeController(project, { attachOnly });
      expect(engine.getSnapshot()).toMatchObject({ revision: -1, running: false });
      await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
      expect(engine.getSnapshot().revision).not.toBe(project.revision);
      complete(snapshot(project, 1, 7));
      await vi.waitFor(() =>
        expect(engine.getSnapshot()).toMatchObject({
          projectId: project.id,
          revision: project.revision,
          running: true,
        }),
      );
      expect(engine.getSnapshot().values.cycles.value).toBe(7);
      engine.dispose();
    },
  );
  it('clears only the current log view and keeps old native entries hidden when new snapshots arrive', async () => {
    const project = createProject();
    const old: RuntimeLog = { id: 'native-1', time: 100, level: 'info', message: 'Before clear' };
    const fresh: RuntimeLog = {
      id: 'native-2',
      time: 200,
      level: 'warning',
      message: 'After clear',
    };
    mocks.start.mockImplementation(async (p: Project) => ({ ...snapshot(p, 1, 7), logs: [old] }));
    const engine = new NativeRuntimeController(project);
    await vi.waitFor(() => expect(engine.getSnapshot().logs).toEqual([old]));
    const before = engine.getSnapshot();
    engine.clearLogs();
    expect(engine.getSnapshot().logs).toEqual([]);
    expect(engine.getSnapshot().values).toBe(before.values);
    expect(engine.getSnapshot()).toMatchObject({
      projectId: project.id,
      revision: before.revision,
      sequence: before.sequence,
      running: before.running,
    });
    mocks.listener!({ ...snapshot(project, 2, 8), logs: [old, fresh] });
    expect(engine.getSnapshot().logs).toEqual([fresh]);
    expect(engine.getSnapshot().values.cycles.value).toBe(8);
    mocks.listener!({ ...snapshot(project, 1, -99), logs: [old] });
    expect(engine.getSnapshot().logs).toEqual([fresh]);
    expect(mocks.stop).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('shows new native entries that reuse an ID with a different timestamp', async () => {
    const project = createProject();
    const old: RuntimeLog = {
      id: 'reused-id',
      time: 100,
      level: 'info',
      message: 'Original entry',
    };
    const fresh = { ...old, time: 101, message: 'New entry with the same ID' };
    mocks.start.mockImplementation(async (p: Project) => ({ ...snapshot(p, 1, 0), logs: [old] }));
    const engine = new NativeRuntimeController(project);
    await vi.waitFor(() => expect(engine.getSnapshot().logs).toEqual([old]));
    engine.clearLogs();
    mocks.listener!({ ...snapshot(project, 2, 0), logs: [old, fresh] });
    expect(engine.getSnapshot().logs).toEqual([fresh]);
    engine.dispose();
  });

  it('drops old clear markers as native buffers roll and handles repeated clears without hiding later entries', async () => {
    const project = createProject();
    const original: RuntimeLog = {
      id: 'first',
      time: 100,
      level: 'info',
      message: 'First buffer entry',
    };
    mocks.start.mockImplementation(async (p: Project) => ({
      ...snapshot(p, 1, 0),
      logs: [original],
    }));
    const engine = new NativeRuntimeController(project);
    await vi.waitFor(() => expect(engine.getSnapshot().logs).toEqual([original]));
    let prior = original;
    for (let i = 2; i <= 30; i++) {
      engine.clearLogs();
      engine.clearLogs();
      const fresh = {
        ...original,
        id: `rolling-${i}`,
        time: 100 + i,
        message: `New buffer entry ${i}`,
      };
      mocks.listener!({ ...snapshot(project, i, i), logs: [prior, fresh] });
      expect(engine.getSnapshot().logs).toEqual([fresh]);
      prior = fresh;
    }
    engine.clearLogs();
    mocks.listener!({ ...snapshot(project, 31, 0), logs: [] });
    // Once an entry leaves the native buffer, its marker is no longer retained.
    mocks.listener!({ ...snapshot(project, 32, 0), logs: [original] });
    expect(engine.getSnapshot().logs).toEqual([original]);
    engine.dispose();
  });

  it('resets log clearing across projects and rejects late snapshots from the previous project', async () => {
    const first = createProject(),
      second = createProject();
    const log: RuntimeLog = { id: 'same-id', time: 100, level: 'info', message: 'Project log' };
    mocks.start.mockImplementation(async (p: Project) => ({
      ...snapshot(p, 1, p.id === first.id ? 7 : 0),
      logs: [log],
    }));
    const engine = new NativeRuntimeController(first);
    await vi.waitFor(() => expect(engine.getSnapshot().logs).toEqual([log]));
    engine.clearLogs();
    engine.applyProject(second);
    await vi.waitFor(() => expect(engine.getSnapshot().projectId).toBe(second.id));
    expect(engine.getSnapshot().logs).toEqual([log]);
    mocks.listener!({ ...snapshot(first, 100, 99), logs: [] });
    expect(engine.getSnapshot().logs).toEqual([log]);
    expect(engine.getSnapshot().values.cycles.value).toBe(0);
    engine.clearLogs();
    const next = { ...log, time: 101, message: 'New project log' };
    mocks.listener!({ ...snapshot(second, 2, 1), logs: [log, next] });
    expect(engine.getSnapshot().logs).toEqual([next]);
    engine.dispose();
  });

  it('keeps a cleared compilation diagnostic hidden across repeated clears and native snapshots', async () => {
    const project = createProject();
    mocks.start.mockImplementation(async (p: Project) => snapshot(p, 1, 0));
    const engine = new NativeRuntimeController(project);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    const next = structuredClone(project);
    next.revision++;
    next.scripts[0].source = 'invalid C';
    mocks.validate.mockRejectedValueOnce(new Error('Rejected candidate'));
    engine.applyProject(next);
    await vi.waitFor(() =>
      expect(
        engine.getSnapshot().logs.some((log) => log.message.includes('Rejected candidate')),
      ).toBe(true),
    );
    engine.clearLogs();
    engine.clearLogs();
    mocks.listener!(snapshot(project, 2, 1));
    expect(engine.getSnapshot().logs).toEqual([]);
    expect(engine.getSnapshot().revision).toBe(project.revision);
    expect(engine.getSnapshot().values.cycles.value).toBe(1);
    engine.dispose();
  });
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
    await expect(
      engine.runScript(invalid.scripts[0].id, { value: 1 }, invalid.revision),
    ).rejects.toThrow(/revision was not accepted/);
    expect(mocks.script).not.toHaveBeenCalled();
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
