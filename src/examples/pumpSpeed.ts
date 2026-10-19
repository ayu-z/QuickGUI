import type { Flow, FlowEdge, FlowNode, Project } from '../core/types';
import { createBlockInterface, dataInputHandle, dataOutputHandle } from '../core/functionBlocks';

/** A browser-runnable FB example: shared inputs, named outputs and output fan-out. */
export function createPumpSpeedFlow(project: Project): Flow {
  const node = (
    id: string,
    kind: FlowNode['kind'],
    label: string,
    x: number,
    y: number,
    config: FlowNode['config'],
  ): FlowNode => ({ id, kind, label, position: { x, y }, config });
  const data = (source: string, output: string, target: string, input: string): FlowEdge => ({
    id: `${source}-${output}-${target}-${input}`,
    kind: 'data',
    source,
    sourceHandle: dataOutputHandle(output),
    target,
    targetHandle: dataInputHandle(input),
  });
  const flow: Flow = {
    id: 'calculate-speed',
    name: 'FB · 调速计算',
    enabled: true,
    nodes: [
      node('speed-trigger', 'event', '点击计算转速', 790, -50, { trigger: 'manual' }),
      node('read-speed', 'read', '目标百分比', 20, 100, { variable: 'speed' }),
      node('read-rated-rpm', 'read', '额定转速', 20, 340, { variable: 'rated_rpm' }),
      node('speed-product', 'math', '百分比 × 额定转速', 280, 100, {
        operation: 'multiply',
        operand: 1,
      }),
      node('speed-percent', 'math', '换算为 rpm', 530, 100, {
        operation: 'divide',
        operand: 100,
      }),
      node('speed-headroom', 'math', '100 − 目标百分比', 530, 400, {
        operation: 'subtract',
        operand: 0,
      }),
      node('speed-results', 'map', '调速结果 FB', 790, 170, {
        operation: 'object',
        fields: {
          rpm: { source: 'input', path: ['rpm'] },
          margin: { source: 'input', path: ['margin'] },
        },
      }),
      node('save-target-rpm', 'write', '保存目标转速', 1080, 70, { variable: 'target_rpm' }),
      node('save-speed-margin', 'write', '保存调节余量', 1080, 290, { variable: 'speed_margin' }),
      node('log-target-rpm', 'log', '记录目标转速', 1080, 510, {}),
    ],
    edges: [
      {
        id: 'speed-trigger-results',
        source: 'speed-trigger',
        target: 'speed-results',
        targetHandle: 'input',
      },
      ...['save-target-rpm', 'save-speed-margin', 'log-target-rpm'].map((target) => ({
        id: `speed-results-${target}`,
        source: 'speed-results',
        sourceHandle: 'success',
        target,
        targetHandle: 'input',
      })),
      data('read-speed', 'q', 'speed-product', 'a'),
      data('read-rated-rpm', 'q', 'speed-product', 'b'),
      data('speed-product', 'q', 'speed-percent', 'a'),
      data('read-speed', 'q', 'speed-headroom', 'b'),
      data('speed-percent', 'q', 'speed-results', 'rpm'),
      data('speed-headroom', 'q', 'speed-results', 'margin'),
      data('speed-results', 'rpm', 'save-target-rpm', 'in'),
      data('speed-results', 'margin', 'save-speed-margin', 'in'),
      data('speed-results', 'rpm', 'log-target-rpm', 'in'),
    ],
  };
  for (const entry of flow.nodes) entry.block = createBlockInterface(entry, project);
  flow.nodes.find((entry) => entry.id === 'speed-headroom')!.block!.inputs[0].defaultValue = 100;
  flow.nodes.find((entry) => entry.id === 'speed-results')!.block = {
    version: 1,
    inputs: [
      { id: 'rpm', name: 'RPM', type: 'number', binding: 'field', key: 'rpm' },
      { id: 'margin', name: 'MARGIN', type: 'number', binding: 'field', key: 'margin' },
    ],
    outputs: [
      { id: 'rpm', name: 'RPM', type: 'number', path: ['rpm'] },
      { id: 'margin', name: 'MARGIN', type: 'number', path: ['margin'] },
    ],
  };
  return flow;
}
