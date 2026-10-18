import { z } from 'zod';
import type { FlowNode, Json, JsonPath, NodeKind, Project, RuntimeValue, ValueRef } from './types';
import { cloneJson, readJsonPath, replaceJsonPath, validateJsonPath } from './jsonValue';

export const JSON_VALUE_LIMIT = 1024 * 1024;
export const SERIAL_ACTIONS = [
  'scan',
  'filter',
  'open',
  'close',
  'listenStart',
  'listenStop',
  'setReconnect',
  'resetCounters',
  'send',
] as const;
export type SerialAction = (typeof SERIAL_ACTIONS)[number];
export class FlowV4Error extends Error {
  constructor(
    public code: string,
    message: string,
    public operation: string,
  ) {
    super(message);
    this.name = 'FlowV4Error';
  }
}
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]),
);
/** Validate maps without Zod record's __proto__ key elision. JSON data keys are not object prototypes. */
function preservedRecord<T extends z.ZodTypeAny>(schema: T) {
  return z
    .unknown()
    .superRefine((value, context) => {
      const result = z.record(schema).safeParse(value);
      if (!result.success) for (const issue of result.error.issues) context.addIssue(issue);
    })
    .transform((value) => structuredClone(value) as Record<string, z.output<T>>);
}
export const flowConfigRecordSchema = preservedRecord(json);
const literalJsonSchema = z
  .unknown()
  .superRefine((value, context) => {
    try {
      cloneJson(value as Json);
    } catch (error) {
      context.addIssue({ code: 'custom', message: String(error) });
    }
  })
  .transform((value) => cloneJson(value as Json));
export const flowPathSchema = z
  .array(z.union([z.string(), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]))
  .max(32);
export const valueRefSchema = z
  .discriminatedUnion('source', [
    z.object({ source: z.literal('literal'), value: literalJsonSchema }).strict(),
    z.object({ source: z.literal('input'), path: flowPathSchema.optional() }).strict(),
    z
      .object({
        source: z.literal('variable'),
        variable: z.string().min(1),
        path: flowPathSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((ref, context) => {
    if (ref.source === 'literal')
      try {
        cloneJson(ref.value);
      } catch (error) {
        context.addIssue({ code: 'custom', message: String(error), path: ['value'] });
      }
  });
const literal = (value: Json): ValueRef => ({ source: 'literal', value });
const input = (): ValueRef => ({ source: 'input' });
export const mapConfigSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('value'), value: valueRefSchema }).strict(),
  z.object({ operation: z.literal('object'), fields: preservedRecord(valueRefSchema) }).strict(),
  z
    .object({
      operation: z.literal('array'),
      items: valueRefSchema,
      fields: preservedRecord(valueRefSchema),
    })
    .strict(),
]);
export const appendConfigSchema = z
  .object({
    variable: z.string().min(1),
    path: flowPathSchema.optional(),
    item: valueRefSchema,
    maxItems: z.number().int().min(1).max(100000).default(500),
    maxBytes: z.number().int().min(2).max(JSON_VALUE_LIMIT).default(524288),
    order: z.enum(['latestFirst', 'oldestFirst']).default('oldestFirst'),
    droppedPath: flowPathSchema.optional(),
  })
  .strict();
const connectionId = z.string().min(1);
export const serialConfigSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('scan') }).strict(),
  z
    .object({
      action: z.literal('filter'),
      ports: valueRefSchema.default((): ValueRef => ({ source: 'input', path: ['ports'] })),
      vid: valueRefSchema.default(() => literal('')),
      pid: valueRefSchema.default(() => literal('')),
    })
    .strict(),
  z.object({ action: z.literal('open'), connectionId, settings: valueRefSchema }).strict(),
  z.object({ action: z.literal('close'), connectionId }).strict(),
  z.object({ action: z.literal('listenStart'), connectionId }).strict(),
  z.object({ action: z.literal('listenStop'), connectionId }).strict(),
  z.object({ action: z.literal('setReconnect'), connectionId, enabled: valueRefSchema }).strict(),
  z.object({ action: z.literal('resetCounters'), connectionId }).strict(),
  z
    .object({
      action: z.literal('send'),
      connectionId,
      data: valueRefSchema,
      encoding: valueRefSchema,
      lineEnding: valueRefSchema,
      timeoutMs: valueRefSchema.optional(),
    })
    .strict(),
]);
export const controlledIntervalConfigSchema = z
  .object({
    trigger: z.literal('controlledInterval'),
    interval: valueRefSchema.default(() => literal(1000)),
    enabled: valueRefSchema.default(() => literal(false)),
  })
  .strict();
