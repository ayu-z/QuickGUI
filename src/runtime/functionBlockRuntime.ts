import type { Flow, FlowNode, Json } from '../core/types';
import { flowNodePorts } from '../core/flowV4';
import {
  dataInputHandle,
  dataOutputHandle,
  isDataEdge,
  prepareBlockInput,
  projectBlockOutputs,
} from '../core/functionBlocks';

type Result = { value: Json; port?: string };

/** Each flow activation owns its data cache. Data wires never enqueue execution. */
export async function runFunctionBlockFlow(
  flow: Flow,
  order: string[],
  pending: Map<string, Json[]>,
  execute: (node: FlowNode, input: Json, port?: string) => Promise<Result>,
): Promise<void> {
  const queues = new Map(
    [...pending].map(([id, values]) => [id, values.map((value) => ({ value, port: 'input' }))]),
  );
  const outputs = new Map<string, Map<string, Json>>();
  const failed = new Set<string>();
  const evaluating = new Set<string>();
  let activations = 0;
  const evaluate = async (
    node: FlowNode,
    message: Json,
    activationPort = 'input',
  ): Promise<void> => {
    if (++activations > 10000) throw new Error('Flow activation limit exceeded');
    if (evaluating.has(node.id)) throw new Error('Cyclic data dependency');
    evaluating.add(node.id);
    try {
      const values = new Map<string, Json>();
      for (const input of node.block?.inputs ?? []) {
        const wire = flow.edges.find(
          (e) =>
            isDataEdge(e) && e.target === node.id && e.targetHandle === dataInputHandle(input.id),
        );
        if (!wire) continue;
        const source = flow.nodes.find((n) => n.id === wire.source)!;
        if (!outputs.has(source.id)) {
          if (
            !source.block ||
            source.kind === 'event' ||
            ['serial', 'usb'].includes(source.kind) ||
            flow.edges.some((e) => !isDataEdge(e) && e.target === source.id)
          )
            throw new Error(
              `Data input ${node.label}.${input.name}: upstream block has not executed in this run`,
            );
          // With no wired EN, an FB is evaluated when an active consumer needs its output.
          await evaluate(source, null);
        }
        const port = source.block!.outputs.find(
          (p) => dataOutputHandle(p.id) === wire.sourceHandle,
        )!;
        if (failed.has(source.id)) {
          failed.add(node.id);
          outputs.set(node.id, new Map());
          return;
        }
        const sourceValues = outputs.get(source.id)!;
        if (!sourceValues.has(port.id))
          throw new Error(`Data output ${source.label}.${port.name} is unavailable`);
        values.set(input.id, sourceValues.get(port.id)!);
      }
      const prepared = prepareBlockInput(node, message, values);
      const result = await execute(prepared.node, prepared.input, activationPort);
      const control = flowNodePorts(node);
      const port = result.port ?? control.defaultOutput;
      const edges = flow.edges.filter(
        (e) =>
          !isDataEdge(e) &&
          e.source === node.id &&
          (e.sourceHandle ?? control.defaultOutput) === port,
      );
      if (port === 'error' && !edges.length)
        throw new Error(`Unhandled block error: ${JSON.stringify(result.value)}`);
      if (port === 'error') failed.add(node.id);
      else failed.delete(node.id);
      outputs.set(node.id, projectBlockOutputs(node, prepared.input, result));
      for (const edge of edges) {
        const queue = queues.get(edge.target) ?? [];
        if (queue.length >= 256) throw new Error('Node input queue limit exceeded');
        queue.push({
          value: structuredClone(
            ['serial', 'usb'].includes(node.kind) &&
              ['discover', 'communicate'].includes(String(node.config.action)) &&
              port !== 'error'
              ? (result.value as Record<string, Json>).result
              : result.value,
          ),
          port: edge.targetHandle ?? 'input',
        });
        queues.set(edge.target, queue);
      }
    } finally {
      evaluating.delete(node.id);
    }
  };
  for (;;) {
    const next = order.find((id) => queues.get(id)?.length);
    if (next === undefined) break;
    const queue = queues.get(next)!;
    const input = queue.shift()!;
    await evaluate(
      flow.nodes.find((n) => n.id === next)!,
      input.value,
      input.port,
    );
  }
}
