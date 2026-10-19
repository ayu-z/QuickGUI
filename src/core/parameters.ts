import { createBlockInterface } from './functionBlocks';
import { getFlowNodeReferences } from './flowV4';
import { assertJsonValue, cloneJson } from './jsonValue';
import { uid } from './project';
import { variableReferences } from './references';
import type { Flow, FlowNode, Json, Project, Variable, VariableType } from './types';
import { listProjectWindows } from './windows';

export interface ParameterPlacement {
  flowId: string;
  nodeId: string;
  variableId: string;
}

const parameterNames: Record<VariableType, [string, string]> = {
  number: ['数值参数', 'Number parameter'],
  string: ['文本参数', 'Text parameter'],
  boolean: ['布尔参数', 'Boolean parameter'],
  json: ['JSON 参数', 'JSON parameter'],
};

function assertType(type: VariableType): void {
  if (!Object.hasOwn(parameterNames, type))
    throw new Error('不支持的参数类型 / Unsupported parameter type');
}

function defaultInitial(type: VariableType): Json {
  return type === 'number' ? 0 : type === 'string' ? '' : type === 'boolean' ? false : {};
}

function uniqueName(base: string, names: string[]): string {
  const existing = new Set(names);
  let index = 1;
  while (existing.has(`${base} ${index}`)) index++;
  return `${base} ${index}`;
}

function targetFlow(project: Project, flowId: string | undefined): Flow {
  const flow = flowId === undefined ? project.flows[0] : project.flows.find((f) => f.id === flowId);
  if (flow) return flow;
  if (flowId !== undefined) throw new Error('流程不存在 / Flow does not exist');
  const entry: FlowNode = {
    id: uid('event'),
    kind: 'event',
    label: project.locale === 'zh-CN' ? '事件入口' : 'Event',
    position: { x: 60, y: 60 },
    config: { trigger: 'manual' },
  };
  entry.block = createBlockInterface(entry, project);
  return {
    id: uid('flow'),
    name: uniqueName(
      project.locale === 'zh-CN' ? '新流程' : 'New flow',
      project.flows.map((entry) => entry.name),
    ),
    enabled: true,
    nodes: [entry],
    edges: [],
  };
}

function parameterNode(
  project: Project,
  flow: Flow,
  variable: Variable,
  position?: { x: number; y: number },
): FlowNode {
  const nextPosition = position ?? { x: 80, y: 80 + flow.nodes.length * 100 };
  if (!Number.isFinite(nextPosition.x) || !Number.isFinite(nextPosition.y))
    throw new Error('参数位置必须为有限数值 / Parameter position must be finite');
  const node: FlowNode = {
    id: uid('parameter'),
    kind: 'read',
    label: variable.name,
    position: { ...nextPosition },
    config: { variable: variable.id, path: [] },
  };
  // A new variable is not installed yet: derive its typed interface without partially mutating.
  node.block = createBlockInterface(node, {
    ...project,
    variables: [...project.variables.filter((entry) => entry.id !== variable.id), variable],
  });
  return node;
}

/** Call inside one EditorStore.update so the variable and its first reference undo together. */
export function addFlowParameter(
  project: Project,
  flowId: string | undefined,
  type: VariableType,
  position?: { x: number; y: number },
): ParameterPlacement {
  assertType(type);
  const flow = targetFlow(project, flowId);
  const variable: Variable = {
    id: uid('value'),
    name: uniqueName(
      parameterNames[type][project.locale === 'zh-CN' ? 0 : 1],
      project.variables.flatMap((entry) => [entry.name, entry.id]),
    ),
    type,
    initial: defaultInitial(type),
  };
  const node = parameterNode(project, flow, variable, position);
  project.variables.push(variable);
  if (!project.flows.includes(flow)) project.flows.push(flow);
  flow.nodes.push(node);
  return { flowId: flow.id, nodeId: node.id, variableId: variable.id };
}

/** Adds a graph reference to existing shared state without creating another definition. */
export function addParameterReference(
  project: Project,
  flowId: string | undefined,
  variableId: string,
  position?: { x: number; y: number },
): ParameterPlacement {
  const variable = project.variables.find((entry) => entry.id === variableId);
  if (!variable) throw new Error('参数不存在 / Parameter does not exist');
  const flow = targetFlow(project, flowId);
  const node = parameterNode(project, flow, variable, position);
  if (!project.flows.includes(flow)) project.flows.push(flow);
  flow.nodes.push(node);
  return { flowId: flow.id, nodeId: node.id, variableId };
}

