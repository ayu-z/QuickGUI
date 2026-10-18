import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendNodeValue,
  createFlowNodeConfig,
  filterSerialPorts,
  flowNodePorts,
  getFlowNodeReferences,
  isAutomaticEventSource,
  mapNodeValue,
  parseUsbId,
  remapFlowNodeReferences,
  resolveValueRef,
  validateV4NodeConfig,
} from '../src/core/flowV4';
import { createEmptyProject, createProject, createWidget } from '../src/core/project';
import { upgradeProject } from '../src/core/migration';
import { validateFlow, validateProject } from '../src/core/validation';
import { exportProject, importProject } from '../src/core/archive';
import { EditorStore } from '../src/core/store';
import { connectionReferences, variableReferences } from '../src/core/references';
import { copySelection, preparePaste } from '../src/core/clipboard';
import type { Flow, FlowNode, Json, Project, RuntimeValue } from '../src/core/types';

vi.mock('../src/native/bridge', () => ({
  isDesktop: () => false,
  readClipboardText: vi.fn(),
  writeClipboardText: vi.fn(),
}));
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
  label: id,
  config,
  position: { x: 0, y: 0 },
});
function flow(id: string, nodes: FlowNode[]): Flow {
  return {
    id,
    name: id,
    enabled: true,
    nodes,
    edges: nodes
      .slice(1)
      .map((n, index) => ({ id: `${id}_${index}`, source: nodes[index].id, target: n.id })),
  };
}
function project(id = 'source'): Project {
  const p = upgradeProject(createEmptyProject(id), 4);
  p.id = id;
  p.variables = [
    {
      id: 'history',
      name: 'History',
      type: 'json',
      initial: { rows: [], dropped: 0, untouched: true },
    },
    {
      id: 'settings',
      name: 'Settings',
      type: 'json',
      initial: { portName: '/dev/cu.example', send: 'hello' },
    },
    { id: 'period', name: 'Period', type: 'number', initial: 1000 },
    { id: 'enabled', name: 'Enabled', type: 'boolean', initial: false },
  ];
  p.connections = [
    {
      id: 'serial_profile',
      name: 'Port',
      protocol: 'serial',
      config: { address: '/dev/cu.example', baudRate: 115200 },
    },
  ];
  return p;
}
const values = (p: Project): Record<string, RuntimeValue> =>
  Object.fromEntries(
    p.variables.map((v) => [
      v.id,
      { value: structuredClone(v.initial), quality: 'good', timestamp: 0 },
    ]),
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shared v4 ValueRef and JSON operations', () => {
  it('resolves strict literal/input/stable variable values without aliases or missing-to-null coercion', () => {
    const p = project(),
      current = values(p);
    expect(resolveValueRef(literal(null), {}, current)).toBeNull();
    expect(resolveValueRef(input(['items', 0, 'value']), { items: [{ value: 7 }] }, current)).toBe(
      7,
    );
    expect(resolveValueRef(variable('settings', ['send']), null, current)).toBe('hello');
    expect(() => resolveValueRef(variable('Settings'), null, current)).toThrow(/Missing variable/);
    expect(() => resolveValueRef(input(['items', '0']), { items: [7] }, current)).toThrow(
      /path segment/,
    );
    expect(() =>
      resolveValueRef({ source: 'literal', value: 1, variable: 'settings' }, null, current),
    ).toThrow();
    expect(() => resolveValueRef(input(['missing']), {}, current)).toThrow();
    const output = resolveValueRef(variable('settings'), null, current) as Record<string, Json>;
    output.send = 'changed';
    expect((current.settings.value as Record<string, Json>).send).toBe('hello');
  });
  it('maps arrays relative to each item while retaining global variable references and literal payloads', () => {
    const p = project(),
      current = values(p),
      source: Json = {
        ports: [
          { portName: 'A', nested: { id: 1 } },
          { portName: 'B', nested: { id: 2 } },
        ],
      };
    const before = structuredClone(source);
    expect(
      mapNodeValue(
        {
          operation: 'array',
          items: input(['ports']),
          fields: {
            value: input(['portName']),
            label: input(['nested', 'id']),
            setting: variable('settings', ['send']),
            raw: literal({ source: 'variable', variable: 'not_a_dependency' }),
          },
        },
        source,
        current,
      ),
    ).toEqual([
      {
        value: 'A',
        label: 1,
        setting: 'hello',
        raw: { source: 'variable', variable: 'not_a_dependency' },
      },
      {
        value: 'B',
        label: 2,
        setting: 'hello',
        raw: { source: 'variable', variable: 'not_a_dependency' },
      },
    ]);
    expect(source).toEqual(before);
    expect(() =>
      mapNodeValue({ operation: 'array', items: literal({}), fields: {} }, null, current),
    ).toThrow(/array/);
    expect(() =>
      mapNodeValue({ operation: 'object', fields: { x: input(['missing']) } }, {}, current),
    ).toThrow();
    expect(() =>
      mapNodeValue(
        {
          operation: 'array',
          items: literal(Array(130).fill(0)),
          fields: { x: literal('x'.repeat(8192)) },
        },
        null,
        current,
      ),
    ).toThrow(/1 MiB/);
  });
  it('retains own JSON data keys such as __proto__ in literal values and object maps', () => {
    const p = project(),
      current = values(p),
      data = JSON.parse('{"__proto__":{"kept":true},"constructor":3}') as Json;
    expect(resolveValueRef(literal(data), null, current)).toEqual(data);
    const fields = JSON.parse(
      '{"__proto__":{"source":"literal","value":{"kept":true}},"constructor":{"source":"literal","value":3}}',
    ) as Record<string, Json>;
    expect(mapNodeValue({ operation: 'object', fields }, null, current)).toEqual(data);
    p.flows = [
      flow('preserve', [
        node('entry', 'event'),
        node('map', 'map', { operation: 'object', fields }),
      ]),
    ];
    expect(importProject(exportProject(p))).toEqual(p);
    expect(Object.hasOwn(Object.prototype, 'kept')).toBe(false);
  });
  it.each(['oldestFirst', 'latestFirst'] as const)(
    'atomically bounds %s history and counts evictions',
    (order) => {
      const p = project(),
        current = values(p);
      current.history.value = {
        rows: order === 'oldestFirst' ? ['oldest', 'newer'] : ['newer', 'oldest'],
        dropped: 4,
        untouched: true,
      };
      const before = structuredClone(current);
      const result = appendNodeValue(
        {
          variable: 'history',
          path: ['rows'],
          droppedPath: ['dropped'],
          item: input(),
          order,
          maxItems: 2,
        },
        'newest',
        p,
        current,
      );
      const items = order === 'oldestFirst' ? ['newer', 'newest'] : ['newest', 'newer'];
      expect(result).toEqual({
        variableId: 'history',
        value: { rows: items, dropped: 5, untouched: true },
        output: { items, droppedItems: 1, droppedTotal: 5 },
      });
      expect(current).toEqual(before);
    },
  );
  it('counts UTF-8 JSON brackets/commas, rejects single oversize records and validates the entire candidate', () => {
    const p = project(),
      current = values(p);
    current.history.value = { rows: ['界'], dropped: 0, untouched: true };
    const config = {
      variable: 'history',
      path: ['rows'],
      droppedPath: ['dropped'],
      item: input(),
      maxBytes: 7,
    };
    const before = structuredClone(current);
    expect(appendNodeValue(config, 'é', p, current).output).toEqual({
      items: ['é'],
      droppedItems: 1,
      droppedTotal: 1,
    });
    expect(() => appendNodeValue({ ...config, maxBytes: 5 }, 'é', p, current)).toThrow(
      /Single display item/,
    );
    expect(() => appendNodeValue({ ...config, droppedPath: ['rows', 0] }, 'x', p, current)).toThrow(
      /overlap/,
    );
    expect(() =>
      appendNodeValue({ ...config, droppedPath: ['missing'] }, 'x', p, current),
    ).toThrow();
    expect(current).toEqual(before);
    current.history.value = { rows: [], dropped: 0, large: 'a'.repeat(1048500) };
    expect(() =>
      appendNodeValue({ ...config, maxBytes: 512000 }, 'b'.repeat(200), p, current),
    ).toThrow(/1 MiB/);
    expect((current.history.value as Record<string, Json>).rows).toEqual([]);
  });
  it('rejects readonly/scalar targets, invalid limits and unsafe counter increments without a write', () => {
    const p = project(),
      current = values(p),
      config = { variable: 'history', path: ['rows'], item: input() };
    p.variables[0].readOnly = true;
    expect(() => appendNodeValue(config, 1, p, current)).toThrow(/writable JSON/);
    p.variables[0].readOnly = false;
    expect(() => appendNodeValue({ ...config, variable: 'period' }, 1, p, current)).toThrow(
      /writable JSON/,
    );
    for (const limits of [
      { maxItems: 0 },
      { maxItems: 1.2 },
      { maxBytes: 1 },
      { maxBytes: 1048577 },
    ])
      expect(() => appendNodeValue({ ...config, ...limits }, 1, p, current)).toThrow();
    current.history.value = { rows: [1], dropped: Number.MAX_SAFE_INTEGER };
    expect(() =>
      appendNodeValue({ ...config, droppedPath: ['dropped'], maxItems: 1 }, 2, p, current),
    ).toThrow(/safe integer/);
    expect(current.history.value).toEqual({ rows: [1], dropped: Number.MAX_SAFE_INTEGER });
  });
  it('checks the output envelope before exposing a commit candidate', () => {
    const p = project();
    p.variables = [{ id: 'rows', name: 'rows', type: 'json', initial: [] }];
    const current = values(p);
    expect(() =>
      appendNodeValue(
        { variable: 'rows', item: input(), maxBytes: 1048576 },
        'x'.repeat(1048572),
        p,
        current,
      ),
    ).toThrow(/1 MiB/);
    expect(current.rows.value).toEqual([]);
  });
  it('filters VID and PID with AND while unknown metadata never matches a specified ID', () => {
    const ports = [
      { portName: 'A', vid: 0x1a86, pid: 0x7523 },
      { portName: 'B', vid: 0x1a86, pid: 0x5523 },
      { portName: 'C', vid: null, pid: null },
    ];
    expect(filterSerialPorts(ports, '0x1A86', '7523')).toEqual([ports[0]]);
    expect(filterSerialPorts(ports, 0x1a86, '')).toEqual(ports.slice(0, 2));
    expect(filterSerialPorts(ports, '', ' ')).toEqual(ports);
    expect(parseUsbId('1234')).toBe(0x1234);
    expect(parseUsbId(1234)).toBe(1234);
    for (const value of [null, true, -1, 65536, 1.5, '65535', '0x', 'xyz'])
      expect(() => parseUsbId(value)).toThrow();
  });
});