export const serialEventConfigSchema = z.discriminatedUnion('event', [
  z
    .object({
      trigger: z.literal('serial'),
      event: z.literal('devices'),
      connectionId: connectionId.optional(),
    })
    .strict(),
  z
    .object({
      trigger: z.literal('serial'),
      event: z.literal('data'),
      connectionId,
      direction: z.enum(['rx', 'tx', 'both']).default('rx'),
    })
    .strict(),
  z.object({ trigger: z.literal('serial'), event: z.literal('state'), connectionId }).strict(),
  z.object({ trigger: z.literal('serial'), event: z.literal('error'), connectionId }).strict(),
]);
export const serialSettingsOverrideSchema = z
  .object({
    portName: z.string().min(1),
    baudRate: z.number().int().min(1).max(4000000),
    dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
    stopBits: z.union([z.literal(1), z.literal(2)]),
    parity: z.enum(['none', 'odd', 'even']),
    flowControl: z.enum(['none', 'software', 'hardware']),
    framing: z.enum(['raw', 'line', 'length16']),
    autoReconnect: z.boolean(),
  })
  .partial()
  .strict();

export function isV4Node(node: Pick<FlowNode, 'kind' | 'config'>): boolean {
  return (
    ['map', 'append', 'serial'].includes(node.kind) ||
    (node.kind === 'event' &&
      ['serial', 'controlledInterval'].includes(String(node.config.trigger)))
  );
}
export const requiresFlowV4 = isV4Node;
export function isAutomaticEventSource(node: Pick<FlowNode, 'kind' | 'config'>): boolean {
  return (
    node.kind === 'event' &&
    ['startup', 'interval', 'serial', 'controlledInterval'].includes(String(node.config.trigger))
  );
}
function parsedConfig(node: Pick<FlowNode, 'kind' | 'config'>): Record<string, Json> {
  const schema =
    node.kind === 'map'
      ? mapConfigSchema
      : node.kind === 'append'
        ? appendConfigSchema
        : node.kind === 'serial'
          ? serialConfigSchema
          : node.kind === 'event' && node.config.trigger === 'serial'
            ? serialEventConfigSchema
            : node.kind === 'event' && node.config.trigger === 'controlledInterval'
              ? controlledIntervalConfigSchema
              : undefined;
  if (!schema) return structuredClone(node.config);
  try {
    return schema.parse(node.config) as Record<string, Json>;
  } catch (error) {
    throw new FlowV4Error(
      'INVALID_CONFIG',
      error instanceof Error ? error.message : String(error),
      node.kind,
    );
  }
}
export interface FlowNodeReference {
  kind: 'variable' | 'connection' | 'script' | 'window';
  id: string;
  /** Path relative to node.config; literal payloads are never scanned. */
  path: JsonPath;
  access?: 'read' | 'write';
}
export function getFlowNodeReferences(
  node: Pick<FlowNode, 'kind' | 'config'>,
): FlowNodeReference[] {
  const c = node.config,
    references: FlowNodeReference[] = [];
  const direct = (kind: FlowNodeReference['kind'], key: string, access?: 'read' | 'write') => {
    if (typeof c[key] === 'string' && c[key])
      references.push({ kind, id: c[key], path: [key], ...(access ? { access } : {}) });
  };
  const ref = (value: Json | undefined, path: JsonPath) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.source === 'variable' &&
      typeof value.variable === 'string'
    )
      references.push({
        kind: 'variable',
        id: value.variable,
        path: [...path, 'variable'],
        access: 'read',
      });
  };
  const fields = () => {
    if (c.fields && typeof c.fields === 'object' && !Array.isArray(c.fields))
      for (const [key, value] of Object.entries(c.fields)) ref(value, ['fields', key]);
  };
  if (node.kind === 'read' || node.kind === 'write')
    direct('variable', 'variable', node.kind === 'read' ? 'read' : 'write');
  if (node.kind === 'script') direct('script', 'scriptId');
  if (node.kind === 'connection') direct('connection', 'connectionId');
  if (node.kind === 'window') direct('window', 'windowId');
  if (node.kind === 'map') {
    if (c.operation === 'value') ref(c.value, ['value']);
    else {
      if (c.operation === 'array') ref(c.items, ['items']);
      fields();
    }
  }
  if (node.kind === 'append') {
    direct('variable', 'variable', 'write');
    ref(c.item, ['item']);
  }
  if (node.kind === 'serial') {
    if (!['scan', 'filter'].includes(String(c.action))) direct('connection', 'connectionId');
    for (const key of c.action === 'filter'
      ? ['ports', 'vid', 'pid']
      : c.action === 'open'
        ? ['settings']
        : c.action === 'setReconnect'
          ? ['enabled']
          : c.action === 'send'
            ? ['data', 'encoding', 'lineEnding', 'timeoutMs']
            : [])
      ref(c[key], [key]);
  }
  if (node.kind === 'event' && c.trigger === 'serial') direct('connection', 'connectionId');
  if (node.kind === 'event' && c.trigger === 'controlledInterval') {
    ref(c.interval, ['interval']);
    ref(c.enabled, ['enabled']);
  }
  return references;
}
export const flowNodeReferences = getFlowNodeReferences;
export function remapFlowNodeReferences(
  node: FlowNode,
  map: (reference: FlowNodeReference) => string,
): FlowNode {
  const next = structuredClone(node);
  for (const reference of getFlowNodeReferences(node))
    next.config = replaceJsonPath(next.config, reference.path, map(reference)) as Record<
      string,
      Json
    >;
  return next;
}
const overlap = (a: JsonPath, b: JsonPath) =>
  a.slice(0, Math.min(a.length, b.length)).every((part, i) => part === b[i]);
