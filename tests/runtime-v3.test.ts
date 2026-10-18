import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/project';
import type { Json, Project, ScriptRequest, ScriptResponse } from '../src/core/types';
import { getValueAtPath, setValueAtPath, assertJsonValue } from '../src/core/jsonValue';
import { RuntimeController } from '../src/runtime/engine';

function project(): Project {
  const p = createProject();
  p.schemaVersion = 3;
  p.windows = [];
  p.flows = [];
  p.scripts = [];
  p.variables = [{ id: 'data', name: 'payload', type: 'json', initial: { a: [null, 1], b: 2 } }];
  return p;
}
function flow(p: Project, middle: Project['flows'][number]['nodes'][number]) {
  p.flows = [
    {
      id: 'f',
      name: 'F',
      enabled: true,
      nodes: [
        { id: 'start', label: 'Start', kind: 'event', position: { x: 0, y: 0 }, config: {} },
        middle,
        {
          id: 'write',
          label: 'Write',
          kind: 'write',
          position: { x: 0, y: 0 },
          config: { variable: 'data' },
        },
      ],
      edges: [
        { id: 'a', source: 'start', target: middle.id },
        { id: 'b', source: middle.id, target: 'write' },
      ],
    },
  ];
}
describe('v3 runtime contract', () => {
  it('patches JSON siblings atomically and clones external objects', () => {
    const p = project();
    const e = new RuntimeController(p);
    (p.variables[0].initial as { a: Json[] }).a[0] = 99;
    expect(getValueAtPath(e.getSnapshot().values.data.value, ['a', 0])).toBeNull();
    e.setVariable('data', 3, ['a', 0]);
    e.setVariable('data', 4, ['b']);
    expect(e.getSnapshot().values.data.value).toEqual({ a: [3, 1], b: 4 });
    expect(() => e.setVariable('data', 9, ['a', 2])).toThrow(/Missing/);
    expect(e.getSnapshot().values.data.value).toEqual({ a: [3, 1], b: 4 });
    const value = { nested: [1] };
    e.setVariable('data', value);
    value.nested[0] = 99;
    expect(e.getSnapshot().values.data.value).toEqual({ nested: [1] });
    p.revision++;
    e.applyProject(p);
    expect(e.getSnapshot().values.data.value).toEqual({ nested: [1] });
    e.dispose();
  });
  it('distinguishes missing paths and null; rejects holes, prototypes, depth and bytes', () => {
    expect(getValueAtPath({ a: null }, ['a'])).toBeNull();
    expect(() => getValueAtPath({}, ['toString'])).toThrow(/Missing/);
    expect(() => getValueAtPath([1], ['0'])).toThrow(/Missing/);
    expect(() => setValueAtPath({ a: [] }, ['a', 1], 1)).toThrow(/Missing/);
    expect(() => assertJsonValue(Array(1))).toThrow(/holes/);
    expect(() => assertJsonValue({ x: Infinity })).toThrow(/Invalid/);
    expect(() => assertJsonValue('x'.repeat(1024 * 1024))).toThrow(/MiB/);
    let deep: Json = null;
    for (let i = 0; i < 33; i++) deep = [deep];
    expect(() => assertJsonValue(deep)).toThrow(/depth/);
    const safe = JSON.parse('{"__proto__":{"safe":true}}') as Json;
    expect(
      getValueAtPath(setValueAtPath(safe, ['__proto__', 'safe'], false), ['__proto__', 'safe']),
    ).toBe(false);
  });
  it('uses structural equality and original JSON payload on the true branch', async () => {
    const p = project();
    flow(p, {
      id: 'condition',
      label: 'Condition',
      kind: 'condition',
      position: { x: 0, y: 0 },
      config: { operator: 'eq', value: { x: [2, null] } },
    });
    const e = new RuntimeController(p);
    await e.runFlow('f', { x: [2, null] });
    expect(e.getSnapshot().values.data.value).toEqual({ x: [2, null] });
    await e.runFlow('f', { x: [9, null] });
    expect(e.getSnapshot().values.data.value).toEqual({ x: [2, null] });
    e.dispose();
  });
  it('does not coerce v3 math and forwards the actual constant write value', async () => {
    const p = project();
    flow(p, {
      id: 'math',
      label: 'Math',
      kind: 'math',
      position: { x: 0, y: 0 },
      config: { operation: 'add', operand: 1 },
    });
    const e = new RuntimeController(p);
    await expect(e.runFlow('f', '2')).rejects.toThrow(/numeric/);
    await e.runFlow('f', 2);
    expect(e.getSnapshot().values.data.value).toBe(3);
    e.dispose();
    flow(p, {
      id: 'constant',
      label: 'Constant',
      kind: 'write',
      position: { x: 0, y: 0 },
      config: { variable: 'data', value: { answer: 42 } },
    });
    const next = new RuntimeController(p);
    await next.runFlow('f', 0);
    expect(next.getSnapshot().values.data.value).toEqual({ answer: 42 });
    next.dispose();
  });
  it('treats an empty path as a typed scalar root, including legacy APIs', () => {
    const p = project();
    p.schemaVersion = 1;
    delete p.windows;
    p.variables = [{ id: 'data', name: 'payload', type: 'number', initial: 0 }];
    const e = new RuntimeController(p);
    e.setVariable('data', 17, []);
    expect(e.getSnapshot().values.data.value).toBe(17);
    expect(() => e.setVariable('data', 'wrong', [])).toThrow(/Expected number/);
    expect(e.getSnapshot().values.data.value).toBe(17);
    e.dispose();
  });
  it('preserves legacy coercion and constant write forwarding', async () => {
    const p = project();
    p.schemaVersion = 1;
    delete p.windows;
    p.variables = [{ id: 'data', name: 'payload', type: 'number', initial: 0 }];
    flow(p, {
      id: 'math',
      label: 'Math',
      kind: 'math',
      position: { x: 0, y: 0 },
      config: { operation: 'add', operand: 1 },
    });
    const old = new RuntimeController(p);
    await old.runFlow('f', '2');
    expect(old.getSnapshot().values.data.value).toBe(3);
    old.dispose();
    flow(p, {
      id: 'constant',
      label: 'Constant',
      kind: 'write',
      position: { x: 0, y: 0 },
      config: { variable: 'data', value: 42 },
    });
    const next = new RuntimeController(p);
    await next.runFlow('f', 7);
    expect(next.getSnapshot().values.data.value).toBe(7);
    next.dispose();
  });
  it('commits numeric C writes and state together; excludes numeric JSON variables', async () => {
    const p = project();
    p.variables.push(
      { id: 'n', name: 'number', type: 'number', initial: 1 },
      { id: 'locked', name: 'locked', type: 'number', initial: 2, readOnly: true },
    );
    p.variables[0].initial = 7;
    p.scripts = [
      {
        id: 's',
        name: 'S',
        source: 'void qg_process(void){}',
        timeoutMs: 1000,
        variableAliases: { left: 'n', right: 'n', locked: 'locked' },
      },
    ];
    const requests: ScriptRequest[] = [];
    let invalid = true;
    const e = new RuntimeController(p, async (request): Promise<ScriptResponse> => {
      requests.push(request);
      return {
        output: 3,
        writes: invalid ? { n: 3, locked: 8 } : { n: 3 },
        state: { runs: (request.state.runs ?? 0) + 1 },
        logs: [],
      };
    });
    await expect(e.runScript('s', 0, p.revision + 1)).rejects.toThrow(/revision was not accepted/);
    expect(requests).toHaveLength(0);
    await expect(e.runScript('s', 0)).rejects.toThrow(/Invalid C write/);
    expect(e.getSnapshot().values.n.value).toBe(1);
    expect(requests[0].variables.data).toBeUndefined();
    invalid = false;
    await e.runScript('s', 0);
    expect(requests[1].state).toEqual({});
    await e.runScript('s', 0);
    expect(requests[2].state.runs).toBe(1);
    expect(e.getSnapshot().values.n.value).toBe(3);
    e.dispose();
  });
});
