import { z } from 'zod';
import type { Json, Project, Widget } from './types';
import { reactImplementationSchema } from './componentPackage';
import { assertJsonPath, assertJsonValue, validateJsonPath } from './jsonValue';
import { validatePropertyPatch } from './widgetDefinitions';
import { propertyDefinitionSchema } from './propertySchema';
import { upgradeProject } from './migration';
import { flowBindingId, validFlowBinding } from './flowBindings';
import { LATEST_PROJECT_VERSION } from './types';
import { flowConfigRecordSchema, flowNodePorts, isV4Node, validateV4NodeConfig } from './flowV4';
import {
  blockInterfaceSchema,
  isDataEdge,
  validateBlockInterface,
  validateDataEdges,
} from './functionBlocks';
import {
  listProjectWindows,
  MAIN_WINDOW_ID,
  MAX_ADDITIONAL_WINDOWS,
  WINDOW_ID_PATTERN,
} from './windows';

const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]),
);
const style = z.record(z.union([z.string().max(4096), z.number().finite()]));
const styleKeys = new Set([
  'background',
  'backgroundColor',
  'color',
  'fontSize',
  'fontWeight',
  'fontFamily',
  'textAlign',
  'borderRadius',
  'borderWidth',
  'borderColor',
  'borderStyle',
  'padding',
  'margin',
  'opacity',
  'boxShadow',
  'lineHeight',
  'letterSpacing',
  'alignItems',
  'justifyContent',
  'gap',
]);
const modernStyleKeys = new Set([
  ...styleKeys,
  'fontStyle',
  'textDecoration',
  'whiteSpace',
  'wordBreak',
  'textOverflow',
  'overflow',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'verticalAlign',
  'flexWrap',
  'rowGap',
  'columnGap',
]);
function codeSchema(keys: Set<string>) {
  return z
    .object({ props: z.record(json), style, states: z.record(style) })
    .strict()
    .superRefine((value, ctx) => {
      for (const [group, values] of Object.entries({
        style: value.style,
        ...Object.fromEntries(Object.entries(value.states).map(([key, v]) => [`states.${key}`, v])),
      })) {
        for (const [key, val] of Object.entries(values)) {
          if (!keys.has(key))
            ctx.addIssue({
              code: 'custom',
              message: `Unsupported style property: ${key}`,
              path: [group, key],
            });
          if (typeof val === 'string' && /url\s*\(|expression\s*\(|@import|javascript:/i.test(val))
            ctx.addIssue({
              code: 'custom',
              message: 'External CSS resources are not allowed in inline styles',
              path: [group, key],
            });
        }
      }
    });
}
export const widgetCodeSchema = codeSchema(styleKeys);
export const modernWidgetCodeSchema = codeSchema(modernStyleKeys);
export function parseWidgetCode(
  raw: string,
  widget?: Widget,
  project?: Project,
): Pick<Widget, 'props' | 'style' | 'states'> {
  const parsed = (
    widget?.definitionVersion === 2 ? modernWidgetCodeSchema : widgetCodeSchema
  ).parse(JSON.parse(raw));
  if (widget?.definitionVersion === 2) {
    const issues = validatePropertyPatch(widget, parsed, project);
    if (issues.length)
      throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
  }
  return parsed;
}
const layout = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().positive().max(10000),
    height: z.number().positive().max(10000),
    mode: z.enum(['absolute', 'flex', 'grid']).optional(),
    gap: z.number().nonnegative().optional(),
    columns: z.number().int().min(1).max(100).optional(),
    direction: z.enum(['row', 'column']).optional(),
  })
  .strict();
const widget = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    type: z.enum([
      'panel',
      'text',
      'button',
      'input',
      'number',
      'switch',
      'slider',
      'progress',
      'gauge',
      'chart',
      'image',
      'select',
      'table',
      'module',
    ]),
    parentId: z.string().optional(),
    moduleId: z.string().optional(),
    layout,
    props: z.record(json),
    style,
    states: z.record(style),
    bindings: z.record(
      z.object({ variable: z.string(), mode: z.enum(['oneWay', 'twoWay', 'once']) }).strict(),
    ),
    events: z.record(
      z.union([
        z.string(),
        z.object({ flowId: z.string().min(1), entryNodeId: z.string().min(1) }).strict(),
      ]),
    ),
  })
  .strict();
