import { flowBindingId, manualFlowEntries } from '../core/flowBindings';
import { flowNodePorts } from '../core/flowV4';
import { listProjectWindows } from '../core/windows';
import type { Flow, Project } from '../core/types';

/** Combine the demo recipes, sharing explicitly selected FBs and handlers. */
export function integrateCommunicationFlow(
  project: Project,
  name: string,
  aliases: Record<string, string>,
): Flow {
  const recipes = project.flows;
  const flow: Flow = { ...recipes[0], name, nodes: [], edges: [] };
  const target = (id: string) => aliases[id] ?? id;
  for (const widget of [
    ...listProjectWindows(project).flatMap((window) => window.widgets),
    ...project.modules.flatMap((module) => module.widgets),
  ]) {
    for (const [event, binding] of Object.entries(widget.events)) {
      const recipe = recipes.find((item) => item.id === flowBindingId(binding));
      if (!recipe) continue;
      const entries = manualFlowEntries(recipe);
      if (typeof binding === 'string' && entries.length !== 1)
        throw new Error(`Demo binding needs an exact manual event: ${widget.id}`);
      widget.events[event] = {
        flowId: flow.id,
        entryNodeId: target(typeof binding === 'string' ? entries[0].id : binding.entryNodeId),
      };
    }
  }
  const edges = new Set<string>();
  for (const recipe of recipes) {
    for (const node of recipe.nodes) {
      if (target(node.id) !== node.id) continue;
      if (node.kind === 'event' && node.config.trigger === 'manual')
        node.label = recipe.name.replace(/^\d+\s*·\s*/, '');
      flow.nodes.push(node);
    }
    for (const edge of recipe.edges) {
      const next = { ...edge, source: target(edge.source), target: target(edge.target) };
      // A shared error formatter must not route its own failure back to itself.
      if (next.source === next.target && next.sourceHandle === 'error') continue;
      const key = JSON.stringify([
        next.source,
        next.sourceHandle,
        next.target,
        next.targetHandle,
        next.kind,
      ]);
      if (!edges.has(key)) {
        edges.add(key);
        flow.edges.push(next);
      }
    }
  }
  const levels = new Map<string, number>();
  while (levels.size < flow.nodes.length) {
    let progressed = false;
    for (const node of flow.nodes) {
      if (levels.has(node.id)) continue;
      const incoming = flow.edges.filter((edge) => edge.target === node.id);
      if (incoming.some((edge) => !levels.has(edge.source))) continue;
      levels.set(
        node.id,
        incoming.length ? Math.max(...incoming.map((edge) => levels.get(edge.source)! + 1)) : 0,
      );
      progressed = true;
    }
    if (!progressed) throw new Error('Integrated demo contains a flow cycle');
  }
  const offsets = new Map<number, number>();
  for (const node of flow.nodes) {
    const level = levels.get(node.id)!,
      y = offsets.get(level) ?? 90;
    node.position = { x: 40 + level * 340, y };
    const ports = flowNodePorts(node);
    offsets.set(
      level,
      y +
        160 +
        24 *
          Math.max(
            ports.inputs.length + (node.block?.inputs.length ?? 0),
            ports.outputs.length + (node.block?.outputs.length ?? 0),
          ),
    );
  }
  project.flows = [flow];
  return flow;
}
