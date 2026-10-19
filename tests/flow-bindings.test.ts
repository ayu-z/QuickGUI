import { describe, expect, it } from 'vitest';
import { createEmptyProject, createWidget } from '../src/core/project';
import { createBlockInterface } from '../src/core/functionBlocks';
import { reconcileFlowBinding } from '../src/core/flowBindings';
import { validateProject } from '../src/core/validation';
import { copySelection, preparePaste } from '../src/core/clipboard';
import { exportProject, importProject } from '../src/core/archive';
import { RuntimeController } from '../src/runtime/engine';
import type { FlowBinding, FlowNode } from '../src/core/types';

function fixture() {
  const project = createEmptyProject();
  project.variables = [
    { id: 'a', name: 'A', type: 'number', initial: 0 },
    { id: 'b', name: 'B', type: 'number', initial: 0 },
  ];
  const node = (id: string, kind: FlowNode['kind'], config: FlowNode['config']): FlowNode => {
    const value = { id, kind, config, label: id, position: { x: 0, y: 0 } };
    return { ...value, block: createBlockInterface(value, project) };
  };
  project.flows = [
    {
      id: 'main',
      name: 'Main',
      enabled: true,
      nodes: [
        node('a-event', 'event', { trigger: 'manual' }),
        node('b-event', 'event', { trigger: 'manual' }),
        node('a-write', 'write', { variable: 'a' }),
        node('b-write', 'write', { variable: 'b' }),
      ],
      edges: [
        { id: 'a', source: 'a-event', target: 'a-write' },
        { id: 'b', source: 'b-event', target: 'b-write' },
      ],
    },
  ];
  project.widgets = ['a', 'b'].map((id) => {
    const widget = createWidget('button', 0, 0);
    widget.id = `button-${id}`;
    widget.events.click = { flowId: 'main', entryNodeId: `${id}-event` };
    return widget;
  });
  return validateProject(project);
}

describe('multiple event entries in one flow', () => {
  it('runs only the selected entry and preserves the original payload', async () => {
    const project = fixture(),
      engine = new RuntimeController(project);
    try {
      for (const [index, payload] of [7, 19].entries()) {
        const binding = project.widgets[index].events.click as Exclude<FlowBinding, string>;
        await engine.runFlow(binding.flowId, payload, binding.entryNodeId);
      }
      expect(engine.getSnapshot().values.a.value).toBe(7);
      expect(engine.getSnapshot().values.b.value).toBe(19);
      expect(importProject(exportProject(project))).toEqual(project);
    } finally {
      engine.dispose();
    }
  });
  it('rejects ambiguous flows, missing entries, non-event nodes and automatic sources', () => {
    for (const binding of [
      'main',
      { flowId: 'main', entryNodeId: 'missing' },
      { flowId: 'main', entryNodeId: 'a-write' },
      { flowId: 'missing', entryNodeId: 'a-event' },
    ]) {
      const project = fixture();
      project.widgets[0].events.click = binding;
      expect(() => validateProject(project)).toThrow();
    }
    const project = fixture();
    project.flows[0].nodes[0].config.trigger = 'startup';
    expect(() => validateProject(project)).toThrow(/event entry/);
  });
  it('does not run any branch when a multi-entry flow is started without choosing an entry', async () => {
    const engine = new RuntimeController(fixture());
    try {
      await expect(engine.runFlow('main', 42)).rejects.toThrow(/Choose a manual event entry/);
      expect(engine.getSnapshot().values.a.value).toBe(0);
      expect(engine.getSnapshot().values.b.value).toBe(0);
    } finally {
      engine.dispose();
    }
  });
  it('keeps an existing widget on its original entry when another entry is added', () => {
    const flow = fixture().flows[0],
      previous = structuredClone(flow);
    previous.nodes = previous.nodes.filter((node) => node.id !== 'b-event');
    expect(reconcileFlowBinding('main', [previous], [flow])).toEqual({
      flowId: 'main',
      entryNodeId: 'a-event',
    });
    expect(
      reconcileFlowBinding({ flowId: 'main', entryNodeId: 'b-event' }, [flow], [previous]),
    ).toBeUndefined();
  });
  it('remaps copied flow and entry IDs together, including module event bindings', () => {
    const source = fixture();
    source.modules.push({
      id: 'module',
      name: 'Module',
      version: '1.0.0',
      width: 100,
      height: 100,
      widgets: [structuredClone(source.widgets[1])],
      exposedProps: {},
    });
    const instance = createWidget('module', 0, 0);
    instance.moduleId = 'module';
    source.widgets.push(instance);
    const bundle = copySelection(source, { kind: 'window', id: 'main' }, [
      source.widgets[0].id,
      instance.id,
    ]);
    const plan = preparePaste(createEmptyProject(), bundle, { kind: 'window', id: 'main' });
    const flow = plan.candidate.flows[0];
    for (const widget of [
      ...plan.candidate.widgets,
      ...plan.candidate.modules.flatMap((module) => module.widgets),
    ]) {
      const binding = widget.events.click;
      if (!binding) continue;
      expect(binding).toEqual({
        flowId: flow.id,
        entryNodeId:
          plan.mappings.nodes.main[
            widget.type === 'button' && widget.id === plan.mappings.widgets[source.widgets[0].id]
              ? 'a-event'
              : 'b-event'
          ],
      });
      expect(
        flow.nodes.some((node) => typeof binding === 'object' && node.id === binding.entryNodeId),
      ).toBe(true);
    }
    expect(plan.candidate.flows[0].enabled).toBe(false);
  });
});