export const windowConfigSchema = z
  .object({
    title: z.string().max(200),
    width: z.number().min(200).max(10000),
    height: z.number().min(100).max(10000),
    minWidth: z.number().min(0),
    minHeight: z.number().min(0),
    resizable: z.boolean(),
    alwaysOnTop: z.boolean(),
    fullscreen: z.boolean(),
    maximized: z.boolean(),
    center: z.boolean(),
    rememberPosition: z.boolean(),
    background: z.string(),
    contentRadius: z.number().min(0).max(500),
    cornerPreference: z.enum(['system', 'square', 'round', 'small']),
    icon: z.string().optional(),
  })
  .strict();

export const projectWindowSchema = z
  .object({
    id: z
      .string()
      .regex(WINDOW_ID_PATTERN)
      .refine(
        (id) => id !== MAIN_WINDOW_ID && id.trim() === id,
        'Additional window ID must be safe ASCII and cannot be main',
      ),
    name: z
      .string()
      .min(1)
      .max(200)
      .refine((name) => name.trim().length > 0, 'Window name cannot be blank'),
    config: windowConfigSchema,
    widgets: z.array(widget).max(10000),
    openOnStart: z.boolean(),
  })
  .strict();

const projectBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    locale: z.enum(['zh-CN', 'en']),
    theme: z
      .object({ mode: z.enum(['light', 'dark', 'system']), tokens: z.record(z.string()) })
      .strict(),
    window: windowConfigSchema,
    publish: z
      .object({
        appName: z.string().min(1).max(100),
        identifier: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+$/),
        version: z.string().regex(/^\d+\.\d+\.\d+([+-][\w.-]+)?$/),
        publisher: z.string(),
        icon: z.string().optional(),
        shortcutIcon: z.string().optional(),
        desktopShortcut: z.boolean(),
      })
      .strict(),
    widgets: z.array(widget).max(10000),
    variables: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          type: z.enum(['number', 'string', 'boolean']),
          initial: z.union([z.string(), z.number().finite(), z.boolean()]),
          unit: z.string().optional(),
          readOnly: z.boolean().optional(),
          persistent: z.boolean().optional(),
          alarm: z
            .object({ min: z.number().optional(), max: z.number().optional() })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    flows: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string(),
          enabled: z.boolean(),
          nodes: z.array(
            z
              .object({
                id: z.string(),
                kind: z.enum([
                  'event',
                  'read',
                  'write',
                  'condition',
                  'math',
                  'delay',
                  'log',
                  'script',
                  'http',
                  'emit',
                  'connection',
                  'window',
                ]),
                label: z.string(),
                position: z.object({ x: z.number(), y: z.number() }).strict(),
                config: z.record(json),
              })
              .strict(),
          ),
          edges: z.array(
            z
              .object({
                id: z.string(),
                source: z.string(),
                target: z.string(),
                sourceHandle: z.string().optional(),
                targetHandle: z.string().optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    scripts: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          source: z.string().max(2000000),
          timeoutMs: z.number().int().min(1).max(30000),
        })
        .strict(),
    ),
    modules: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          version: z.string(),
          width: z.number().positive(),
          height: z.number().positive(),
          widgets: z.array(widget),
          exposedProps: z.record(
            z.object({ widgetId: z.string(), property: z.string(), default: json }).strict(),
          ),
          implementation: reactImplementationSchema.optional(),
        })
        .strict(),
    ),
    assets: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          mime: z.string(),
          data: z
            .string()
            .max(20_000_000)
            .refine(
              (s) =>
                /^data:image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd.microsoft.icon);base64,/.test(
                  s,
                ),
              'Image must be a local image data URL',
            ),
        })
        .strict(),
    ),
    connections: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          protocol: z.enum(['http', 'websocket', 'mqtt', 'serial', 'tcp']),
          config: z.record(json),
        })
        .strict(),
    ),
    translations: z.record(z.record(z.string())).optional(),
  })
  .strict();