describe('v4 schemas, ports and version boundaries', () => {
  it('keeps 1–3 documents unchanged, explicitly upgrades to 4 and rejects version 5', () => {
    expect(createEmptyProject().schemaVersion).toBe(3);
    for (const version of [1, 2, 3] as const) {
      const p = createProject();
      p.schemaVersion = version;
      if (version >= 2) p.windows = [];
      const before = structuredClone(p);
      expect(importProject(exportProject(p))).toEqual(before);
      const next = upgradeProject(p, 4);
      expect(next.schemaVersion).toBe(4);
      expect(upgradeProject(next).schemaVersion).toBe(4);
      expect(p).toEqual(before);
      expect(importProject(exportProject(next))).toEqual(next);
    }
    expect(() => validateProject({ ...project(), schemaVersion: 5 })).toThrow(/schemaVersion 5/);
    expect(() => upgradeProject({ ...project(), schemaVersion: 5 } as unknown as Project)).toThrow(
      /Unsupported/,
    );
  });
  it('allows new configs only in v4, rejects missing refs and keeps defaults out of saved data', () => {
    const p = project();
    p.flows = [
      flow('data', [
        node('entry', 'event'),
        node('map', 'map', { operation: 'value', value: variable('settings', ['send']) }),
        node('append', 'append', { variable: 'history', path: ['rows'], item: input() }),
      ]),
    ];
    const before = structuredClone(p);
    expect(validateProject(p)).toEqual(before);
    expect(p).toEqual(before);
    for (const version of [1, 2, 3])
      expect(() =>
        validateProject({
          ...p,
          schemaVersion: version,
          ...(version === 1 ? { windows: undefined } : {}),
        }),
      ).toThrow();
    p.flows[0].nodes[1].config.value = variable('Settings');
    expect(() => validateProject(p)).toThrow(/stable variable ID/);
    p.flows[0].nodes[1].config.value = variable('settings');
    p.connections[0].protocol = 'tcp';
    p.flows[0].nodes.push(
      node('send', 'serial', { action: 'close', connectionId: 'serial_profile' }),
    );
    expect(() => validateProject(p)).toThrow(/serial connection/);
    const legacy = createEmptyProject();
    legacy.flows = [
      flow('timer', [
        node('event', 'event', {
          trigger: 'controlledInterval',
          interval: literal(1000),
          enabled: literal(false),
        }),
      ]),
    ];
    expect(() => validateProject(legacy)).toThrow(/schemaVersion 4/);
  });
  it('validates action settings and controlled-interval literal types before execution', () => {
    const p = project();
    expect(validateV4NodeConfig(node('filter', 'serial', { action: 'filter' })).ports).toEqual(
      input(['ports']),
    );
    expect(() =>
      validateV4NodeConfig(
        node('timer', 'event', {
          trigger: 'controlledInterval',
          interval: literal(99),
          enabled: literal(false),
        }),
      ),
    ).toThrow(/100/);
    expect(() =>
      validateV4NodeConfig(
        node('timer', 'event', { trigger: 'controlledInterval', enabled: literal('false') }),
      ),
    ).toThrow(/boolean/);
    expect(() =>
      validateV4NodeConfig(
        node('open', 'serial', {
          action: 'open',
          connectionId: 'serial_profile',
          settings: literal({ uiState: true }),
        }),
        p,
      ),
    ).toThrow();
    expect(() =>
      validateV4NodeConfig(
        node('send', 'serial', {
          ...createFlowNodeConfig('serial', p, 'send'),
          timeoutMs: literal(15001),
        }),
        p,
      ),
    ).toThrow(/15000/);
    expect(() =>
      validateV4NodeConfig(node('bad', 'serial', { action: 'scan', connectionId: 'unused' })),
    ).toThrow();
  });
  it('uses success/error only for new actions, and refuses fake target/source ports in v4', () => {
    expect(flowNodePorts(node('n', 'map')).outputs).toEqual(['success', 'error']);
    expect(flowNodePorts(node('e', 'event')).inputs).toEqual([]);
    const f = flow('f', [
      node('e', 'event'),
      node('map', 'map', { operation: 'value', value: input() }),
      node('write', 'write', { variable: 'history' }),
    ]);
    expect(validateFlow(f, 4)).toEqual(['e', 'map', 'write']);
    f.edges[1].sourceHandle = 'error';
    expect(validateFlow(f, 4)).toHaveLength(3);
    f.edges[1].sourceHandle = 'output';
    expect(() => validateFlow(f, 4)).toThrow(/source port/);
    f.edges[1].sourceHandle = undefined;
    f.edges[1].targetHandle = 'wrong';
    expect(() => validateFlow(f, 4)).toThrow(/target port/);
    const old = flow('old', [node('e', 'event'), node('write', 'write')]);
    old.edges[0].sourceHandle = 'vendor';
    expect(validateFlow(old, 3)).toHaveLength(2);
  });
  it('never downgrades v4 when adding windows and creates modern widgets in v4', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    vi.useFakeTimers();
    const store = new EditorStore(project());
    store.addWindow('Extra');
    store.addWidget('text');
    const saved = store.getSnapshot().project!;
    expect(saved.schemaVersion).toBe(4);
    expect(saved.windows?.[0].widgets[0].definitionVersion).toBe(2);
    store.dispose();
  });
});

