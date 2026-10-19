import { z } from 'zod';
import type {
  BlockInput,
  Flow,
  FlowEdge,
  FlowNode,
  FunctionBlockInterface,
  Json,
  Project,
  VariableType,
} from './types';
import { cloneJson, readJsonPath, validateJsonPath } from './jsonValue';
import { flowNodePorts } from './flowV4';

const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]),
);
const portId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const portType = z.enum(['number', 'string', 'boolean', 'json']);
const path = z.array(z.union([z.string(), z.number().int().nonnegative()]));
export const blockInterfaceSchema = z
  .object({
    version: z.literal(1),
    inputs: z
      .array(
        z
          .object({
            id: portId,
            name: z
              .string()
              .min(1)
              .max(64)
              .refine((value) => value.trim().length > 0),
            type: portType,
            binding: z.enum(['input', 'config', 'field']),
            key: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
              .optional(),
            defaultValue: json.optional(),
          })
          .strict(),
      )
      .max(16),
    outputs: z
      .array(
        z
          .object({
            id: portId,
            name: z
              .string()
              .min(1)
              .max(64)
              .refine((value) => value.trim().length > 0),
            type: portType,
            path,
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

export const dataInputHandle = (id: string) => `data-in:${id}`;
export const dataOutputHandle = (id: string) => `data-out:${id}`;
export const isDataEdge = (edge: Pick<FlowEdge, 'kind'>) => edge.kind === 'data';
export const compatiblePortTypes = (source: VariableType, target: VariableType) =>
  target === 'json' || source === target;

const configInputs: Partial<Record<FlowNode['kind'], string[]>> = {
  math: ['operand'],
  condition: ['value'],
  delay: ['ms'],
  log: ['message'],
  emit: ['event'],
  http: ['url', 'method', 'body'],
  usb: ['filter', 'device', 'options', 'data', 'encoding', 'reportId', 'length'],
  serial: [
    'ports',
    'vid',
    'pid',
    'settings',
    'data',
    'encoding',
    'lineEnding',
    'timeoutMs',
    'enabled',
  ],
};
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function assertPortValue(type: VariableType, value: Json, name: string): void {
  if ((type !== 'json' && typeof value !== type) || (type === 'number' && !Number.isFinite(value)))
    throw new Error(`Data port ${name} requires ${type}`);
  cloneJson(value);
}

export function validateBlockInterface(node: FlowNode): void {
  if (!node.block) return;
  const block = blockInterfaceSchema.parse(node.block);
  for (const ports of [block.inputs, block.outputs]) {
    if (new Set(ports.map((port) => port.id)).size !== ports.length)
      throw new Error(`Duplicate data port ID on ${node.id}`);
    if (new Set(ports.map((port) => port.name)).size !== ports.length)
      throw new Error(`Duplicate data port name on ${node.id}`);
  }
  const bindings = new Set<string>();
  for (const port of block.inputs) {
    if (node.kind === 'event') throw new Error('Event blocks cannot have data inputs');
    if (port.binding === 'input' ? port.key !== undefined : !port.key || forbidden.has(port.key))
      throw new Error(`Invalid data input binding: ${port.name}`);
    const key = `${port.binding}:${port.key ?? ''}`;
    if (bindings.has(key)) throw new Error(`Duplicate data input binding: ${port.name}`);
    bindings.add(key);
    if (
      port.binding === 'config' &&
      (!configInputs[node.kind]?.includes(port.key!) || !Object.hasOwn(node.config, port.key!))
    )
      throw new Error(`Unsupported parameter ${port.key} on ${node.kind}`);
    if (port.binding === 'field' && !['script', 'map'].includes(node.kind))
      throw new Error('Named object inputs require a script or map block');
    if (Object.hasOwn(port, 'defaultValue'))
      assertPortValue(port.type, port.defaultValue!, port.name);
  }
  if (
    block.inputs.some((p) => p.binding === 'input') &&
    block.inputs.some((p) => p.binding === 'field')
  )
    throw new Error('A block cannot mix a whole input with named object inputs');
  for (const port of block.outputs) validateJsonPath(port.path);
}

export function validateDataEdges(flow: Flow): void {
  const targets = new Set<string>();
  for (const edge of flow.edges) {
    if (!isDataEdge(edge)) continue;
    const source = flow.nodes.find((n) => n.id === edge.source);
    const target = flow.nodes.find((n) => n.id === edge.target);
    const output = source?.block?.outputs.find((p) => dataOutputHandle(p.id) === edge.sourceHandle);
    const input = target?.block?.inputs.find((p) => dataInputHandle(p.id) === edge.targetHandle);
    if (!output || !input) throw new Error(`Missing data port on edge ${edge.id}`);
    if (!compatiblePortTypes(output.type, input.type))
      throw new Error(`Incompatible data ports: ${output.type} → ${input.type}`);
    const key = `${edge.target}\0${edge.targetHandle}`;
    if (targets.has(key)) throw new Error(`Data input ${input.name} already has a source`);
    targets.add(key);
  }
}

export function withBlockInterface(
  flow: Flow,
  nodeId: string,
  block: FunctionBlockInterface,
): Flow {
  const node = flow.nodes.find((n) => n.id === nodeId)!;
  validateBlockInterface({ ...node, block });
  const next: Flow = {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === nodeId ? { ...n, block } : n)),
    edges: flow.edges.filter(
      (e) =>
        !isDataEdge(e) ||
        ((e.source !== nodeId ||
          block.outputs.some((p) => dataOutputHandle(p.id) === e.sourceHandle)) &&
          (e.target !== nodeId ||
            block.inputs.some((p) => dataInputHandle(p.id) === e.targetHandle))),
    ),
  };
  validateDataEdges(next);
  return next;
}

/** Keep serial parameter ports in sync with action changes, retaining matching port identities. */
export function withBlockNodeConfig(
  flow: Flow,
  nodeId: string,
  config: FlowNode['config'],
  project: Project,
): Flow {
  const node = flow.nodes.find((n) => n.id === nodeId)!;
  const updated = { ...node, config };
  const control = flowNodePorts(updated);
  const next = {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === nodeId ? updated : n)),
    edges: flow.edges.filter(
      (e) =>
        isDataEdge(e) ||
        ((e.source !== nodeId ||
          control.outputs.includes(e.sourceHandle ?? control.defaultOutput)) &&
          (e.target !== nodeId || control.inputs.includes(e.targetHandle ?? 'input'))),
    ),
  };
  if (!['serial', 'usb'].includes(node.kind) || !node.block) return next;
  const inputs = node.block.inputs.filter(
    (port) => port.binding !== 'config' || Object.hasOwn(config, port.key!),
  );
  for (const parameter of createBlockInterface(updated, project).inputs) {
    if (inputs.some((p) => p.binding === parameter.binding && p.key === parameter.key)) continue;
    const added = { ...parameter };
    let suffix = 2;
    while (inputs.some((p) => p.id === added.id)) added.id = `${parameter.id}_${suffix++}`;
    suffix = 2;
    while (inputs.some((p) => p.name === added.name)) added.name = `${parameter.name} ${suffix++}`;
    inputs.push(added);
  }
  const changedType =
    node.config.action !== config.action &&
    ['discover', 'communicate'].includes(String(config.action));
  const outputs = changedType
    ? [
        ...createBlockInterface(updated, project).outputs,
        ...node.block.outputs.filter((p) => !['q', 'devices', 'data', 'state'].includes(p.id)),
      ]
    : node.block.outputs;
  return withBlockInterface(next, nodeId, { ...node.block, inputs, outputs });
}

export function createBlockInterface(node: FlowNode, project: Project): FunctionBlockInterface {
  const input = (id: string, name: string, type: VariableType = 'json'): BlockInput => ({
    id,
    name,
    type,
    binding: 'input',
  });
  const parameter = (id: string, name: string, key: string, type: VariableType): BlockInput => ({
    id,
    name,
    type,
    binding: 'config',
    key,
  });
  let inputs: BlockInput[] =
    node.kind === 'event' || node.kind === 'read' ? [] : [input('in', 'IN')];
  let type: VariableType = 'json';
  if (node.kind === 'math') {
    inputs = [input('a', 'A', 'number'), parameter('b', 'B', 'operand', 'number')];
    type = 'number';
  } else if (node.kind === 'condition') {
    const numeric = !['eq', 'neq'].includes(String(node.config.operator));
    inputs = [
      input('a', 'A', numeric ? 'number' : 'json'),
      parameter('b', 'B', 'value', numeric ? 'number' : 'json'),
    ];
  } else if (node.kind === 'delay') {
    inputs.push(parameter('pt', 'PT (ms)', 'ms', 'number'));
  } else if (node.kind === 'script') {
    inputs = [
      { id: 'in', name: 'IN', type: 'json', binding: 'field', key: 'IN', defaultValue: null },
    ];
  } else if (node.kind === 'serial' || node.kind === 'usb') {
    inputs = (configInputs[node.kind] ?? [])
      .filter((key) => Object.hasOwn(node.config, key))
      .map((key) =>
        parameter(
          `p_${key}`,
          key,
          key,
          ['timeoutMs', 'reportId', 'length'].includes(key)
            ? 'number'
            : key === 'enabled'
              ? 'boolean'
              : ['encoding', 'lineEnding'].includes(key)
                ? 'string'
                : 'json',
        ),
      );
  } else if (node.kind === 'read') {
    const variable = project.variables.find((v) => v.id === node.config.variable);
    type =
      node.config.path && (node.config.path as Json[]).length ? 'json' : (variable?.type ?? 'json');
  } else if (node.kind === 'write') {
    const variable = project.variables.find((v) => v.id === node.config.variable);
    type =
      node.config.path && (node.config.path as Json[]).length ? 'json' : (variable?.type ?? 'json');
    inputs = [input('in', 'IN', type)];
  } else if (node.kind === 'http') {
    inputs = ['url', 'method', 'body']
      .filter((key) => Object.hasOwn(node.config, key))
      .map((key) =>
        parameter(`p_${key}`, key.toUpperCase(), key, key === 'body' ? 'json' : 'string'),
      );
  }
  return {
    version: 1,
    inputs,
    outputs:
      ['serial', 'usb'].includes(node.kind) &&
      ['discover', 'communicate'].includes(String(node.config.action))
        ? [
            { id: 'q', name: 'Q', type: 'json', path: ['result'] },
            ...(node.config.action === 'discover'
              ? [{ id: 'devices', name: 'DEVICES', type: 'json' as const, path: ['devices'] }]
              : [
                  { id: 'data', name: 'DATA', type: 'json' as const, path: ['data'] },
                  { id: 'state', name: 'STATE', type: 'json' as const, path: ['state'] },
                ]),
          ]
        : node.kind === 'condition'
          ? [
              { id: 'q', name: 'Q', type: 'boolean', path: ['Q'] },
              { id: 'in', name: 'IN', type: 'json', path: ['IN'] },
            ]
          : [{ id: 'q', name: node.kind === 'event' ? 'VALUE' : 'Q', type, path: [] }],
  };
}

export function prepareBlockInput(
  node: FlowNode,
  message: Json,
  values: Map<string, Json>,
): { node: FlowNode; input: Json } {
  if (!node.block) return { node, input: cloneJson(message) };
  const prepared = structuredClone(node);
  let input = cloneJson(message);
  const fields: Array<[string, Json]> = [];
  for (const port of node.block.inputs) {
    let value: Json;
    if (values.has(port.id)) value = values.get(port.id)!;
    else if (Object.hasOwn(port, 'defaultValue')) value = port.defaultValue!;
    else if (port.binding === 'input') value = message;
    else if (port.binding === 'config') {
      const config = node.config[port.key!];
      // An unconnected v4 reference keeps its variable/input semantics.
      if (['serial', 'usb'].includes(node.kind)) continue;
      value = config;
    } else throw new Error(`Missing value for data input ${port.name}`);
    assertPortValue(port.type, value, port.name);
    value = cloneJson(value);
    if (port.binding === 'input') {
      input = value;
      if (node.kind === 'write') delete prepared.config.value;
    } else if (port.binding === 'field') fields.push([port.key!, value]);
    else
      prepared.config[port.key!] = ['serial', 'usb'].includes(node.kind)
        ? { source: 'literal', value }
        : value;
  }
  if (fields.length) input = Object.fromEntries(fields);
  return { node: prepared, input };
}

export function projectBlockOutputs(
  node: FlowNode,
  input: Json,
  result: { value: Json; port?: string },
): Map<string, Json> {
  const values = new Map<string, Json>();
  if (result.port === 'error') return values;
  const output: Json =
    node.kind === 'condition' ? { Q: result.port === 'true', IN: input } : result.value;
  for (const port of node.block?.outputs ?? []) {
    const value = readJsonPath(output, port.path);
    assertPortValue(port.type, value, port.name);
    values.set(port.id, cloneJson(value));
  }
  return values;
}
