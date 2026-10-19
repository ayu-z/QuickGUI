import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addFlowParameter,
  addParameterReference,
  deleteParameterDefinition,
  updateParameterDefinition,
} from '../src/core/parameters';
import { createEmptyProject, createProject, createWidget } from '../src/core/project';
import { EditorStore } from '../src/core/store';
import { validateProject } from '../src/core/validation';
import { exportProject, importProject } from '../src/core/archive';
import { RuntimeController } from '../src/runtime/engine';
import { createBlockInterface } from '../src/core/functionBlocks';
import type { FlowNode, Json, Project, Variable, VariableType } from '../src/core/types';

vi.mock('../src/native/bridge', () => ({
  isDesktop: () => false,
  readClipboardText: vi.fn(),
  writeClipboardText: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const cases: [VariableType, Json, string][] = [
  ['number', 0, '数值参数 1'],
  ['string', '', '文本参数 1'],
  ['boolean', false, '布尔参数 1'],
  ['json', {}, 'JSON 参数 1'],
];

function unreferenced(type: VariableType = 'number'): Project {
  const project = createEmptyProject();
  addFlowParameter(project, undefined, type);
  project.flows = [];
  return project;
}

function rejectsWithoutMutation(project: Project, change: () => void, message?: RegExp): void {
  const before = structuredClone(project);
  if (message) expect(change).toThrow(message);
  else expect(change).toThrow();
  expect(project).toEqual(before);
}

describe('flow parameter components', () => {
  it.each(cases)(
    'creates a %s definition and typed read block without automatic triggers',
    (type, initial, name) => {
      const project = createEmptyProject();
      const result = addFlowParameter(project, undefined, type, { x: 120, y: -80 });
      const flow = project.flows[0];
      expect(flow).toMatchObject({ id: result.flowId, enabled: true, edges: [] });
      expect(flow.nodes).toHaveLength(2);
      expect(flow.nodes[0]).toMatchObject({ kind: 'event', config: { trigger: 'manual' } });
      expect(project.variables).toEqual([{ id: result.variableId, name, type, initial }]);
      expect(flow.nodes[1]).toMatchObject({
        id: result.nodeId,
        kind: 'read',
        label: name,
        position: { x: 120, y: -80 },
        config: { variable: result.variableId, path: [] },
        block: { version: 1, inputs: [], outputs: [{ id: 'q', type, path: [] }] },
      });
      expect(validateProject(project)).toEqual(project);
    },
  );

  it('adds to the selected flow, reuses its ID and leaves other flows unchanged', () => {
    const project = createProject();
    const before = structuredClone(project.flows);
    const target = project.flows.at(-1)!;
    const result = addFlowParameter(project, target.id, 'string');
    expect(result.flowId).toBe(target.id);
    expect(project.flows).toHaveLength(before.length);
    expect(target.nodes.at(-1)!.id).toBe(result.nodeId);
    expect(target.nodes.slice(0, -1)).toEqual(before.at(-1)!.nodes);
    expect(target.edges).toEqual(before.at(-1)!.edges);
    expect(project.flows.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(validateProject(project)).toEqual(project);
  });

  it('uses unique localized names and stable, distinct IDs when adding and referencing parameters', () => {
    const project = createEmptyProject();
    project.locale = 'en';
    project.variables = [
      { id: 'occupied', name: 'Number parameter 1', type: 'number', initial: 5 },
    ];
    const first = addFlowParameter(project, undefined, 'number');
    const second = addFlowParameter(project, undefined, 'number');
    const reference = addParameterReference(project, first.flowId, first.variableId);
    expect(project.flows).toHaveLength(1);
    expect(project.flows[0].name).toBe('New flow 1');
    expect(project.variables.map((variable) => variable.name)).toEqual([
      'Number parameter 1',
      'Number parameter 2',
      'Number parameter 3',
    ]);
    expect(new Set([first.nodeId, second.nodeId, reference.nodeId]).size).toBe(3);
    expect(reference).toMatchObject({ flowId: first.flowId, variableId: first.variableId });
    expect(project.flows[0].nodes.at(-1)!.config.variable).toBe(first.variableId);
    expect(project.flows[0].nodes.at(-1)!.block!.outputs[0].type).toBe('number');
    expect(project.variables).toHaveLength(3);
    updateParameterDefinition(project, first.variableId, { name: 'Renamed' });
    expect(project.variables[1].id).toBe(first.variableId);
    expect(project.flows[0].nodes.find((node) => node.id === first.nodeId)!.config.variable).toBe(
      first.variableId,
    );
    expect(validateProject(project)).toEqual(project);
  });

  it('can reference an existing typed variable before any flow exists', () => {
    const project = unreferenced('boolean');
    const before = structuredClone(project.variables);
    const result = addParameterReference(project, undefined, project.variables[0].id);
    expect(project.variables).toEqual(before);
    expect(project.flows).toHaveLength(1);
    expect(project.flows[0].nodes[1]).toMatchObject({
      id: result.nodeId,
      kind: 'read',
      block: { outputs: [{ type: 'boolean' }] },
    });
  });

  it('rejects missing targets, unsupported types and nonfinite positions without half-created state', () => {
    const project = unreferenced();
    const id = project.variables[0].id;
    for (const change of [
      () => addFlowParameter(project, 'missing', 'number'),
      () => addFlowParameter(project, undefined, 'invalid' as VariableType),
      () => addFlowParameter(project, undefined, 'number', { x: NaN, y: 0 }),
      () => addParameterReference(project, undefined, 'missing'),
      () => addParameterReference(project, 'missing', id),
      () => addParameterReference(project, undefined, id, { x: 0, y: Infinity }),
    ])
      rejectsWithoutMutation(project, change);
  });

  it.each(cases)(
    'executes and exports %s components through the existing block runtime',
    async (type, initial) => {
      const project = createEmptyProject();
      const result = addFlowParameter(project, undefined, type);
      const value: Json =
        type === 'number'
          ? 42
          : type === 'string'
            ? 'hello'
            : type === 'boolean'
              ? true
              : { rows: [1, 'value', null] };
      updateParameterDefinition(project, result.variableId, { initial: value });
      const target: Variable = {
        id: 'target',
        name: 'Target',
        type,
        initial: structuredClone(initial),
      };
      project.variables.push(target);
      const sink: FlowNode = {
        id: 'save',
        kind: 'write',
        label: 'Save',
        position: { x: 300, y: 80 },
        config: { variable: target.id, path: [] },
      };
      sink.block = createBlockInterface(sink, project);
      project.flows[0].nodes.push(sink);
      project.flows[0].edges.push({
        id: 'wire',
        source: result.nodeId,
        target: sink.id,
        sourceHandle: 'data-out:q',
        targetHandle: 'data-in:in',
        kind: 'data',
      });
      project.flows[0].edges.push({
        id: 'execute',
        source: project.flows[0].nodes.find((node) => node.kind === 'event')!.id,
        target: sink.id,
      });
      const exported = importProject(exportProject(project));
      expect(exported).toEqual(project);
      const runtime = new RuntimeController(exported);
      expect(runtime.getSnapshot().values.target.value).toEqual(initial);
      await runtime.runFlow(result.flowId);
      expect(runtime.getSnapshot().values.target.value).toEqual(value);
    },
  );
});

describe('parameter definitions', () => {
  it('preserves metadata and stable IDs, trims names and clones JSON initials', () => {
    const project = unreferenced('json');
    const variable = project.variables[0];
    Object.assign(variable, { unit: 'packet', readOnly: true, persistent: true });
    const initial = { rows: [{ enabled: true }], nullable: null };
    updateParameterDefinition(project, variable.id, { name: '  Packets  ', initial });
    initial.rows[0].enabled = false;
    expect(project.variables[0]).toEqual({
      ...variable,
      name: 'Packets',
      initial: { rows: [{ enabled: true }], nullable: null },
    });
    expect(validateProject(project)).toEqual(project);
  });

  it('keeps existing bindings, flow references and C aliases stable during numeric definition edits', () => {
    const project = unreferenced();
    const variable = project.variables[0];
    Object.assign(variable, {
      unit: 'rpm',
      readOnly: true,
      persistent: true,
      alarm: { min: 0, max: 100 },
    });
    addParameterReference(project, undefined, variable.id);
    const widget = createWidget('number');
    widget.bindings.value = { variable: variable.id, mode: 'oneWay' };
    project.widgets.push(widget);
    project.scripts.push({
      id: 'script',
      name: 'C alias',
      source: 'void qg_process(void) {}',
      timeoutMs: 1000,
      variableAliases: { speed: variable.id },
    });
    const before = structuredClone({
      flows: project.flows,
      widgets: project.widgets,
      scripts: project.scripts,
    });
    updateParameterDefinition(project, variable.id, { name: 'Speed', initial: 75 });
    expect(project.variables[0]).toEqual({ ...variable, name: 'Speed', initial: 75 });
    expect({ flows: project.flows, widgets: project.widgets, scripts: project.scripts }).toEqual(
      before,
    );
    expect(validateProject(project)).toEqual(project);
  });

  it.each(cases)(
    'changes an unreferenced definition to %s using a type-correct default',
    (type, initial) => {
      const project = unreferenced(type === 'number' ? 'string' : 'number');
      const id = project.variables[0].id;
      if (project.variables[0].type === 'number') project.variables[0].alarm = { min: 0, max: 100 };
      updateParameterDefinition(project, id, { type });
      expect(project.variables[0]).toMatchObject({ id, type, initial });
      if (type !== 'number') expect(project.variables[0].alarm).toBeUndefined();
      expect(validateProject(project)).toEqual(project);
    },
  );

  it('validates explicit initial values, metadata and JSON before applying any patch', () => {
    const project = unreferenced();
    const id = project.variables[0].id;
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const patch of [
      { name: '' },
      { name: '   ' },
      { type: 'invalid' },
      { initial: '12' },
      { initial: NaN },
      { initial: Infinity },
      { type: 'boolean', initial: 1 },
      { type: 'json', initial: cyclic },
      { type: 'json', initial: { value: undefined } },
      { type: 'json', initial: new Date() },
      { alarm: { max: Infinity } },
      { persistent: 'true' },
    ])
      rejectsWithoutMutation(project, () =>
        updateParameterDefinition(project, id, patch as Partial<Omit<Variable, 'id'>>),
      );
    rejectsWithoutMutation(project, () =>
      updateParameterDefinition(project, 'missing', { name: 'X' }),
    );
    rejectsWithoutMutation(project, () => deleteParameterDefinition(project, 'missing'));
  });

  it('rejects duplicate names including ID collisions while preserving the original definition', () => {
    const project = unreferenced();
    project.variables.push({ id: 'second_id', name: 'Second', type: 'number', initial: 0 });
    for (const name of [' Second ', 'second_id'])
      rejectsWithoutMutation(project, () =>
        updateParameterDefinition(project, project.variables[0].id, { name }),
      );
  });

  it('protects bound widgets, nested flow references, C aliases and locale variables from destructive edits', () => {
    const attachments: ((project: Project, variable: Variable) => void)[] = [
      (project, variable) => {
        const widget = createWidget('number');
        widget.bindings.value = { variable: variable.id, mode: 'twoWay' };
        project.widgets.push(widget);
      },
      (project, variable) => {
        const widget = createWidget('chart');
        widget.props.series = [{ variableId: variable.id }];
        project.modules.push({
          id: 'module',
          name: 'Module',
          version: '1.0.0',
          width: 300,
          height: 200,
          widgets: [widget],
          exposedProps: {},
        });
      },
      (project, variable) => {
        project.flows.push({
          id: 'flow',
          name: 'Referenced flow',
          enabled: true,
          edges: [],
          nodes: [
            {
              id: 'map',
              kind: 'map',
              label: 'Map',
              position: { x: 0, y: 0 },
              config: {
                operation: 'object',
                fields: { value: { source: 'variable', variable: variable.id, path: [] } },
              },
            },
          ],
        });
      },
      (project, variable) => {
        project.scripts.push({
          id: 'c',
          name: 'C alias',
          source: 'void qg_process(void) {}',
          timeoutMs: 1000,
          variableAliases: { value: variable.id },
        });
      },
      (project, variable) => {
        variable.type = 'string';
        variable.initial = 'en';
        project.resourceScopes = [
          {
            id: 'scope',
            theme: structuredClone(project.theme),
            locale: 'en',
            translations: {},
            localeVariableId: variable.id,
          },
        ];
      },
    ];
    for (const attach of attachments) {
      const project = unreferenced();
      const variable = project.variables[0];
      attach(project, variable);
      rejectsWithoutMutation(
        project,
        () => deleteParameterDefinition(project, variable.id),
        /references/,
      );
      rejectsWithoutMutation(
        project,
        () => updateParameterDefinition(project, variable.id, { type: 'boolean' }),
        /references/,
      );
    }
  });

  it('protects its own read component until the reference is removed, then allows deleting the definition', () => {
    const project = createEmptyProject();
    const result = addFlowParameter(project, undefined, 'number');
    rejectsWithoutMutation(
      project,
      () => deleteParameterDefinition(project, result.variableId),
      /references/,
    );
    rejectsWithoutMutation(
      project,
      () => updateParameterDefinition(project, result.variableId, { type: 'string' }),
      /references/,
    );
    project.flows[0].nodes = project.flows[0].nodes.filter((node) => node.kind === 'event');
    deleteParameterDefinition(project, result.variableId);
    expect(project.variables).toEqual([]);
    expect(validateProject(project)).toEqual(project);
  });

  it('refuses legacy name-reference renames without rewriting bindings or flow configuration', () => {
    for (const reference of ['binding', 'chart', 'flow']) {
      const project = unreferenced();
      const variable = project.variables[0];
      if (reference === 'flow') {
        addParameterReference(project, undefined, variable.id);
        project.flows[0].nodes.find((node) => node.kind === 'read')!.config.variable =
          variable.name;
      } else {
        const widget = createWidget(reference === 'chart' ? 'chart' : 'number');
        if (reference === 'chart') widget.props.series = [{ variableId: variable.name }];
        else widget.bindings.value = { variable: variable.name, mode: 'oneWay' };
        project.widgets.push(widget);
      }
      rejectsWithoutMutation(
        project,
        () => updateParameterDefinition(project, variable.id, { name: 'Renamed', initial: 99 }),
        /stable IDs/,
      );
    }
  });

  it('stores creation and definition edits as single undoable editor changes with rejected edits absent from history', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.useFakeTimers();
    const store = new EditorStore(createEmptyProject());
    try {
      let result!: ReturnType<typeof addFlowParameter>;
      store.update((project) => {
        result = addFlowParameter(project, undefined, 'json');
      });
      expect(store.getSnapshot().past).toHaveLength(1);
      const created = structuredClone(store.getSnapshot().project!);
      store.undo();
      expect(store.getSnapshot().project!.variables).toEqual([]);
      expect(store.getSnapshot().project!.flows).toEqual([]);
      store.redo();
      expect(store.getSnapshot().project!.variables).toEqual(created.variables);
      expect(store.getSnapshot().project!.flows).toEqual(created.flows);
      store.update((project) =>
        updateParameterDefinition(project, result.variableId, {
          initial: { nested: ['saved'] },
          persistent: true,
        }),
      );
      const edited = structuredClone(store.getSnapshot().project!);
      expect(store.getSnapshot().past).toHaveLength(2);
      expect(() =>
        store.update((project) => deleteParameterDefinition(project, result.variableId)),
      ).toThrow(/references/);
      expect(store.getSnapshot().past).toHaveLength(2);
      expect(store.getSnapshot().project).toEqual(edited);
      store.undo();
      expect(store.getSnapshot().project!.variables).toEqual(created.variables);
      store.redo();
      expect(store.getSnapshot().project!.variables).toEqual(edited.variables);
    } finally {
      store.dispose();
    }
  });
});
