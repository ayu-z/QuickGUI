import { z } from 'zod';
import type { Json, Project, Widget } from './types';
import { reactImplementationSchema } from './componentPackage';

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
export const widgetCodeSchema = z
  .object({ props: z.record(json), style, states: z.record(style) })
  .strict()
  .superRefine((value, ctx) => {
    for (const [group, values] of Object.entries({
      style: value.style,
      ...Object.fromEntries(Object.entries(value.states).map(([key, v]) => [`states.${key}`, v])),
    })) {
      for (const [key, val] of Object.entries(values)) {
        if (!styleKeys.has(key))
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
export function parseWidgetCode(raw: string): Pick<Widget, 'props' | 'style' | 'states'> {
  return widgetCodeSchema.parse(JSON.parse(raw));
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
    events: z.record(z.string()),
  })
  .strict();
export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    locale: z.enum(['zh-CN', 'en']),
    theme: z
      .object({ mode: z.enum(['light', 'dark', 'system']), tokens: z.record(z.string()) })
      .strict(),
    window: z
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
      .strict(),
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

export function validateProject(raw: unknown): Project {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const english = input?.locale === 'en';
  if (!input || !Object.hasOwn(input, 'schemaVersion') || input.schemaVersion === undefined) {
    throw new Error(
      english
        ? 'The project is missing schemaVersion. This designer supports schemaVersion 1. The original file has not been modified.'
        : '工程缺少 schemaVersion，当前设计器仅支持 schemaVersion 1。原文件未修改。',
    );
  }
  if (input.schemaVersion !== 1) {
    const version =
      ['string', 'number', 'boolean'].includes(typeof input.schemaVersion) ||
      input.schemaVersion === null
        ? JSON.stringify(input.schemaVersion)
        : '(invalid value)';
    throw new Error(
      english
        ? `Unsupported project schemaVersion ${version}. This designer supports schemaVersion 1. Do not save over the original file. The original file has not been modified.`
        : `不支持工程 schemaVersion ${version}，当前设计器仅支持 schemaVersion 1。请勿保存覆盖原件；原文件未修改。`,
    );
  }
  let project: Project;
  try {
    project = projectSchema.parse(raw) as Project;
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
  if (
    project.window.minWidth > project.window.width ||
    project.window.minHeight > project.window.height
  )
    throw new Error('Window minimum size exceeds its initial size');
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
  for (const variable of project.variables)
    if (typeof variable.initial !== variable.type)
      throw new Error(`Invalid initial type: ${variable.name}`);
  if (new Set(project.variables.map((v) => v.name)).size !== project.variables.length)
    throw new Error('Duplicate variable names');
  for (const id of [project.window.icon, project.publish.icon, project.publish.shortcutIcon])
    if (id && !project.assets.some((a) => a.id === id))
      throw new Error(`Missing icon asset: ${id}`);
  for (const flow of project.flows) validateFlow(flow);
  const checkWidgets = (widgets: Widget[], ancestors: string[] = []) => {
    const ids = new Set(widgets.map((w) => w.id));
    for (const w of widgets) {
      widgetCodeSchema.parse({ props: w.props, style: w.style, states: w.states });
      if (w.parentId && !ids.has(w.parentId)) throw new Error(`Missing parent: ${w.parentId}`);
      let parent = w.parentId;
      const seen = new Set([w.id]);
      while (parent) {
        if (seen.has(parent)) throw new Error('Cyclic parent reference');
        seen.add(parent);
        parent = widgets.find((x) => x.id === parent)?.parentId;
      }
      for (const binding of Object.values(w.bindings))
        if (
          !project.variables.some((v) => v.id === binding.variable || v.name === binding.variable)
        )
          throw new Error(`Missing variable: ${binding.variable}`);
      for (const flowId of Object.values(w.events))
        if (!project.flows.some((f) => f.id === flowId)) throw new Error(`Missing flow: ${flowId}`);
      if (w.type === 'module') {
        const module = project.modules.find((m) => m.id === w.moduleId);
        if (!module) throw new Error(`Missing module: ${w.moduleId}`);
        if (ancestors.includes(module.id)) throw new Error('Cyclic module reference');
        checkWidgets(module.widgets, [...ancestors, module.id]);
      }
    }
  };
  checkWidgets(project.widgets);
  for (const module of project.modules) checkWidgets(module.widgets, [module.id]);
  return project;
}

export function validateFlow(flow: Project['flows'][number]): string[] {
  const ids = new Set(flow.nodes.map((n) => n.id));
  if (ids.size !== flow.nodes.length) throw new Error(`Duplicate node IDs: ${flow.name}`);
  if (new Set(flow.edges.map((e) => e.id)).size !== flow.edges.length)
    throw new Error('Duplicate edge IDs');
  const indegree = new Map(flow.nodes.map((n) => [n.id, 0]));
  for (const e of flow.edges) {
    if (!ids.has(e.source) || !ids.has(e.target))
      throw new Error('Flow edge references a missing node');
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
  if (!flow.nodes.some((node) => node.kind === 'event'))
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