function hasNameReferences(project: Project, variable: Variable): boolean {
  // IDs take precedence over names in the legacy resolver.
  if (project.variables.some((entry) => entry.id === variable.name)) return false;
  const widgets = [
    ...listProjectWindows(project).flatMap((window) => window.widgets),
    ...project.modules.flatMap((module) => module.widgets),
  ];
  return (
    widgets.some(
      (widget) =>
        Object.values(widget.bindings).some((binding) => binding.variable === variable.name) ||
        (widget.type === 'chart' &&
          Array.isArray(widget.props.series) &&
          widget.props.series.some(
            (series) =>
              series !== null &&
              typeof series === 'object' &&
              !Array.isArray(series) &&
              series.variableId === variable.name,
          )),
    ) ||
    project.flows.some((flow) =>
      flow.nodes.some((node) =>
        getFlowNodeReferences(node).some(
          (reference) => reference.kind === 'variable' && reference.id === variable.name,
        ),
      ),
    )
  );
}

function validateDefinition(variable: Variable): void {
  assertType(variable.type);
  if (typeof variable.initial !== variable.type && variable.type !== 'json')
    throw new Error('初始值与参数类型不一致 / Initial value does not match parameter type');
  assertJsonValue(variable.initial);
  if (variable.unit !== undefined && typeof variable.unit !== 'string')
    throw new Error('单位必须为文本 / Unit must be text');
  for (const key of ['readOnly', 'persistent'] as const)
    if (variable[key] !== undefined && typeof variable[key] !== 'boolean')
      throw new Error('参数选项必须为布尔值 / Parameter options must be boolean');
  if (variable.alarm !== undefined) {
    if (
      variable.type !== 'number' ||
      variable.alarm === null ||
      typeof variable.alarm !== 'object' ||
      Array.isArray(variable.alarm) ||
      Object.entries(variable.alarm).some(
        ([key, value]) =>
          !['min', 'max'].includes(key) || (value !== undefined && !Number.isFinite(value)),
      )
    )
      throw new Error('报警仅支持有限数值上下限 / Alarms require finite numeric limits');
  }
}

/** Validate the complete next definition before touching the project or its references. */
export function updateParameterDefinition(
  project: Project,
  id: string,
  patch: Partial<Omit<Variable, 'id'>>,
): void {
  const index = project.variables.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error('参数不存在 / Parameter does not exist');
  const current = project.variables[index];
  const next: Variable = { ...current, ...patch, id: current.id };
  if (typeof next.name !== 'string' || !next.name.trim())
    throw new Error('参数名称不能为空 / Parameter name cannot be empty');
  next.name = next.name.trim();
  if (
    project.variables.some(
      (entry) => entry.id !== id && (entry.name === next.name || entry.id === next.name),
    )
  )
    throw new Error('参数名称已存在 / Parameter name already exists');
  assertType(next.type);
  if (next.type !== current.type) {
    const references = variableReferences(project, current);
    if (references.length)
      throw new Error(
        `请先移除参数引用再修改类型 / Remove parameter references before changing type: ${references.join(', ')}`,
      );
    if (!Object.hasOwn(patch, 'initial')) next.initial = defaultInitial(next.type);
    if (next.type !== 'number') delete next.alarm;
  }
  if (next.name !== current.name && hasNameReferences(project, current))
    throw new Error(
      '请先将名称引用改为稳定 ID 再重命名 / Replace legacy name references with stable IDs before renaming',
    );
  validateDefinition(next);
  next.initial = cloneJson(next.initial);
  if (next.alarm) next.alarm = { ...next.alarm };
  project.variables[index] = next;
}

/** Definition deletion never silently removes bound widgets, graph nodes or C aliases. */
export function deleteParameterDefinition(project: Project, id: string): void {
  const variable = project.variables.find((entry) => entry.id === id);
  if (!variable) throw new Error('参数不存在 / Parameter does not exist');
  const references = variableReferences(project, variable);
  if (references.length)
    throw new Error(
      `请先移除参数引用再删除 / Remove parameter references before deleting: ${references.join(', ')}`,
    );
  project.variables = project.variables.filter((entry) => entry.id !== id);
}