describe('shared v4 dependency references', () => {
  it.each(['enabled', 'period'] as const)(
    'copies a timer reading the UI %s control and reaches its serial observer without any variable writes',
    (controlVariable) => {
      const source = project(),
        control = createWidget(controlVariable === 'enabled' ? 'switch' : 'number');
      control.id = 'control';
      control.bindings.value = { variable: controlVariable, mode: 'twoWay' };
      source.widgets = [control];
      source.variables.push({
        id: 'unrelated_enabled',
        name: 'Unrelated enabled',
        type: 'boolean',
        initial: false,
      });
      source.connections.push({
        id: 'unrelated_port',
        name: 'Other port',
        protocol: 'serial',
        config: { address: '/dev/cu.other' },
      });
      source.flows = [
        // This source precedes the timer and can only be discovered on the next fixed-point pass.
        flow('serial_observer', [
          node('rx', 'event', { trigger: 'serial', event: 'data', connectionId: 'serial_profile' }),
          node('rx_log', 'log', { message: 'Received' }),
        ]),
        flow('send_timer', [
          node('tick', 'event', {
            trigger: 'controlledInterval',
            interval: variable('period'),
            enabled: variable('enabled'),
          }),
          node('send', 'serial', {
            ...createFlowNodeConfig('serial', source, 'send'),
            data: variable('settings', ['send']),
          }),
        ]),
        flow('unrelated_timer', [
          node('other_tick', 'event', {
            trigger: 'controlledInterval',
            interval: literal(1000),
            enabled: variable('unrelated_enabled'),
          }),
          node('other_send', 'serial', {
            ...createFlowNodeConfig('serial', source, 'send'),
            connectionId: 'unrelated_port',
          }),
        ]),
      ];
      expect(
        source.flows.every((entry) =>
          entry.nodes.every((n) =>
            getFlowNodeReferences(n).every((reference) => reference.access !== 'write'),
          ),
        ),
      ).toBe(true);
      const before = structuredClone(source),
        scope = { kind: 'window' as const, id: 'main' };
      const bundle = copySelection(source, scope, ['control']);
      expect(bundle.flows.map((entry) => entry.id)).toEqual(['serial_observer', 'send_timer']);
      expect(bundle.variables.map((entry) => entry.id).sort()).toEqual([
        'enabled',
        'period',
        'settings',
      ]);
      expect(bundle.connections.map((entry) => entry.id)).toEqual(['serial_profile']);
      const target = createEmptyProject('target');
      target.id = 'target';
      const plan = preparePaste(target, bundle, scope);
      expect(plan.candidate.flows).toHaveLength(2);
      expect(plan.candidate.flows.every((entry) => entry.enabled === false)).toBe(true);
      const timer = plan.candidate.flows.find(
        (entry) => entry.id === plan.mappings.flows.send_timer,
      )!;
      expect(getFlowNodeReferences(timer.nodes[0]).map((reference) => reference.id)).toEqual([
        plan.mappings.variables.period,
        plan.mappings.variables.enabled,
      ]);
      const observer = plan.candidate.flows.find(
        (entry) => entry.id === plan.mappings.flows.serial_observer,
      )!;
      expect(getFlowNodeReferences(observer.nodes[0])[0].id).toBe(
        plan.mappings.connections.serial_profile,
      );
      expect(source).toEqual(before);
      expect(validateProject(plan.candidate)).toEqual(plan.candidate);
    },
  );
  it.each([1, 2, 3] as const)(
    'retains producer-only automatic closure for schema %s',
    (version) => {
      const source = project(),
        control = createWidget('number');
      source.schemaVersion = version;
      if (version === 1) delete source.windows;
      source.variables = [{ id: 'period', name: 'Period', type: 'number', initial: 1000 }];
      control.id = 'control';
      control.bindings.value = { variable: 'period', mode: 'oneWay' };
      source.widgets = [control];
      source.flows = [
        flow('reader', [
          node('read_tick', 'event', { trigger: 'interval', intervalMs: 1000 }),
          node('read', 'read', { variable: 'period' }),
          node('log', 'log', { message: 'Read only' }),
        ]),
        flow('producer', [
          node('write_tick', 'event', { trigger: 'interval', intervalMs: 1000 }),
          node('write', 'write', { variable: 'period', value: 1000 }),
        ]),
      ];
      const before = structuredClone(source);
      const bundle = copySelection(source, { kind: 'window', id: 'main' }, ['control']);
      expect(bundle.flows.map((entry) => entry.id)).toEqual(['producer']);
      expect(source).toEqual(before);
    },
  );
  it('walks only declared ValueRefs, treats literal reference-shaped data as data, and remaps without mutation', () => {
    const mapping = node('map', 'map', {
      operation: 'array',
      items: variable('history', ['rows']),
      fields: {
        text: variable('settings', ['send']),
        raw: literal({ source: 'variable', variable: 'not_real' }),
        item: input(['value']),
      },
    });
    const before = structuredClone(mapping),
      refs = getFlowNodeReferences(mapping);
    expect(refs.map((ref) => [ref.id, ref.path])).toEqual([
      ['history', ['items', 'variable']],
      ['settings', ['fields', 'text', 'variable']],
    ]);
    const copy = remapFlowNodeReferences(mapping, (ref) => 'copy_' + ref.id);
    expect(getFlowNodeReferences(copy).map((ref) => ref.id)).toEqual([
      'copy_history',
      'copy_settings',
    ]);
    expect(copy.config.fields).toMatchObject({
      raw: literal({ source: 'variable', variable: 'not_real' }),
    });
    expect(mapping).toEqual(before);
  });
  it('covers serial sources, controlled timers, append writes and connection deletion protection', () => {
    const p = project();
    p.flows = [
      flow('timer', [
        node('timer', 'event', {
          trigger: 'controlledInterval',
          interval: variable('period'),
          enabled: variable('enabled'),
        }),
        node('send', 'serial', {
          ...createFlowNodeConfig('serial', p, 'send'),
          data: variable('settings', ['send']),
        }),
      ]),
      flow('rx', [
        node('rx', 'event', { trigger: 'serial', event: 'data', connectionId: 'serial_profile' }),
        node('append', 'append', {
          variable: 'history',
          path: ['rows'],
          droppedPath: ['dropped'],
          item: input(),
        }),
      ]),
    ];
    expect(validateProject(p)).toEqual(p);
    expect(variableReferences(p, p.variables[0])).toEqual(['rx']);
    expect(variableReferences(p, p.variables[2])).toEqual(['timer']);
    expect(connectionReferences(p, 'serial_profile')).toEqual(['timer', 'rx']);
    expect(p.flows.every((f) => isAutomaticEventSource(f.nodes[0]))).toBe(true);
  });
  it('copies complete v4 dependencies, preserves literal bytes and does not downgrade either source or target v4', () => {
    const source = project(),
      button = createWidget('button');
    button.id = 'button';
    button.events.click = 'manual';
    source.widgets = [button];
    source.flows = [
      flow('manual', [
        node('entry', 'event'),
        node('map', 'map', {
          operation: 'object',
          fields: {
            data: variable('settings', ['send']),
            literal: literal({ variable: 'settings' }),
          },
        }),
        node('append', 'append', {
          variable: 'history',
          path: ['rows'],
          droppedPath: ['dropped'],
          item: input(),
        }),
      ]),
      flow('receive', [
        node('rx', 'event', { trigger: 'serial', event: 'data', connectionId: 'serial_profile' }),
        node('capture', 'append', { variable: 'history', path: ['rows'], item: input() }),
      ]),
    ];
    const before = structuredClone(source),
      bundle = copySelection(source, { kind: 'window', id: 'main' }, ['button']);
    const target = createEmptyProject('target');
    target.id = 'target';
    const plan = preparePaste(target, bundle, { kind: 'window', id: 'main' });
    expect(plan.candidate.schemaVersion).toBe(4);
    expect(plan.candidate.flows).toHaveLength(2);
    expect(plan.candidate.connections).toHaveLength(1);
    const map = plan.candidate.flows.flatMap((f) => f.nodes).find((n) => n.kind === 'map')!;
    expect(getFlowNodeReferences(map)[0].id).toBe(plan.mappings.variables.settings);
    expect((map.config.fields as Record<string, Json>).literal).toEqual(
      literal({ variable: 'settings' }),
    );
    expect(plan.candidate.flows.every((f) => !f.enabled)).toBe(true);
    expect(source).toEqual(before);
    validateProject(plan.candidate);
    const v3 = createEmptyProject('v3');
    const text = createWidget('text');
    v3.widgets = [text];
    const simple = copySelection(v3, { kind: 'window', id: 'main' }, [text.id]);
    expect(
      preparePaste(project('existing4'), simple, { kind: 'window', id: 'main' }).candidate
        .schemaVersion,
    ).toBe(4);
  });
});
