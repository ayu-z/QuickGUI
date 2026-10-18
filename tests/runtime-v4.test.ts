import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, createWidget } from '../src/core/project';
import type { FlowNode, Json, Project, ScriptRequest } from '../src/core/types';
import { RuntimeController } from '../src/runtime/engine';

const literal = (value: Json) => ({ source: 'literal', value });
const input = (path: (string | number)[] = []) => ({ source: 'input', path });
const variable = (id: string, path: (string | number)[] = []) => ({
  source: 'variable',
  variable: id,
  path,
});
const node = (id: string, kind: FlowNode['kind'], config: Record<string, Json> = {}): FlowNode => ({
  id,
  kind,
  config,
  label: id,
  position: { x: 0, y: 0 },
});
function project(): Project {
  const p = createEmptyProject('V4 runtime');
  p.schemaVersion = 4;
  p.variables = [
    {
      id: 'history',
      name: 'history',
      type: 'json',
      initial: { rows: [], dropped: 0, sibling: true },
    },
    { id: 'result', name: 'result', type: 'json', initial: null },
    { id: 'counter', name: 'counter', type: 'number', initial: 0 },
    { id: 'period', name: 'period', type: 'number', initial: 200 },
    { id: 'enabled', name: 'enabled', type: 'boolean', initial: false },
  ];
  return p;
}
function flow(p: Project, id: string, nodes: FlowNode[]) {
  p.flows.push({
    id,
    name: id,
    enabled: true,
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ id: `${id}-${i}`, source: nodes[i].id, target: n.id })),
  });
}
afterEach(() => {
  vi.useRealTimers();
});