export function validateV4NodeConfig(
  node: Pick<FlowNode, 'kind' | 'config'>,
  project?: Project,
): Record<string, Json> {
  const c = parsedConfig(node);
  if (!isV4Node(node)) return c;
  const literalValue = (key: string): Json | undefined => {
    const ref = c[key];
    return ref && typeof ref === 'object' && !Array.isArray(ref) && ref.source === 'literal'
      ? ref.value
      : undefined;
  };
  const checkLiteral = (key: string, test: (value: Json) => boolean, message: string) => {
    const value = literalValue(key);
    if (value !== undefined && !test(value))
      throw new FlowV4Error('INVALID_CONFIG', message, node.kind);
  };
  if (node.kind === 'event' && c.trigger === 'controlledInterval') {
    checkLiteral(
      'interval',
      (value) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 86400000,
      'Controlled interval must be an integer from 100 to 86400000 ms',
    );
    checkLiteral(
      'enabled',
      (value) => typeof value === 'boolean',
      'Controlled interval enabled must be boolean',
    );
  }
  if (node.kind === 'serial') {
    if (c.action === 'filter')
      for (const key of ['vid', 'pid']) {
        const value = literalValue(key);
        if (value !== undefined) parseUsbId(value);
      }
    if (c.action === 'setReconnect')
      checkLiteral(
        'enabled',
        (value) => typeof value === 'boolean',
        'Auto reconnect enabled must be boolean',
      );
    if (c.action === 'send') {
      checkLiteral('data', (value) => typeof value === 'string', 'Send data must be a string');
      checkLiteral(
        'encoding',
        (value) => value === 'utf8' || value === 'hex',
        'Encoding must be utf8 or hex',
      );
      checkLiteral(
        'lineEnding',
        (value) => ['none', 'lf', 'crlf'].includes(String(value)),
        'Line ending must be none, lf or crlf',
      );
      checkLiteral(
        'timeoutMs',
        (value) =>
          typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 15000,
        'Send timeout must be an integer from 1 to 15000 ms',
      );
    }
    if (c.action === 'open' && literalValue('settings') !== undefined) {
      const result = serialSettingsOverrideSchema.safeParse(literalValue('settings'));
      if (!result.success) throw new FlowV4Error('INVALID_CONFIG', result.error.message, 'serial');
    }
  }
  if (node.kind === 'append') {
    const path = (c.path ?? []) as JsonPath;
    if (c.droppedPath !== undefined && overlap(path, c.droppedPath as JsonPath))
      throw new FlowV4Error(
        'INVALID_CONFIG',
        'Append array and dropped counter paths must not overlap',
        'append',
      );
  }
  if (project)
    for (const reference of getFlowNodeReferences({ ...node, config: c })) {
      if (reference.kind === 'variable') {
        const variable = project.variables.find((variable) => variable.id === reference.id);
        if (!variable)
          throw new FlowV4Error(
            'INVALID_REFERENCE',
            `Missing stable variable ID: ${reference.id}`,
            node.kind,
          );
        if (reference.access === 'write' && (variable.readOnly || variable.type !== 'json'))
          throw new FlowV4Error(
            'INVALID_REFERENCE',
            'Append requires a writable JSON variable',
            node.kind,
          );
        if (reference.path.length > 1) {
          const ref = readJsonPath(c, reference.path.slice(0, -1)) as unknown as ValueRef;
          if (ref.source === 'variable' && ref.path?.length && variable.type !== 'json')
            throw new FlowV4Error(
              'INVALID_REFERENCE',
              'ValueRef paths require a JSON variable',
              node.kind,
            );
        }
      } else if (
        reference.kind === 'connection' &&
        !project.connections.some(
          (connection) => connection.id === reference.id && connection.protocol === 'serial',
        )
      )
        throw new FlowV4Error(
          'INVALID_REFERENCE',
          `Missing serial connection: ${reference.id}`,
          node.kind,
        );
    }
  return c;
}
export const validateFlowV4Node = validateV4NodeConfig;
export const validateV4Config = validateV4NodeConfig;
export function resolveValueRef(
  raw: unknown,
  inputValue: Json,
  values: Record<string, RuntimeValue>,
): Json {
  let ref: ValueRef;
  try {
    ref = valueRefSchema.parse(raw) as ValueRef;
  } catch (error) {
    throw new FlowV4Error('INVALID_CONFIG', String(error), 'value');
  }
  if (ref.source === 'literal') return cloneJson(ref.value);
  const value =
    ref.source === 'input'
      ? inputValue
      : Object.hasOwn(values, ref.variable)
        ? values[ref.variable].value
        : undefined;
  if (value === undefined)
    throw new FlowV4Error(
      'VALUE_ERROR',
      `Missing variable value: ${ref.source === 'variable' ? ref.variable : 'input'}`,
      'value',
    );
  try {
    return readJsonPath(value, ref.path ?? []);
  } catch (error) {
    throw new FlowV4Error('VALUE_ERROR', String(error), 'value');
  }
}
const bytes = (value: Json): number => new TextEncoder().encode(JSON.stringify(value)).length;
function mappedObject(
  fields: Record<string, Json>,
  inputValue: Json,
  values: Record<string, RuntimeValue>,
): Record<string, Json> {
  const result: Record<string, Json> = {};
  let size = 2;
  for (const [key, ref] of Object.entries(fields)) {
    const value = resolveValueRef(ref, inputValue, values);
    size +=
      new TextEncoder().encode(JSON.stringify(key)).length +
      1 +
      bytes(value) +
      (Object.keys(result).length ? 1 : 0);
    if (size > JSON_VALUE_LIMIT)
      throw new FlowV4Error('VALUE_TOO_LARGE', 'Mapped JSON exceeds 1 MiB', 'map');
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cloneJson(result) as Record<string, Json>;
}
export function mapNodeValue(
  config: unknown,
  inputValue: Json,
  values: Record<string, RuntimeValue>,
): Json {
  const c = validateV4NodeConfig({ kind: 'map', config: config as Record<string, Json> });
  if (c.operation === 'value') return resolveValueRef(c.value, inputValue, values);
  if (c.operation === 'object')
    return mappedObject(c.fields as Record<string, Json>, inputValue, values);
  const items = resolveValueRef(c.items, inputValue, values);
  if (!Array.isArray(items))
    throw new FlowV4Error('VALUE_ERROR', 'Map array items must resolve to an array', 'map');
  const result: Json[] = [];
  let size = 2;
  for (const item of items) {
    const mapped = mappedObject(c.fields as Record<string, Json>, item, values);
    size += bytes(mapped) + (result.length ? 1 : 0);
    if (size > JSON_VALUE_LIMIT)
      throw new FlowV4Error('VALUE_TOO_LARGE', 'Mapped JSON exceeds 1 MiB', 'map');
    result.push(mapped);
  }
  return cloneJson(result);
}
export function appendNodeValue(
  config: unknown,
  inputValue: Json,
  project: Project,
  values: Record<string, RuntimeValue>,
): {
  variableId: string;
  value: Json;
  output: { items: Json[]; droppedItems: number; droppedTotal: number };
} {
  const c = validateV4NodeConfig(
    { kind: 'append', config: config as Record<string, Json> },
    project,
  );
  const variableId = c.variable as string,
    current = values[variableId]?.value;
  if (current === undefined)
    throw new FlowV4Error('VALUE_ERROR', `Missing variable value: ${variableId}`, 'append');
  const path = (c.path ?? []) as JsonPath;
  const array = readJsonPath(current, path);
  if (!Array.isArray(array))
    throw new FlowV4Error('VALUE_ERROR', 'Append target must be an array', 'append');
  const item = resolveValueRef(c.item, inputValue, values),
    maxItems = c.maxItems as number,
    maxBytes = c.maxBytes as number;
  if (bytes([item]) > maxBytes)
    throw new FlowV4Error(
      'APPEND_ITEM_TOO_LARGE',
      'Single display item exceeds the array byte budget',
      'append',
    );
  const items = c.order === 'latestFirst' ? [item, ...array] : [...array, item],
    sizes = items.map(bytes);
  let start = 0,
    end = items.length,
    size = sizes.reduce((total, count) => total + count, 2 + Math.max(0, items.length - 1));
  while (end - start > maxItems || size > maxBytes) {
    size -= c.order === 'latestFirst' ? sizes[--end] : sizes[start++];
    if (end > start) size--;
  }
  const retained = items.slice(start, end),
    droppedItems = items.length - retained.length;
  let droppedTotal = droppedItems;
  if (c.droppedPath !== undefined) {
    const previous = readJsonPath(current, c.droppedPath as JsonPath);
    if (
      typeof previous !== 'number' ||
      !Number.isSafeInteger(previous) ||
      previous < 0 ||
      !Number.isSafeInteger(previous + droppedItems)
    )
      throw new FlowV4Error(
        'VALUE_ERROR',
        'Dropped counter must be an existing nonnegative safe integer',
        'append',
      );
    droppedTotal += previous;
  }
  let value = replaceJsonPath(current, path, retained);
  if (c.droppedPath !== undefined)
    value = replaceJsonPath(value, c.droppedPath as JsonPath, droppedTotal);
  const output = cloneJson({ items: retained, droppedItems, droppedTotal }) as {
    items: Json[];
    droppedItems: number;
    droppedTotal: number;
  };
  return {
    variableId,
    value: cloneJson(value),
    output,
  };
}
export function parseUsbId(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    if (/^(?:0x)?[0-9a-f]{1,4}$/i.test(text)) return Number.parseInt(text.replace(/^0x/i, ''), 16);
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535)
    return value;
  throw new FlowV4Error(
    'VALUE_ERROR',
    'USB ID must be empty, 0–65535 integer, or 1–4 hex digits',
    'serial.filter',
  );
}
export function filterSerialPorts(ports: unknown, vid: unknown, pid: unknown): Json[] {
  if (!Array.isArray(ports))
    throw new FlowV4Error('VALUE_ERROR', 'Serial ports must be an array', 'serial.filter');
  const vendor = parseUsbId(vid),
    product = parseUsbId(pid);
  return ports
    .filter((port) => {
      if (
        !port ||
        typeof port !== 'object' ||
        Array.isArray(port) ||
        typeof port.portName !== 'string'
      )
        throw new FlowV4Error('VALUE_ERROR', 'Invalid serial port entry', 'serial.filter');
      for (const key of ['vid', 'pid'])
        if (
          port[key] !== null &&
          port[key] !== undefined &&
          (typeof port[key] !== 'number' ||
            !Number.isInteger(port[key]) ||
            port[key] < 0 ||
            port[key] > 65535)
        )
          throw new FlowV4Error(
            'VALUE_ERROR',
            'Serial port USB IDs must be numbers or null',
            'serial.filter',
          );
      return (
        (vendor === undefined || port.vid === vendor) &&
        (product === undefined || port.pid === product)
      );
    })
    .map((port) => cloneJson(port as Json));
}

