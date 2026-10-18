import { beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ invoke: vi.fn(), desktop: false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: wire.invoke, isTauri: () => wire.desktop }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  wire.invoke.mockReset();
  wire.desktop = false;
});

describe('serial bridge capability and generation', () => {
  it('rejects browser scans before invoking native code or returning invented devices', async () => {
    const native = await import('../src/native/bridge');
    await expect(native.scanSerialPorts()).rejects.toMatchObject({
      code: 'NATIVE_SERIAL_REQUIRED',
    });
    expect(wire.invoke).not.toHaveBeenCalled();
  });
  it('routes desktop scans through the current project generation', async () => {
    wire.desktop = true;
    const snapshot = {
      kind: 'snapshot',
      ports: [],
      added: [],
      removed: [],
      changed: [],
      sequence: 1,
      timestamp: 0,
      timestampIso: '1970-01-01T00:00:00.000Z',
    };
    wire.invoke.mockImplementation(async (command: string) =>
      command === 'project_generation' ? 7 : snapshot,
    );
    const native = await import('../src/native/bridge');
    expect(await native.scanSerialPorts()).toEqual(snapshot);
    expect(wire.invoke).toHaveBeenLastCalledWith('serial_scan', { generation: 7 });
  });
});