describe('v4 portable runtime', () => {
  it('maps messages and appends bounded history with one atomic sibling-preserving write', async () => {
    const p = project();
    flow(p, 'capture', [
      node('entry', 'event', { trigger: 'manual' }),
      node('map', 'map', {
        operation: 'object',
        fields: { name: input(['name']), value: input(['value']) },
      }),
      node('append', 'append', {
        variable: 'history',
        path: ['rows'],
        droppedPath: ['dropped'],
        item: input(),
        maxItems: 2,
        maxBytes: 512,
        order: 'latestFirst',
      }),
    ]);
    const engine = new RuntimeController(p);
    await engine.runFlow('capture', { name: 'a', value: 1 });
    await engine.runFlow('capture', { name: 'b', value: 2 });
    await engine.runFlow('capture', { name: 'c', value: 3 });
    expect(engine.getSnapshot().values.history.value).toEqual({
      rows: [
        { name: 'c', value: 3 },
        { name: 'b', value: 2 },
      ],
      dropped: 1,
      sibling: true,
    });
    engine.dispose();
  });

  it('filters real-shaped USB descriptors by both IDs and preserves unknown metadata only when unrestricted', async () => {
    const p = project();
    flow(p, 'filter', [
      node('entry', 'event'),
      node('filter', 'serial', {
        action: 'filter',
        ports: input(['ports']),
        vid: literal('0x1A86'),
        pid: literal('7523'),
      }),
      node('write', 'write', { variable: 'result' }),
    ]);
    const engine = new RuntimeController(p);
    const ports = [
      { portName: '/dev/cu.usb-a', vid: 0x1a86, pid: 0x7523 },
      { portName: '/dev/cu.usb-b', vid: 0x1a86, pid: 0x5523 },
      { portName: '/dev/cu.unknown', vid: null, pid: null },
    ];
    await engine.runFlow('filter', { ports });
    expect(engine.getSnapshot().values.result.value).toEqual([ports[0]]);
    engine.dispose();
  });

  it('routes missing native serial capability to an error edge without producing fake ports', async () => {
    const p = project();
    flow(p, 'scan', [
      node('entry', 'event'),
      node('scan', 'serial', { action: 'scan' }),
      node('error', 'write', { variable: 'result' }),
    ]);
    p.flows[0].edges[1].sourceHandle = 'error';
    const engine = new RuntimeController(p);
    await engine.runFlow('scan');
    expect(engine.getSnapshot().values.result.value).toMatchObject({
      code: 'NATIVE_SERIAL_REQUIRED',
      operation: 'scan',
    });
    expect(engine.getSnapshot().serial).toBeUndefined();
    p.flows[0].edges.splice(1);
    p.revision++;
    engine.applyProject(p);
    await expect(engine.runFlow('scan')).rejects.toThrow(/desktop runtime/);
    engine.dispose();
  });

  it('does not manually trigger external sources or invent incoming serial data', async () => {
    const p = project();
    flow(p, 'devices', [
      node('event', 'event', { trigger: 'serial', event: 'devices' }),
      node('write', 'write', { variable: 'result', value: 'fabricated' }),
    ]);
    const engine = new RuntimeController(p);
    engine.start();
    await expect(engine.runFlow('devices')).rejects.toThrow(/no manual event/);
    expect(engine.getSnapshot().values.result.value).toBeNull();
    expect(engine.getSnapshot().logs.some((log) => log.message.includes('No simulated data'))).toBe(
      true,
    );
    engine.dispose();
  });

  it('keeps a pending execution alive across appearance-only revisions', async () => {
    vi.useFakeTimers();
    const p = project();
    p.widgets = [createWidget('text', 0, 0, 2)];
    flow(p, 'work', [
      node('entry', 'event'),
      node('delay', 'delay', { ms: 500 }),
      node('write', 'write', { variable: 'counter', value: 7 }),
    ]);
    const engine = new RuntimeController(p);
    engine.start();
    const work = engine.runFlow('work');
    await vi.advanceTimersByTimeAsync(0);
    const appearance = structuredClone(p);
    appearance.revision++;
    appearance.widgets[0].style.color = '#112233';
    engine.applyProject(appearance);
    await vi.advanceTimersByTimeAsync(500);
    await work;
    expect(engine.getSnapshot().values.counter.value).toBe(7);
    expect(engine.getSnapshot().revision).toBe(appearance.revision);
    engine.dispose();
  });

  it('does not block a UI flow behind a suspended v4 execution', async () => {
    vi.useFakeTimers();
    const p = project();
    flow(p, 'slow', [node('entry-slow', 'event'), node('wait', 'delay', { ms: 500 })]);
    flow(p, 'fast', [
      node('entry-fast', 'event'),
      node('write', 'write', { variable: 'counter', value: 9 }),
    ]);
    const engine = new RuntimeController(p);
    const slow = engine.runFlow('slow');
    await vi.advanceTimersByTimeAsync(0);
    await engine.runFlow('fast');
    expect(engine.getSnapshot().values.counter.value).toBe(9);
    await vi.advanceTimersByTimeAsync(500);
    await slow;
    engine.dispose();
  });

  it('reads controlled timer enable and interval from current values and stops without backlog', async () => {
    vi.useFakeTimers();
    const p = project();
    flow(p, 'timer', [
      node('timer', 'event', {
        trigger: 'controlledInterval',
        interval: variable('period'),
        enabled: variable('enabled'),
      }),
      node('read', 'read', { variable: 'counter' }),
      node('add', 'math', { operation: 'add', operand: 1 }),
      node('write', 'write', { variable: 'counter' }),
    ]);
    const engine = new RuntimeController(p);
    engine.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.getSnapshot().values.counter.value).toBe(0);
    engine.setVariable('enabled', true);
    await vi.advanceTimersByTimeAsync(500);
    expect(Number(engine.getSnapshot().values.counter.value)).toBeGreaterThan(0);
    engine.setVariable('enabled', false);
    const stopped = engine.getSnapshot().values.counter.value;
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.getSnapshot().values.counter.value).toBe(stopped);
    engine.stop();
    engine.setVariable('enabled', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.getSnapshot().values.counter.value).toBe(stopped);
    engine.dispose();
  });

  it('serializes same-script state even when v4 flows run concurrently', async () => {
    const p = project();
    p.scripts = [
      { id: 'script', name: 'Counter', source: 'void qg_process(void) {}', timeoutMs: 1000 },
    ];
    flow(p, 'run', [node('entry', 'event'), node('script', 'script', { scriptId: 'script' })]);
    const requests: ScriptRequest[] = [];
    const engine = new RuntimeController(p, async (request) => {
      requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        output: null,
        writes: { counter: (request.state.runs ?? 0) + 1 },
        state: { runs: (request.state.runs ?? 0) + 1 },
        logs: [],
      };
    });
    await Promise.all([engine.runFlow('run'), engine.runFlow('run')]);
    expect(requests.map((request) => request.state.runs ?? 0)).toEqual([0, 1]);
    expect(engine.getSnapshot().values.counter.value).toBe(2);
    engine.dispose();
  });
});
