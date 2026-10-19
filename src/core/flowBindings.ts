import type { Flow, FlowBinding } from './types';

export const flowBindingId = (binding: FlowBinding): string =>
  typeof binding === 'string' ? binding : binding.flowId;

export const manualFlowEntries = (flow: Flow) =>
  flow.nodes.filter(
    (node) => node.kind === 'event' && (!node.config.trigger || node.config.trigger === 'manual'),
  );

export function mapFlowBinding(
  binding: FlowBinding,
  flowId: (id: string) => string,
  nodeId: (flow: string, node: string) => string = (_, node) => node,
): FlowBinding {
  return typeof binding === 'string'
    ? flowId(binding)
    : { flowId: flowId(binding.flowId), entryNodeId: nodeId(binding.flowId, binding.entryNodeId) };
}

export function validFlowBinding(binding: FlowBinding, flows: Flow[]): boolean {
  const flow = flows.find((flow) => flow.id === flowBindingId(binding));
  if (!flow) return false;
  const entries = manualFlowEntries(flow);
  return typeof binding === 'string'
    ? entries.length <= 1
    : entries.some((node) => node.id === binding.entryNodeId);
}

export function reconcileFlowBinding(
  binding: FlowBinding,
  previous: Flow[],
  next: Flow[],
): FlowBinding | undefined {
  if (validFlowBinding(binding, next)) return binding;
  if (typeof binding !== 'string') return undefined;
  const old = previous.find((flow) => flow.id === binding);
  const entries = old ? manualFlowEntries(old) : [];
  if (entries.length !== 1) return undefined;
  const exact = { flowId: binding, entryNodeId: entries[0].id };
  return validFlowBinding(exact, next) ? exact : undefined;
}
