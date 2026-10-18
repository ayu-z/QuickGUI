import type { FlowNode, Json, Project, RuntimeValue } from '../core/types';
import { appendNodeValue, filterSerialPorts, mapNodeValue, resolveValueRef } from '../core/flowV4';

export interface V4NodeResult {
  value: Json;
  port: 'success' | 'error';
}

export function isV4Action(node: FlowNode): boolean {
  return ['map', 'append', 'serial'].includes(node.kind);
}

export function executeV4DataNode(
  node: FlowNode,
  input: Json,
  project: Project,
  values: Record<string, RuntimeValue>,
  write: (variableId: string, value: Json) => void,
): V4NodeResult {
  const config = node.config;
  try {
    if (project.schemaVersion < 4) throw new Error('This node requires schemaVersion 4');
    let value: Json;
    if (node.kind === 'map') value = mapNodeValue(config, input, values);
    else if (node.kind === 'append') {
      const result = appendNodeValue(config, input, project, values);
      write(result.variableId, result.value);
      value = result.output;
    } else if (node.kind === 'serial' && config.action === 'filter') {
      value = filterSerialPorts(
        resolveValueRef(config.ports ?? { source: 'input', path: ['ports'] }, input, values),
        resolveValueRef(config.vid ?? { source: 'literal', value: '' }, input, values),
        resolveValueRef(config.pid ?? { source: 'literal', value: '' }, input, values),
      );
    } else {
      throw Object.assign(
        new Error(
          'Serial ports require the QuickGUI desktop runtime. No simulated data was produced.',
        ),
        { code: 'NATIVE_SERIAL_REQUIRED' },
      );
    }
    return { value, port: 'success' };
  } catch (error) {
    const detail = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    const value: Record<string, Json> = {
      code: typeof detail.code === 'string' ? detail.code : 'FLOW_NODE_FAILED',
      message: error instanceof Error ? error.message : String(error),
      operation: node.kind === 'serial' ? String(config.action) : node.kind,
    };
    if (typeof config.connectionId === 'string') value.connectionId = config.connectionId;
    return { value, port: 'error' };
  }
}