const pathSchema = z
  .array(z.union([z.string(), z.number().int().nonnegative()]))
  .max(32)
  .superRefine((path, ctx) => {
    try {
      assertJsonPath(path);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: String(e) });
    }
  });
const modernWidget = widget
  .extend({
    definitionVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    editor: z
      .object({ locked: z.boolean().optional(), hidden: z.boolean().optional() })
      .strict()
      .optional(),
    resourceScopeId: z.string().min(1).optional(),
    layout: layout
      .extend({
        wrap: z.boolean().optional(),
        alignItems: z.string().optional(),
        justifyContent: z.string().optional(),
        rowGap: z.number().nonnegative().optional(),
        columnGap: z.number().nonnegative().optional(),
      })
      .strict(),
    bindings: z.record(
      z
        .object({
          variable: z.string(),
          mode: z.enum(['oneWay', 'twoWay', 'once']),
          path: pathSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();
const resourceScopeSchema = z
  .object({
    id: z.string().min(1),
    theme: projectBaseSchema.shape.theme,
    translations: z.record(z.record(z.string())),
    locale: z.enum(['zh-CN', 'en']),
    localeVariableId: z.string().optional(),
    assetAliases: z.record(z.string()).optional(),
    assets: z.array(projectBaseSchema.shape.assets.element).optional(),
  })
  .strict();
const modernProject = projectBaseSchema
  .extend({
    schemaVersion: z.literal(3),
    windows: z
      .array(projectWindowSchema.extend({ widgets: z.array(modernWidget).max(10000) }).strict())
      .max(MAX_ADDITIONAL_WINDOWS),
    widgets: z.array(modernWidget).max(10000),
    variables: z.array(
      projectBaseSchema.shape.variables.element
        .extend({ type: z.enum(['number', 'string', 'boolean', 'json']), initial: json })
        .strict(),
    ),
    scripts: z.array(
      projectBaseSchema.shape.scripts.element
        .extend({ variableAliases: z.record(z.string().min(1)).optional() })
        .strict(),
    ),
    modules: z.array(
      projectBaseSchema.shape.modules.element
        .extend({
          widgets: z.array(modernWidget),
          packageIdentity: z
            .object({
              id: z.string(),
              name: z.string(),
              version: z.string(),
              width: z.number().positive(),
              height: z.number().positive(),
            })
            .strict()
            .optional(),
          propertyDefinitions: z.record(propertyDefinitionSchema).optional(),
          resourceScopeId: z.string().optional(),
          embeddedResourceScope: resourceScopeSchema.optional(),
        })
        .strict(),
    ),
    resourceScopes: z.array(resourceScopeSchema).max(1000).optional(),
  })
  .strict();
const flowV4Schema = projectBaseSchema.shape.flows.element
  .extend({
    nodes: z.array(
      projectBaseSchema.shape.flows.element.shape.nodes.element
        .extend({
          kind: z.enum([
            'event',
            'read',
            'write',
            'condition',
            'math',
            'delay',
            'log',
            'script',
            'http',
            'emit',
            'connection',
            'window',
            'map',
            'append',
            'serial',
            'usb',
          ]),
          config: flowConfigRecordSchema,
        })
        .strict(),
    ),
  })
  .strict();
export const projectSchema = modernProject
  .extend({
    schemaVersion: z.literal(LATEST_PROJECT_VERSION),
    flows: z.array(
      flowV4Schema
        .extend({
          nodes: z.array(
            flowV4Schema.shape.nodes.element
              .extend({ block: blockInterfaceSchema.optional() })
              .strict(),
          ),
          edges: z.array(
            projectBaseSchema.shape.flows.element.shape.edges.element
              .extend({ kind: z.literal('data').optional() })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export function validateProject(raw: unknown): Project {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const english = input?.locale === 'en';
  if (!input || !Object.hasOwn(input, 'schemaVersion') || input.schemaVersion === undefined) {
    throw new Error(
      english
        ? 'The project is missing schemaVersion. The current schemaVersion is 5. The original file has not been modified.'
        : '工程缺少 schemaVersion，当前工程版本为 5。原文件未修改。',
    );
  }
  if (
    input.schemaVersion !== 1 &&
    input.schemaVersion !== 2 &&
    input.schemaVersion !== 3 &&
    input.schemaVersion !== 4 &&
    input.schemaVersion !== 5
  ) {
    const version =
      ['string', 'number', 'boolean'].includes(typeof input.schemaVersion) ||
      input.schemaVersion === null
        ? JSON.stringify(input.schemaVersion)
        : '(invalid value)';
    throw new Error(
      english
        ? `Unsupported project schemaVersion ${version}. The current schemaVersion is 5; known older documents are automatically upgraded. Do not save over the original file. The original file has not been modified.`
        : `不支持工程 schemaVersion ${version}，当前工程版本为 5，已知旧文档会自动升级。请勿保存覆盖原件；原文件未修改。`,
    );
  }
  let project: Project;
  try {
    const normalized = {
      ...input,
      schemaVersion: LATEST_PROJECT_VERSION,
      ...(input.schemaVersion !== LATEST_PROJECT_VERSION && input.windows === undefined
        ? { windows: [] }
        : {}),
    };
    project = upgradeProject(projectSchema.parse(normalized) as Project);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const paths = error.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) =>
              [...issue.path, key].reduce<string>(
                (path, part) =>
                  typeof part === 'number'
                    ? `${path}[${part}]`
                    : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)
                      ? `${path}.${part}`
                      : `${path}[${JSON.stringify(part)}]`,
                '$',
              ),
            )
          : [],
      );
      if (paths.length)
        throw new Error(
          english
            ? `This designer does not recognize project fields: ${paths.join(', ')}. The project may have been created by a newer designer. Do not save over the original file. The original file has not been modified.`
            : `当前设计器不支持以下工程字段：${paths.join('、')}。该工程可能由较新版本的设计器创建，请勿保存覆盖原件；原文件未修改。`,
        );
    }
    throw error;
  }
  const windows = listProjectWindows(project);
  const windowIds = new Set(windows.map((window) => window.id));
  if (windowIds.size !== windows.length) throw new Error('Duplicate window IDs');
  for (const window of windows) {
    if (
      window.config.minWidth > window.config.width ||
      window.config.minHeight > window.config.height
    )
      throw new Error(`Window minimum size exceeds its initial size: ${window.id}`);
  }
  const sceneWidgets = windows.flatMap((window) => window.widgets);
  if (new Set(sceneWidgets.map((widget) => widget.id)).size !== sceneWidgets.length)
    throw new Error('Duplicate widget IDs: IDs must be unique across all project windows');
  for (const list of [
    project.widgets,
    project.variables,
    project.flows,
    project.scripts,
    project.modules,
    project.assets,
    project.connections,
  ]) {
    if (new Set(list.map((item) => item.id)).size !== list.length)
      throw new Error('Duplicate object IDs');
  }
  for (const variable of project.variables) {
    if (variable.type === 'json') {
      assertJsonValue(variable.initial);
      if (variable.alarm) throw new Error('JSON variables cannot have numeric alarms');
    } else if (typeof variable.initial !== variable.type)
      throw new Error(`Invalid initial type: ${variable.name}`);
  }
  const scopes = new Set((project.resourceScopes ?? []).map((scope) => scope.id));
  if (scopes.size !== (project.resourceScopes?.length ?? 0))
    throw new Error('Duplicate resource scope IDs');
  for (const scope of project.resourceScopes ?? [])
    if (
      scope.localeVariableId &&
      !project.variables.some(
        (variable) => variable.id === scope.localeVariableId && variable.type === 'string',
      )
    )
      throw new Error(`Missing locale variable: ${scope.localeVariableId}`);
  for (const script of project.scripts)
    for (const target of Object.values(script.variableAliases ?? {}))
      if (
        !project.variables.some((variable) => variable.id === target && variable.type === 'number')
      )
        throw new Error(`Invalid script variable alias target: ${target}`);
  if (new Set(project.variables.map((v) => v.name)).size !== project.variables.length)
    throw new Error('Duplicate variable names');
  for (const id of [
    ...windows.map((window) => window.config.icon),
    project.publish.icon,
    project.publish.shortcutIcon,
  ])
    if (id && !project.assets.some((a) => a.id === id))
      throw new Error(`Missing icon asset: ${id}`);
  for (const flow of project.flows) {
    validateFlow(flow, project.schemaVersion);
    for (const node of flow.nodes) {
      if (isV4Node(node)) {
        validateV4NodeConfig(node, project);
      }
      if (node.config.path === undefined) continue;
      const path = node.config.path;
      validateJsonPath(path);
      if (['read', 'write'].includes(node.kind) && path.length > 0) {
        const variable =
          project.variables.find((entry) => entry.id === node.config.variable) ??
          project.variables.find((entry) => entry.name === node.config.variable);
        if (!variable || variable.type !== 'json')
          throw new Error(`JSON paths require a json variable: ${node.id}`);
      }
    }
    for (const node of flow.nodes.filter((node) => node.kind === 'window')) {
      const { action, windowId } = node.config;
      if (typeof action !== 'string' || !['open', 'close', 'focus'].includes(action))
        throw new Error(`Invalid window action: ${node.id}`);
      if (typeof windowId !== 'string' || !windowIds.has(windowId))
        throw new Error(`Missing window target: ${String(windowId)}`);
      if (action === 'close' && windowId === MAIN_WINDOW_ID)
        throw new Error('Window flow nodes cannot close the main window');
    }
  }
  const variableIds = new Set(
    project.variables.flatMap((variable) => [variable.id, variable.name]),
  );
  const flowIds = new Set(project.flows.map((flow) => flow.id));
  const modules = new Map(project.modules.map((module) => [module.id, module]));
  const checkWidgets = (widgets: Widget[]) => {
    const ids = new Set(widgets.map((w) => w.id));
    if (ids.size !== widgets.length) throw new Error('Duplicate widget IDs within a module');
    const byId = new Map(widgets.map((widget) => [widget.id, widget]));
    for (const w of widgets) {
      (w.definitionVersion === 2 ? modernWidgetCodeSchema : widgetCodeSchema).parse({
        props: w.props,
        style: w.style,
        states: w.states,
      });
      if (w.resourceScopeId && !scopes.has(w.resourceScopeId))
        throw new Error(`Missing resource scope: ${w.resourceScopeId}`);
      if (w.type === 'module' && !modules.has(w.moduleId ?? ''))
        throw new Error(`Missing module: ${w.moduleId}`);
      for (const binding of Object.values(w.bindings))
        if (!variableIds.has(binding.variable))
          throw new Error(`Missing variable: ${binding.variable}`);
      {
        const issues = validatePropertyPatch(
          w,
          { props: w.props, style: w.style, states: w.states, bindings: w.bindings },
          project,
        );
        if (issues.length)
          throw new Error(
            issues.map((issue) => `${w.id}.${issue.path}: ${issue.message}`).join('\n'),
          );
      }
      if (w.parentId && !ids.has(w.parentId)) throw new Error(`Missing parent: ${w.parentId}`);
      for (const binding of Object.values(w.bindings)) {
        if (!variableIds.has(binding.variable))
          throw new Error(`Missing variable: ${binding.variable}`);
        if (binding.path?.length) {
          const variable =
            project.variables.find((entry) => entry.id === binding.variable) ??
            project.variables.find((entry) => entry.name === binding.variable);
          if (variable?.type !== 'json')
            throw new Error(`JSON paths require a json variable: ${w.id}`);
        }
      }
      for (const binding of Object.values(w.events)) {
        if (!flowIds.has(flowBindingId(binding)))
          throw new Error(`Missing flow: ${flowBindingId(binding)}`);
        if (!validFlowBinding(binding, project.flows))
          throw new Error(`Missing or ambiguous manual event entry: ${w.id}`);
      }
      if (w.type === 'module') {
        if (w.moduleId === undefined || !modules.has(w.moduleId))
          throw new Error(`Missing module: ${w.moduleId}`);
      }
    }
    const complete = new Set<string>();
    for (const widget of widgets) {
      let cursor: string | undefined = widget.id;
      const visiting = new Set<string>();
      while (cursor && !complete.has(cursor)) {
        if (visiting.has(cursor)) throw new Error('Cyclic parent reference');
        visiting.add(cursor);
        cursor = byId.get(cursor)?.parentId;
      }
      for (const id of visiting) complete.add(id);
    }
  };
  for (const window of windows) checkWidgets(window.widgets);
  const indegree = new Map(project.modules.map((module) => [module.id, 0]));
  const moduleEdges = new Map<string, string[]>();
  for (const module of project.modules) {
    if (module.resourceScopeId && !scopes.has(module.resourceScopeId))
      throw new Error(`Missing resource scope: ${module.resourceScopeId}`);
    checkWidgets(module.widgets);
    const ids = new Set(module.widgets.map((widget) => widget.id));
    for (const property of Object.values(module.exposedProps)) {
      const valid =
        module.implementation?.kind === 'react'
          ? property.widgetId === '$component'
          : ids.has(property.widgetId);
      if (!valid)
        throw new Error(
          `Missing exposed widget target in module ${module.id}: ${property.widgetId}`,
        );
    }
    const children = module.widgets
      .filter((widget) => widget.type === 'module')
      .map((widget) => widget.moduleId!);
    moduleEdges.set(module.id, children);
    for (const child of children) indegree.set(child, indegree.get(child)! + 1);
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    visited++;
    for (const child of moduleEdges.get(queue[index]) ?? []) {
      const degree = indegree.get(child)! - 1;
      indegree.set(child, degree);
      if (degree === 0) queue.push(child);
    }
  }
  if (visited !== modules.size) throw new Error('Cyclic module reference');
  return project;
}

export function validateFlow(
  flow: Project['flows'][number],
  _schemaVersion?: Project['schemaVersion'],
): string[] {
  const ids = new Set(flow.nodes.map((n) => n.id));
  if (ids.size !== flow.nodes.length) throw new Error(`Duplicate node IDs: ${flow.name}`);
  if (new Set(flow.edges.map((e) => e.id)).size !== flow.edges.length)
    throw new Error('Duplicate edge IDs');
  const indegree = new Map(flow.nodes.map((n) => [n.id, 0]));
  for (const node of flow.nodes) {
    validateBlockInterface(node);
  }
  validateDataEdges(flow);
  for (const e of flow.edges) {
    if (!ids.has(e.source) || !ids.has(e.target))
      throw new Error('Flow edge references a missing node');
    if (!isDataEdge(e)) {
      const source = flow.nodes.find((node) => node.id === e.source)!,
        target = flow.nodes.find((node) => node.id === e.target)!;
      const ports = flowNodePorts(source);
      if (!ports.outputs.includes(e.sourceHandle ?? ports.defaultOutput))
        throw new Error(`Unsupported source port on ${source.id}: ${e.sourceHandle}`);
      if (!flowNodePorts(target).inputs.includes(e.targetHandle ?? 'input'))
        throw new Error(`Unsupported target port on ${target.id}: ${e.targetHandle ?? 'input'}`);
    }
    indegree.set(e.target, indegree.get(e.target)! + 1);
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of flow.edges.filter((e) => e.source === id)) {
      const degree = indegree.get(e.target)! - 1;
      indegree.set(e.target, degree);
      if (degree === 0) queue.push(e.target);
    }
  }
  if (order.length !== flow.nodes.length) throw new Error(`Flow contains a cycle: ${flow.name}`);
  if (
    !flow.nodes.some(
      (node) =>
        node.kind === 'event' ||
        (['serial', 'usb'].includes(node.kind) && node.config.action === 'communicate'),
    )
  )
    throw new Error('Flow needs an event entry node');
  if (
    flow.edges.some((edge) => flow.nodes.find((node) => node.id === edge.target)?.kind === 'event')
  )
    throw new Error('Event nodes cannot have incoming edges');
  return order;
}

export function errorText(error: unknown): string {
  return error instanceof z.ZodError
    ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
    : error instanceof Error
      ? error.message
      : String(error);
}
