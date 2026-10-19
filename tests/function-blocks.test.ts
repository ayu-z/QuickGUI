import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../crates/quickgui-engine/tests/fixtures/function-blocks.json';
import { validateFlow, validateProject } from '../src/core/validation';
import {
  createBlockInterface,
  validateBlockInterface,
  validateDataEdges,
  withBlockInterface,
  withBlockNodeConfig,
} from '../src/core/functionBlocks';
import { createFlowNodeConfig } from '../src/core/flowV4';
import { RuntimeController } from '../src/runtime/engine';
import { upgradeProject } from '../src/core/migration';
import { createEmptyProject } from '../src/core/project';
import { exportProject, importProject } from '../src/core/archive';
import { copySelection, preparePaste } from '../src/core/clipboard';
import type { FlowNode, Project } from '../src/core/types';

vi.mock('../src/native/bridge', () => ({
  isDesktop: () => false,
  readClipboardText: vi.fn(),
  writeClipboardText: vi.fn(),
}));
const project = (): Project => validateProject(structuredClone(fixture));

describe('function block interfaces and graph execution', () => {
  it('normalizes all known versions to v5 with lossless archives', () => {
    const old = createEmptyProject();
    const before = structuredClone(old);
    const upgraded = upgradeProject(old);
    expect(old).toEqual(before);
    expect(upgraded.schemaVersion).toBe(5);
    expect(upgradeProject(upgraded).schemaVersion).toBe(5);
    expect(importProject(exportProject(project()))).toEqual(project());
    for (const version of [1, 2, 3, 4])
      expect(validateProject({ ...project(), schemaVersion: version })).toEqual(project());
    expect(() => validateProject({ ...project(), schemaVersion: 6 })).toThrow(/schemaVersion 6/);
  });
  it('joins independent parameters once, fans a result out, evaluates unwired EN on demand and emits typed comparison outputs', async () => {
    const runtime = new RuntimeController(project());
    await runtime.runFlow('fb');
    const values = runtime.getSnapshot().values;
    expect(values.sum.value).toBe(14);
    expect(values.copy.value).toBe(14);
    expect(values.flag.value).toBe(true);
    runtime.setVariable('a', 2);
    runtime.setVariable('flag', false);
    await runtime.runFlow('fb');
    expect(runtime.getSnapshot().values.sum.value).toBe(6);
    expect(runtime.getSnapshot().values.copy.value).toBe(6);
    expect(runtime.getSnapshot().values.flag.value).toBe(false);
  });
  it('rejects duplicate sources, missing ports, mixed execution/data wires and cycles before execution', () => {
    const p = project(),
      f = p.flows[0];
    const wire = f.edges.find((e) => e.kind === 'data')!;
    expect(() =>
      validateDataEdges({ ...f, edges: [...f.edges, { ...wire, id: 'duplicate' }] }),
    ).toThrow(/already has a source/);
    expect(() =>
      validateDataEdges({ ...f, edges: [{ ...wire, targetHandle: 'data-in:missing' }] }),
    ).toThrow(/Missing data port/);
    expect(() => validateFlow({ ...f, edges: [{ ...wire, kind: undefined }] }, 5)).toThrow(
      /source port/,
    );
    const add = f.nodes.find((n) => n.id === 'add')!;
    expect(() =>
      validateFlow(
        {
          ...f,
          edges: [
            {
              id: 'cycle',
              source: add.id,
              target: add.id,
              sourceHandle: 'data-out:q',
              targetHandle: 'data-in:a',
              kind: 'data',
            },
          ],
        },
        5,
      ),
    ).toThrow(/cycle/);
    const target = f.nodes.find((n) => n.id === 'save')!;
    target.block!.inputs[0].type = 'boolean';
    expect(() => validateProject(p)).toThrow(/Incompatible/);
  });
  it('keeps invalid port edits out of the model and preserves wires by stable ID when renaming', () => {
    const p = project(),
      flow = p.flows[0],
      add = flow.nodes.find((n) => n.id === 'add')!;
    const block = structuredClone(add.block!);
    block.inputs[0].name = 'Left side';
    const renamed = withBlockInterface(flow, add.id, block);
    expect(renamed.edges).toEqual(flow.edges);
    block.inputs[1].id = block.inputs[0].id;
    expect(() => withBlockInterface(flow, add.id, block)).toThrow(/Duplicate/);
    expect(flow.nodes.find((n) => n.id === add.id)!.block!.inputs[0].name).toBe('A');
    const removed = structuredClone(add.block!);
    removed.outputs = [];
    const next = withBlockInterface(flow, add.id, removed);
    expect(next.edges.filter((e) => e.source === add.id)).toHaveLength(0);
  });
  it('refreshes serial action inputs without losing output, execution or unrelated wires', () => {
    const p = project();
    const serial: FlowNode = {
      id: 'serial-fb',
      kind: 'serial',
      label: 'Serial FB',
      position: { x: 0, y: 0 },
      config: createFlowNodeConfig('serial', p, 'send'),
    };
    serial.block = createBlockInterface(serial, p);
    const timeout = serial.block.inputs.find((port) => port.key === 'timeoutMs')!;
    timeout.id = 'stable_timeout';
    timeout.name = 'WAIT';
    timeout.defaultValue = 1000;
    const sink: FlowNode = {
      id: 'sink',
      kind: 'log',
      label: 'sink',
      position: { x: 0, y: 0 },
      config: { message: '' },
    };
    sink.block = createBlockInterface(sink, p);
    const flow = {
      ...p.flows[0],
      nodes: [...p.flows[0].nodes, serial, sink],
      edges: [
        ...p.flows[0].edges,
        {
          id: 'timeout',
          source: 'left',
          sourceHandle: 'data-out:q',
          target: serial.id,
          targetHandle: 'data-in:stable_timeout',
          kind: 'data' as const,
        },
        {
          id: 'result',
          source: serial.id,
          sourceHandle: 'data-out:q',
          target: sink.id,
          targetHandle: 'data-in:in',
          kind: 'data' as const,
        },
        { id: 'trigger', source: 'start', target: serial.id },
      ],
    };
    const edited = withBlockNodeConfig(
      flow,
      serial.id,
      { ...serial.config, data: { source: 'literal', value: 'new' } },
      p,
    );
    expect(edited.nodes.find((n) => n.id === serial.id)!.block).toEqual(serial.block);
    expect(edited.edges).toEqual(flow.edges);
    for (const action of [
      'scan',
      'filter',
      'open',
      'close',
      'listenStart',
      'listenStop',
      'setReconnect',
      'resetCounters',
      'send',
    ] as const) {
      const next = withBlockNodeConfig(
        edited,
        serial.id,
        createFlowNodeConfig('serial', p, action),
        p,
      );
      const node = next.nodes.find((n) => n.id === serial.id)!;
      expect(() => validateBlockInterface(node)).not.toThrow();
      expect(() => validateFlow(next, 5)).not.toThrow();
      expect(node.block!.outputs).toEqual(serial.block.outputs);
      expect(next.edges).toEqual(flow.edges.filter((e) => action === 'send' || e.id !== 'timeout'));
      if (action === 'send')
        expect(node.block!.inputs.find((port) => port.key === 'timeoutMs')).toEqual(timeout);
      if (action === 'open')
        expect(node.block!.inputs.map((port) => port.key)).toEqual(['settings']);
    }
    expect(serial.config.action).toBe('send');
    expect(flow.edges).toHaveLength(p.flows[0].edges.length + 3);
  });
  it('validates block versions, names, paths, defaults and bindings strictly', () => {
    const base = project().flows[0].nodes.find((n) => n.id === 'add')!;
    for (const change of [
      (n: FlowNode) => {
        n.block!.version = 2 as 1;
      },
      (n: FlowNode) => {
        n.block!.inputs[0].defaultValue = 'wrong';
      },
      (n: FlowNode) => {
        n.block!.inputs[0].id = 'not a port';
      },
      (n: FlowNode) => {
        n.block!.inputs[1].key = 'operation';
      },
      (n: FlowNode) => {
        n.block!.outputs[0].path = [-1];
      },
      (n: FlowNode) => {
        n.block!.inputs[0].name = '';
      },
    ]) {
      const next = structuredClone(base);
      change(next);
      expect(() => validateBlockInterface(next)).toThrow();
    }
    expect(createBlockInterface(base, project()).inputs.map((p) => p.name)).toEqual(['A', 'B']);
  });
  it('routes fallible block errors without writing success values', async () => {
    const p = project(),
      f = p.flows[0],
      add = f.nodes.find((n) => n.id === 'add')!;
    add.config.operation = 'divide';
    p.variables.find((v) => v.id === 'b')!.initial = 0;
    f.edges = f.edges.filter((e) => !(e.source === 'start' && e.target === 'compare'));
    f.nodes.push({
      id: 'save-error',
      kind: 'write',
      label: 'error',
      position: { x: 0, y: 0 },
      config: { variable: 'error' },
    });
    f.edges.push({
      id: 'error',
      source: 'add',
      sourceHandle: 'error',
      target: 'save-error',
      targetHandle: 'input',
    });
    // Execute the block explicitly; a missing result cannot feed a success consumer.
    f.edges = f.edges.filter((e) => !(e.target === 'save' || e.target === 'save-copy'));
    f.edges.push({ id: 'trigger', source: 'start', target: 'add' });
    const runtime = new RuntimeController(p);
    await runtime.runFlow('fb');
    expect(runtime.getSnapshot().values.sum.value).toBe(0);
    expect(runtime.getSnapshot().values.error.value).toMatchObject({ code: 'BLOCK_ERROR' });
  });
  it('does not reuse data from a preceding activation or a gated-off block', async () => {
    const p = project(),
      f = p.flows[0];
    f.edges.push({
      id: 'read-only-when-true',
      source: 'compare',
      sourceHandle: 'true',
      target: 'left',
    });
    // This would introduce a dependency cycle and must be rejected rather than use stale data.
    expect(() => validateProject(p)).toThrow(/cycle/);
    const q = project(),
      g = q.flows[0];
    g.edges.push({ id: 'unfired-read', source: 'save-copy', target: 'right' });
    expect(() => validateProject(q)).toThrow(/cycle/);
    const r = project(),
      h = r.flows[0];
    h.nodes.push({
      id: 'other',
      kind: 'event',
      label: 'other',
      config: { trigger: 'manual' },
      position: { x: 0, y: 0 },
    });
    h.edges.push({ id: 'read-gated', source: 'other', target: 'right' });
    const runtime = new RuntimeController(r);
    await runtime.runFlow('fb', null, 'other');
    await expect(runtime.runFlow('fb', null, 'start')).rejects.toThrow(
      /has not executed in this run/,
    );
    expect(runtime.getSnapshot().values.sum.value).toBe(0);
  });
  it('runs a lazy upstream error branch and skips consumers of its unavailable data', async () => {
    const p = project(),
      f = p.flows[0];
    p.variables.find((v) => v.id === 'b')!.initial = 0;
    f.nodes.find((n) => n.id === 'add')!.config.operation = 'divide';
    f.edges = f.edges.filter((e) => !(e.source === 'start' && e.target === 'compare'));
    f.nodes.push({
      id: 'save-error',
      kind: 'write',
      label: 'error',
      position: { x: 0, y: 0 },
      config: { variable: 'error' },
    });
    f.edges.push({ id: 'error', source: 'add', sourceHandle: 'error', target: 'save-error' });
    const runtime = new RuntimeController(p);
    await runtime.runFlow('fb');
    expect(runtime.getSnapshot().values.error.value).toMatchObject({ code: 'BLOCK_ERROR' });
    expect(runtime.getSnapshot().values.sum.value).toBe(0);
    expect(runtime.getSnapshot().values.copy.value).toBe(0);
  });
  it('passes multiple named C arguments and projects independent results without splitting C execution', async () => {
    const p = project(),
      f = p.flows[0],
      block = f.nodes.find((n) => n.id === 'add')!;
    block.kind = 'script';
    block.config = { scriptId: 's' };
    block.block!.inputs = ['a', 'b'].map((key) => ({
      id: key,
      name: key,
      key,
      binding: 'field',
      type: 'number',
    }));
    block.block!.outputs = [
      { id: 'q', name: 'SUM', type: 'number', path: ['sum'] },
      { id: 'difference', name: 'DIFF', type: 'number', path: ['difference'] },
    ];
    f.edges.find((e) => e.source === 'add' && e.target === 'save-copy')!.sourceHandle =
      'data-out:difference';
    p.scripts = [
      {
        id: 's',
        name: 'FB',
        source: await readFile('sdk/tests/function-block.c', 'utf8'),
        timeoutMs: 5000,
      },
    ];
    const execute = vi.fn(async (request) => {
      expect(request.input).toEqual({ a: 10, b: 4 });
      return { output: { sum: 14, difference: 6 }, writes: {}, state: {}, logs: [] };
    });
    const runtime = new RuntimeController(p, execute);
    await runtime.runFlow('fb');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().values.sum.value).toBe(14);
    expect(runtime.getSnapshot().values.copy.value).toBe(6);
  });
  it('copies a control with FB dependencies into an older project without losing port IDs or data edges', () => {
    const p = project();
    p.widgets = [
      {
        id: 'button',
        type: 'button',
        name: 'run',
        layout: { x: 0, y: 0, width: 100, height: 30 },
        props: { text: 'run' },
        style: {},
        states: {},
        bindings: {},
        events: { click: 'fb' },
      },
    ];
    const bundle = copySelection(p, { kind: 'window', id: 'main' }, ['button']);
    const paste = preparePaste(createEmptyProject(), bundle, { kind: 'window', id: 'main' });
    expect(paste.candidate.schemaVersion).toBe(5);
    const copied = paste.candidate.flows.find((f) => f.nodes.some((n) => n.block))!;
    expect(copied.edges.filter((e) => e.kind === 'data')).toHaveLength(7);
    expect(copied.nodes.find((n) => n.kind === 'math')!.block).toEqual(
      p.flows[0].nodes.find((n) => n.kind === 'math')!.block,
    );
    expect(() => validateProject(paste.candidate)).not.toThrow();
  });
  it('isolates persistent C state by FB instance while sharing the same script definition', async () => {
    const p = project(),
      f = p.flows[0],
      first = f.nodes.find((n) => n.id === 'add')!;
    first.kind = 'script';
    first.config = { scriptId: 's' };
    first.block!.inputs = ['a', 'b'].map((key) => ({
      id: key,
      name: key,
      key,
      binding: 'field',
      type: 'number',
    }));
    const second = structuredClone(first);
    second.id = 'second';
    f.nodes.push(second);
    const copy = f.edges.find((e) => e.source === 'add' && e.target === 'save-copy')!;
    copy.source = 'second';
    f.edges.push(
      {
        id: 'second-a',
        source: 'left',
        sourceHandle: 'data-out:q',
        target: 'second',
        targetHandle: 'data-in:a',
        kind: 'data',
      },
      {
        id: 'second-b',
        source: 'right',
        sourceHandle: 'data-out:q',
        target: 'second',
        targetHandle: 'data-in:b',
        kind: 'data',
      },
    );
    p.scripts = [{ id: 's', name: 'stateful FB', source: '', timeoutMs: 5000 }];
    const states: number[] = [];
    const runtime = new RuntimeController(p, async (request) => {
      const runs = (request.state.runs ?? 0) + 1;
      states.push(runs);
      return { output: runs, state: { runs }, writes: {}, logs: [] };
    });
    await runtime.runFlow('fb');
    await runtime.runFlow('fb');
    expect(states).toEqual([1, 1, 2, 2]);
    expect(runtime.getSnapshot().values.sum.value).toBe(2);
    expect(runtime.getSnapshot().values.copy.value).toBe(2);
  });
});
