import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '../src/core/project';
import { createFlowNodeConfig, flowNodePorts } from '../src/core/flowV4';
import { createBlockInterface, withBlockNodeConfig } from '../src/core/functionBlocks';
import { validateFlow, validateProject } from '../src/core/validation';
import { runFunctionBlockFlow } from '../src/runtime/functionBlockRuntime';
import { RuntimeController } from '../src/runtime/engine';
import type { Flow, FlowNode, Json } from '../src/core/types';
import { createUsbAssistantProject } from '../src/examples/usbAssistant';
import { exportProject, importProject } from '../src/core/archive';
import { copySelection, preparePaste } from '../src/core/clipboard';
import { readFileSync } from 'node:fs';

const literal = (value: Json): Json => ({ source: 'literal', value });
function fixture() {
  const project = createEmptyProject('USB FB');
  const node = (id: string, kind: FlowNode['kind'], config: FlowNode['config']): FlowNode => {
    const n = { id, kind, config, label: id, position: { x: 0, y: 0 } };
    return { ...n, block: createBlockInterface(n, project) };
  };
  const flow: Flow = {
    id: 'usb',
    name: 'USB',
    enabled: true,
    nodes: [
      node('a', 'event', { trigger: 'manual' }),
      node('b', 'event', { trigger: 'manual' }),
      node('io', 'usb', createFlowNodeConfig('usb', project)),
      node('error', 'log', { message: 'diagnostic' }),
    ],
    edges: [
      { id: 'close', source: 'a', target: 'io', targetHandle: 'close' },
      { id: 'send', source: 'b', target: 'io', targetHandle: 'send' },
      { id: 'error', source: 'io', target: 'error', sourceHandle: 'error' },
    ],
  };
  project.flows = [flow];
  return { project, flow };
}
describe('device discovery and persistent communication FBs', () => {
  it('ships an editable USB demo with shared sessions and explicit device selection', async () => {
    const source = JSON.parse(
      readFileSync(new URL('../examples/usb-assistant/quickgui.json', import.meta.url), 'utf8'),
    );
    expect({ ...createUsbAssistantProject(), id: source.id }).toEqual(source);
    for (const locale of ['zh-CN', 'en'] as const) {
      const project = validateProject(createUsbAssistantProject(locale));
      expect(project.flows).toHaveLength(1);
      expect(project.flows[0].nodes.filter((node) => node.kind === 'usb')).toHaveLength(2);
      expect(importProject(exportProject(project))).toEqual(project);
      expect(
        project.flows
          .flatMap((f) => f.nodes)
          .filter((n) => n.kind === 'usb' && n.config.action === 'communicate')
          .every((n) => n.config.sessionId === 'usb-main'),
      ).toBe(true);
      expect(project.variables.find((v) => v.id === 'usb_device')!.initial).toBe('');
      const runtime = new RuntimeController(project);
      try {
        await runtime.runFlow('usb_discovery', null, 'discover_trigger');
        expect(runtime.getSnapshot().values.usb_error.value).toMatchObject({
          code: 'NATIVE_USB_REQUIRED',
        });
        expect(runtime.getSnapshot().values.usb_devices.value).toEqual([]);
      } finally {
        runtime.dispose();
      }
    }
  });
  it('copies USB observers with controls and isolates shared session IDs across projects', () => {
    const source = createUsbAssistantProject();
    const bundle = copySelection(source, { kind: 'window', id: 'main' }, ['usb_open']);
    expect(bundle.flows).toHaveLength(1);
    expect(bundle.flows[0].nodes.some((node) => node.id === 'usb_receive')).toBe(true);
    const plan = preparePaste(createEmptyProject(), bundle, { kind: 'window', id: 'main' });
    const ids = plan.candidate.flows
      .flatMap((flow) => flow.nodes)
      .filter((node) => node.kind === 'usb' && node.config.action === 'communicate')
      .map((node) => node.config.sessionId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe('usb-main');
  });
  it('preserves distinct command inputs when two activations queue on the same instance', async () => {
    const { flow } = fixture();
    const calls: string[] = [];
    await runFunctionBlockFlow(
      flow,
      validateFlow(flow, 5),
      new Map([
        ['a', [null]],
        ['b', [null]],
      ]),
      async (node, value, port) => {
        if (node.id === 'io') {
          calls.push(port!);
          return { value: { result: value, data: null, state: null }, port: 'success' };
        }
        return { value };
      },
    );
    expect(calls).toEqual(['close', 'send']);
  });
  it('validates exact USB parameters and command ports before accepting the model', () => {
    const { project, flow } = fixture();
    expect(validateProject(project).flows[0].nodes[2].kind).toBe('usb');
    for (const [key, value] of [
      ['reportId', 256],
      ['length', 0],
      ['options', { bulkMaxPacketSize: 63 }],
      ['device', { vendorId: 1 }],
    ] as const) {
      const invalid = structuredClone(project);
      invalid.flows[0].nodes[2].config[key] = literal(value);
      expect(() => validateProject(invalid)).toThrow();
    }
    flow.edges[0].targetHandle = 'opne';
    expect(() => validateFlow(flow, 5)).toThrow(/target port/);
  });
  it('provides only discovery and communication interfaces for each transport', () => {
    const { project } = fixture();
    for (const kind of ['serial', 'usb'] as const) {
      const discovery = { kind, config: createFlowNodeConfig(kind, project, 'discover') };
      const communication = { kind, config: createFlowNodeConfig(kind, project, 'communicate') };
      expect(flowNodePorts(discovery).inputs).toEqual(
        expect.arrayContaining(['scan', 'watch', 'unwatch']),
      );
      expect(flowNodePorts(communication).inputs).toEqual(
        expect.arrayContaining(['open', 'close', 'send']),
      );
      expect(flowNodePorts(communication).outputs).toEqual(
        expect.arrayContaining(['rx', 'tx', 'state', 'error']),
      );
    }
  });
  it('cleans removed USB command and parameter wires when switching the FB type', () => {
    const { flow, project } = fixture();
    const changed = withBlockNodeConfig(
      flow,
      'io',
      createFlowNodeConfig('usb', project, 'discover'),
      project,
    );
    expect(changed.edges.filter((e) => e.target === 'io')).toEqual([]);
    expect(changed.nodes[2].block!.inputs.map((p) => p.key)).toEqual(['filter']);
  });
  it('reports browser capability failure without device or traffic simulation', async () => {
    const { project } = fixture();
    const runtime = new RuntimeController(project);
    try {
      await runtime.runFlow('usb', null, 'a');
      expect(
        runtime.getSnapshot().logs.some((log) => log.message.includes('NATIVE_USB_REQUIRED')),
      ).toBe(true);
    } finally {
      runtime.dispose();
    }
  });
});
