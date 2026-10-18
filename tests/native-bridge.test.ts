import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ScriptRequest } from '../src/core/types';

const wire = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: wire.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: wire.listen }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  wire.invoke.mockReset();
  wire.listen.mockReset().mockResolvedValue(() => {});
});

describe('native project generation', () => {
  it('uses the new native generation after closing and reopening a project', async () => {
    wire.invoke.mockImplementation(async (command: string) => {
      if (command === 'project_generation') return 4;
      if (command === 'close_project') return { generation: 5 };
      return {};
    });
    const native = await import('../src/native/bridge');
    const project = { id: 'p' } as Project;
    await native.runtimeStart(project);
    expect(wire.invoke).toHaveBeenCalledWith('runtime_start', { project, generation: 4 });
    await native.closeProject();
    await native.runtimeStart(project);
    expect(wire.invoke).toHaveBeenLastCalledWith('runtime_start', { project, generation: 5 });
    expect(
      wire.invoke.mock.calls.filter(([command]) => command === 'project_generation'),
    ).toHaveLength(1);
  });

  it('never submits an old start whose generation lookup completes after close', async () => {
    const generation = deferred<number>();
    wire.invoke.mockImplementation((command: string) =>
      command === 'project_generation' ? generation.promise : Promise.resolve({ generation: 1 }),
    );
    const native = await import('../src/native/bridge');
    const pending = native.runtimeStart({ id: 'old' } as Project);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await native.closeProject();
    generation.resolve(0);
    await rejected;
    expect(wire.invoke.mock.calls.some(([command]) => command === 'runtime_start')).toBe(false);
  });

  it('blocks work while close is pending and coalesces duplicate close requests', async () => {
    const completion = deferred<{ generation: number }>();
    wire.invoke.mockImplementation((command: string) =>
      command === 'close_project' ? completion.promise : Promise.resolve(0),
    );
    const native = await import('../src/native/bridge');
    const first = native.closeProject();
    const second = native.closeProject();
    await expect(native.openPreview({ id: 'old' } as Project)).rejects.toThrow(
      'close is in progress',
    );
    completion.resolve({ generation: 1 });
    await Promise.all([first, second]);
    expect(wire.invoke.mock.calls.filter(([command]) => command === 'close_project')).toHaveLength(
      1,
    );
    expect(wire.invoke.mock.calls.some(([command]) => command === 'open_preview')).toBe(false);
  });

  it('refreshes generation after a failed final flush so retry remains possible', async () => {
    wire.invoke.mockImplementation(async (command: string) => {
      if (command === 'close_project') throw new Error('Database unavailable');
      if (command === 'project_generation') return 2;
      return undefined;
    });
    const native = await import('../src/native/bridge');
    await expect(native.closeProject()).rejects.toThrow('Database unavailable');
    const request = {
      source: 'void qg_process(void) {}',
      input: null,
      variables: {},
      state: {},
      timeoutMs: 1000,
    } satisfies ScriptRequest;
    await native.validateC(request);
    expect(wire.invoke).toHaveBeenLastCalledWith('validate_c', { request, generation: 2 });
  });

  it('rejects a native response that arrives after its project was closed', async () => {
    const response = deferred<unknown>();
    wire.invoke.mockImplementation((command: string) => {
      if (command === 'project_generation') return Promise.resolve(0);
      if (command === 'close_project') return Promise.resolve({ generation: 1 });
      return response.promise;
    });
    const native = await import('../src/native/bridge');
    const pending = native.runtimeStart({ id: 'old' } as Project);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() =>
      expect(wire.invoke.mock.calls.some(([command]) => command === 'runtime_start')).toBe(true),
    );
    await native.closeProject();
    response.resolve({ revision: 0 });
    await rejected;
  });

  it('ignores snapshots from an earlier closed project generation', async () => {
    wire.invoke.mockImplementation(async (command: string) =>
      command === 'close_project' ? { generation: 1 } : 0,
    );
    const native = await import('../src/native/bridge');
    const received = vi.fn();
    await native.onRuntimeSnapshot(received);
    const deliver = wire.listen.mock.calls[0][1] as (event: { payload: unknown }) => void;
    deliver({ payload: { revision: 0, projectGeneration: 0 } });
    expect(received).toHaveBeenCalledTimes(1);
    await native.closeProject();
    deliver({ payload: { revision: 0, projectGeneration: 0 } });
    expect(received).toHaveBeenCalledTimes(1);
    deliver({ payload: { revision: 0, projectGeneration: 1 } });
    expect(received).toHaveBeenCalledTimes(2);
  });
});