export interface FlowNodePorts {
  inputs: string[];
  outputs: string[];
  defaultOutput: string;
}
export function flowNodePorts(node: Pick<FlowNode, 'kind' | 'config'>): FlowNodePorts {
  if (node.kind === 'event') return { inputs: [], outputs: ['output'], defaultOutput: 'output' };
  if (['serial', 'map', 'append'].includes(node.kind))
    return { inputs: ['input'], outputs: ['success', 'error'], defaultOutput: 'success' };
  if (node.kind === 'condition')
    return { inputs: ['input'], outputs: ['true', 'false'], defaultOutput: 'true' };
  return { inputs: ['input'], outputs: ['output'], defaultOutput: 'output' };
}
const labels: Record<NodeKind, { zh: string; en: string }> = {
  event: { zh: '事件入口', en: 'Event' },
  read: { zh: '读取变量', en: 'Read' },
  write: { zh: '写入变量', en: 'Write' },
  condition: { zh: '条件判断', en: 'Condition' },
  math: { zh: '数学运算', en: 'Math' },
  delay: { zh: '延时', en: 'Delay' },
  log: { zh: '输出日志', en: 'Log' },
  script: { zh: 'C 脚本', en: 'C script' },
  http: { zh: 'HTTP 请求', en: 'HTTP' },
  emit: { zh: '发送事件', en: 'Emit' },
  connection: { zh: '连接诊断', en: 'Connection diagnostic' },
  window: { zh: '窗口操作', en: 'Window' },
  map: { zh: 'JSON 映射', en: 'JSON map' },
  append: { zh: '追加记录', en: 'Append' },
  serial: { zh: '串口操作', en: 'Serial' },
};
export function createFlowNodeConfig(
  kind: NodeKind,
  project?: Project,
  action: SerialAction = 'scan',
): Record<string, Json> {
  const variable = project?.variables[0]?.id ?? '',
    connection = project?.connections.find((entry) => entry.protocol === 'serial')?.id ?? '';
  if (kind === 'map') return { operation: 'value', value: input() };
  if (kind === 'append')
    return {
      variable:
        project?.variables.find((entry) => entry.type === 'json' && !entry.readOnly)?.id ?? '',
      path: [],
      item: input(),
      maxItems: 500,
      maxBytes: 524288,
      order: 'oldestFirst',
    };
  if (kind === 'serial') {
    if (action === 'scan') return { action };
    if (action === 'filter')
      return {
        action,
        ports: { source: 'input', path: ['ports'] },
        vid: literal(''),
        pid: literal(''),
      };
    if (action === 'open') return { action, connectionId: connection, settings: literal({}) };
    if (action === 'send')
      return {
        action,
        connectionId: connection,
        data: literal(''),
        encoding: literal('utf8'),
        lineEnding: literal('none'),
        timeoutMs: literal(5000),
      };
    if (action === 'setReconnect')
      return { action, connectionId: connection, enabled: literal(false) };
    return { action, connectionId: connection };
  }
  const defaults: Record<string, Record<string, Json>> = {
    event: { trigger: 'manual' },
    read: { variable },
    write: { variable },
    condition: { operator: 'gt', value: 0 },
    math: { operation: 'add', operand: 1 },
    delay: { ms: 250 },
    log: { message: 'Flow executed' },
    script: { scriptId: project?.scripts[0]?.id ?? '' },
    http: { url: '', method: 'GET' },
    emit: { event: 'custom-event' },
    connection: { connectionId: project?.connections[0]?.id ?? '' },
    window: { action: 'open', windowId: project?.windows?.[0]?.id ?? 'main' },
  };
  return structuredClone(defaults[kind]);
}
export function getFlowNodeDefinition(kind: NodeKind) {
  return {
    kind,
    label: labels[kind],
    minimumVersion: (['map', 'append', 'serial'].includes(kind) ? 4 : kind === 'window' ? 2 : 1) as
      1 | 2 | 4,
    ports: flowNodePorts({ kind, config: {} }),
    defaultConfig: createFlowNodeConfig(kind),
  };
}
