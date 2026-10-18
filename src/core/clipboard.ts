import { z } from 'zod';
import type {
  Asset,
  ComponentModule,
  Connection,
  Flow,
  Json,
  Project,
  ProjectWindow,
  ResourceScope,
  Widget,
} from './types';
import { projectSchema, validateProject } from './validation';
import { upgradeProject } from './migration';
import { listProjectWindows } from './windows';
import {
  getJsonPath,
  getWidgetDefinition,
  propertyPath,
  setProperty,
  type PropertyDefinition,
} from './widgetDefinitions';
import * as native from '../native/bridge';

export type EditScope = { kind: 'window' | 'module'; id: string };
export type Point = { x: number; y: number };
export type DependencyKind =
  | 'variables'
  | 'flows'
  | 'scripts'
  | 'modules'
  | 'assets'
  | 'connections'
  | 'windows'
  | 'resourceScopes';
export interface ClipboardBundle {
  format: 'quickgui-clipboard';
  version: 1;
  source: {
    projectId: string;
    projectName: string;
    schemaVersion: 1 | 2 | 3;
    scope: EditScope;
    windowId: string;
    sessionKey?: string;
  };
  rootIds: string[];
  widgets: Widget[];
  variables: Project['variables'];
  flows: Flow[];
  scripts: Project['scripts'];
  modules: ComponentModule[];
  assets: Asset[];
  connections: Connection[];
  windows: ProjectWindow[];
  resourceScopes: ResourceScope[];
  defaultResourceScope: ResourceScope;
  warnings: string[];
}
export interface PasteOptions {
  sameDocument?: boolean;
  sessionKey?: string;
  currentWindowId?: string;
  useTargetTheme?: boolean;
  reuse?: Partial<Record<DependencyKind, Record<string, string>>>;
  /** Source IDs to explicitly restore after the preview reports the original flags. */
  enableFlows?: string[];
  openWindows?: string[];
  previousMappings?: PasteMappings;
}
export type PasteMappings = Record<DependencyKind, Record<string, string>> & {
  widgets: Record<string, string>;
  moduleWidgets: Record<string, Record<string, string>>;
  windowWidgets: Record<string, Record<string, string>>;
  nodes: Record<string, Record<string, string>>;
  edges: Record<string, Record<string, string>>;
  reserved: Record<string, string>;
};
export interface PastePlan {
  candidate: Project;
  rootIds: string[];
  summary: string[];
  warnings: string[];
  codeTrustRequired: boolean;
  mappings: PasteMappings;
  baseFingerprint: string;
}
const MAX_CLIPBOARD_BYTES = 30 * 1024 * 1024;
const dependencyKinds: DependencyKind[] = [
  'variables',
  'flows',
  'scripts',
  'modules',
  'assets',
  'connections',
  'windows',
  'resourceScopes',
];
const shape = projectSchema.options[2].shape;
const scopeSchema = z
  .object({ kind: z.enum(['window', 'module']), id: z.string().min(1) })
  .strict();
const bundleSchema = z
  .object({
    format: z.literal('quickgui-clipboard'),
    version: z.literal(1),
    source: z
      .object({
        projectId: z.string(),
        projectName: z.string(),
        schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        scope: scopeSchema,
        windowId: z.string().min(1),
        sessionKey: z.string().optional(),
      })
      .strict(),
    rootIds: z.array(z.string().min(1)).min(1).max(10000),
    widgets: shape.widgets,
    variables: shape.variables,
    flows: shape.flows,
    scripts: shape.scripts,
    modules: shape.modules,
    assets: shape.assets,
    connections: shape.connections,
    windows: shape.windows,
    resourceScopes: shape.resourceScopes.unwrap(),
    defaultResourceScope: shape.resourceScopes.unwrap().element,
    warnings: z.array(z.string().max(4096)).max(10000),
  })
  .strict();

function clone<T>(value: T): T {
  return structuredClone(value);
}
const record = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const own = <T>(value: Record<string, T> | undefined, key: string): T | undefined =>
  value && Object.hasOwn(value, key) ? value[key] : undefined;
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${fingerprint((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
function assertSize(text: string) {
  if (new TextEncoder().encode(text).length > MAX_CLIPBOARD_BYTES)
    throw new Error('Clipboard payload exceeds 30 MiB');
}
function newId(prefix: string, used: Set<string>): string {
  let id: string;
  do {
    id = `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
  } while (used.has(id));
  used.add(id);
  return id;
}
function newName(name: string, used: Set<string>): string {
  const base = `${name.slice(0, 170) || 'Unnamed'} (copy)`;
  let candidate = base,
    n = 2;
  while (used.has(candidate)) candidate = `${base} ${n++}`;
  used.add(candidate);
  return candidate;
}
function widgetsIn(project: Project, scope: EditScope): Widget[] {
  const result =
    scope.kind === 'window'
      ? listProjectWindows(project).find((w) => w.id === scope.id)?.widgets
      : project.modules.find((m) => m.id === scope.id)?.widgets;
  if (!result) throw new Error(`Unknown ${scope.kind} editing scope: ${scope.id}`);
  return result;
}
function resolveVariable(project: Pick<Project, 'variables'>, key: string) {
  const result =
    project.variables.find((v) => v.id === key) ?? project.variables.find((v) => v.name === key);
  if (!result) throw new Error(`Missing variable dependency: ${key}`);
  return result;
}
function refKind(reference: PropertyDefinition['reference']): DependencyKind | undefined {
  return reference === 'asset'
    ? 'assets'
    : reference === 'variable'
      ? 'variables'
      : reference === 'module'
        ? 'modules'
        : undefined;
}
function referenceProperties(widget: Widget, modules: ComponentModule[]) {
  return getWidgetDefinition(
    widget.type,
    widget.definitionVersion ?? 1,
    modules.find((m) => m.id === widget.moduleId),
  ).properties.filter((definition) => definition.reference);
}
function moduleDefaultDefinition(
  module: ComponentModule,
  key: string,
  modules: ComponentModule[],
): PropertyDefinition | undefined {
  if (module.propertyDefinitions?.[key]) return module.propertyDefinitions[key];
  const exposed = module.exposedProps[key];
  const widget = module.widgets.find((w) => w.id === exposed.widgetId);
  return widget
    ? getWidgetDefinition(
        widget.type,
        widget.definitionVersion ?? 1,
        modules.find((m) => m.id === widget.moduleId),
      ).properties.find((p) => p.key === exposed.property)
    : undefined;
}
const sensitive = (key: string) => /password|token|secret|authorization|api[-_]?key/i.test(key);
function sanitizeConnection(connection: Connection, warnings: string[]): Connection {
  const sanitize = (value: Json, path: string): Json => {
    if (Array.isArray(value)) return value.map((item, i) => sanitize(item, `${path}[${i}]`));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          if (sensitive(key)) {
            warnings.push(`Removed credential field: ${path}.${key}`);
            return [];
          }
          return [[key, sanitize(item, `${path}.${key}`)]];
        }),
      );
    if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
      let next = value.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/, '$1');
      if (next !== value) warnings.push(`Removed URL credentials: ${path}`);
      try {
        const url = new URL(next);
        let changed = false;
        for (const key of [...url.searchParams.keys()])
          if (sensitive(key)) {
            url.searchParams.delete(key);
            warnings.push(`Removed URL credential parameter: ${path}.${key}`);
            changed = true;
          }
        if (changed) next = url.toString();
      } catch {
        /* Keep nonstandard transport addresses, after userinfo removal. */
      }
      return next;
    }
    return value;
  };
  return {
    ...clone(connection),
    config: sanitize(
      connection.config,
      `connection.${connection.id}.config`,
    ) as Connection['config'],
  };
}

export function copySelection(
  project: Project,
  scope: EditScope,
  ids: string[],
  sessionKey?: string,
  positions?: Record<string, Point>,
): ClipboardBundle {
  validateProject(project);
  const source = clone(project);
  // Package-local assets retain their bytes, but get canonical source-copy IDs
  // before the normal cross-document mapping. No source project is changed.
  const sourceAssetIds = new Set(source.assets.map((asset) => asset.id));
  const normalizeResources = (resources: ResourceScope) => {
    if (!resources.assets?.length) return;
    const local = record<string>();
    for (const asset of resources.assets) {
      if (Object.hasOwn(local, asset.id)) continue;
      const id = newId('embedded_asset', sourceAssetIds);
      local[asset.id] = id;
      source.assets.push({ ...clone(asset), id });
    }
    resources.assetAliases = {
      ...Object.fromEntries(
        Object.entries(resources.assetAliases ?? {}).map(([alias, id]) => [alias, local[id] ?? id]),
      ),
      ...local,
    };
    delete resources.assets;
  };
  for (const resources of source.resourceScopes ?? []) normalizeResources(resources);
  for (const module of source.modules)
    if (module.embeddedResourceScope) normalizeResources(module.embeddedResourceScope);
  const scene = widgetsIn(source, scope),
    byId = new Map(scene.map((widget) => [widget.id, widget]));
  const selected = new Set(ids);
  if (!selected.size) throw new Error('No widgets selected');
  for (const id of selected) if (!byId.has(id)) throw new Error(`Unknown selected widget: ${id}`);
  const rootIds = scene
    .filter((widget) => selected.has(widget.id) && !hasSelectedAncestor(widget))
    .map((widget) => widget.id);
  function hasSelectedAncestor(widget: Widget) {
    let parent = widget.parentId;
    while (parent) {
      if (selected.has(parent)) return true;
      parent = byId.get(parent)?.parentId;
    }
    return false;
  }
  const included = new Set(rootIds);
  for (let changed = true; changed;) {
    changed = false;
    for (const widget of scene)
      if (widget.parentId && included.has(widget.parentId) && !included.has(widget.id)) {
        included.add(widget.id);
        changed = true;
      }
  }
  const widgets = clone(scene.filter((widget) => included.has(widget.id)));
  let inheritedModuleScope: string | undefined;
  if (scope.kind === 'module') {
    const module = source.modules.find((m) => m.id === scope.id)!;
    inheritedModuleScope = module.resourceScopeId;
    if (!inheritedModuleScope && module.embeddedResourceScope) {
      inheritedModuleScope = newId(
        'embedded_resources',
        new Set((source.resourceScopes ?? []).map((r) => r.id)),
      );
      (source.resourceScopes ??= []).push({
        ...clone(module.embeddedResourceScope),
        id: inheritedModuleScope,
      });
    }
  }
  for (const widget of widgets.filter((widget) => rootIds.includes(widget.id))) {
    if (!widget.resourceScopeId) {
      let parent = widget.parentId;
      while (parent && !widget.resourceScopeId) {
        const ancestor = byId.get(parent)!;
        widget.resourceScopeId = ancestor.resourceScopeId;
        parent = ancestor.parentId;
      }
      widget.resourceScopeId ??= inheritedModuleScope;
      if (widget.resourceScopeId === undefined) delete widget.resourceScopeId;
    }
    let point = positions?.[widget.id];
    if (!point) {
      point = { x: widget.layout.x, y: widget.layout.y };
      let parent = widget.parentId;
      while (parent) {
        const ancestor = byId.get(parent)!;
        point.x += ancestor.layout.x;
        point.y += ancestor.layout.y;
        parent = ancestor.parentId;
      }
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
      throw new Error('Widget copy positions must be finite');
    widget.layout.x = point.x;
    widget.layout.y = point.y;
    delete widget.parentId;
  }
  const windows = listProjectWindows(source);
  const sourceWindowId = scope.kind === 'window' ? scope.id : 'main';
  const needed = Object.fromEntries(
    dependencyKinds.map((kind) => [kind, new Set<string>()]),
  ) as Record<DependencyKind, Set<string>>;
  const pending: Array<[DependencyKind, string]> = [];
  const warnings: string[] = [];
  const add = (kind: DependencyKind, key: string) => {
    if (!key) return;
    const id = kind === 'variables' ? resolveVariable(source, key).id : key;
    if (kind === 'windows' && id === sourceWindowId) return;
    if (!needed[kind].has(id)) {
      needed[kind].add(id);
      pending.push([kind, id]);
    }
  };
  const assetId = (key: string, resources?: ResourceScope) =>
    own(resources?.assetAliases, key) ?? key;
  const scanWidget = (widget: Widget, inherited?: ResourceScope) => {
    const module = source.modules.find((m) => m.id === widget.moduleId);
    const resources =
      source.resourceScopes?.find((r) => r.id === widget.resourceScopeId) ??
      inherited ??
      source.resourceScopes?.find((r) => r.id === module?.resourceScopeId) ??
      module?.embeddedResourceScope;
    for (const binding of Object.values(widget.bindings)) add('variables', binding.variable);
    for (const id of Object.values(widget.events)) add('flows', id);
    if (widget.moduleId) add('modules', widget.moduleId);
    if (widget.resourceScopeId) add('resourceScopes', widget.resourceScopeId);
    for (const definition of referenceProperties(widget, source.modules)) {
      const value = getJsonPath(widget.props, propertyPath(definition.key, widget.props));
      if (typeof value === 'string' && value)
        add(
          refKind(definition.reference)!,
          definition.reference === 'asset' ? assetId(value, resources) : value,
        );
    }
    // Built-in reference fields also remain recognized on legacy widgets.
    for (const key of widget.type === 'button'
      ? ['iconAssetId']
      : widget.type === 'image'
        ? ['assetId']
        : []) {
      const value = widget.props[key];
      if (typeof value === 'string' && value) add('assets', assetId(value, resources));
    }
    if (widget.type === 'chart' && Array.isArray(widget.props.series))
      for (const series of widget.props.series) {
        if (
          series &&
          typeof series === 'object' &&
          !Array.isArray(series) &&
          typeof series.variableId === 'string' &&
          series.variableId
        )
          add('variables', series.variableId);
      }
  };
  const scanWidgets = (items: Widget[], inherited?: ResourceScope) => {
    for (const widget of items) {
      let resources = inherited,
        current: Widget | undefined = widget;
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        if (current.resourceScopeId) {
          resources = source.resourceScopes?.find((r) => r.id === current!.resourceScopeId);
          break;
        }
        current = items.find((item) => item.id === current!.parentId);
      }
      scanWidget(widget, resources);
    }
  };
  scanWidgets(widgets);
  if (scope.kind === 'module') {
    const module = source.modules.find((m) => m.id === scope.id)!;
    if (module.resourceScopeId) add('resourceScopes', module.resourceScopeId);
  }
  const defaultResources: ResourceScope = {
    id: newId('source_resources', new Set((source.resourceScopes ?? []).map((s) => s.id))),
    theme: clone(source.theme),
    translations: clone(source.translations ?? {}),
    locale: source.locale,
  };
  if (defaultResources.localeVariableId) add('variables', defaultResources.localeVariableId);
  const find = (kind: DependencyKind, id: string): { id: string } => {
    const values = kind === 'windows' ? windows : (source[kind] ?? []);
    const value = values.find((value) => value.id === id);
    if (!value) throw new Error(`Missing ${kind} dependency: ${id}`);
    return value;
  };
  while (true) {
    while (pending.length) {
      const [kind, id] = pending.shift()!;
      const item = find(kind, id);
      if (kind === 'flows')
        for (const node of (item as Flow).nodes) {
          const c = node.config;
          if ((node.kind === 'read' || node.kind === 'write') && typeof c.variable === 'string')
            add('variables', c.variable);
          if (node.kind === 'script' && typeof c.scriptId === 'string') add('scripts', c.scriptId);
          if (node.kind === 'connection' && typeof c.connectionId === 'string')
            add('connections', c.connectionId);
          if (node.kind === 'window' && typeof c.windowId === 'string') add('windows', c.windowId);
        }
      else if (kind === 'scripts') {
        const script = item as Project['scripts'][number];
        if (script.variableAliases === undefined)
          for (const variable of source.variables.filter((v) => v.type === 'number'))
            add('variables', variable.id);
        else for (const target of Object.values(script.variableAliases)) add('variables', target);
      } else if (kind === 'modules') {
        const module = item as ComponentModule;
        const resources =
          source.resourceScopes?.find((r) => r.id === module.resourceScopeId) ??
          module.embeddedResourceScope;
        scanWidgets(module.widgets, resources);
        if (module.resourceScopeId) add('resourceScopes', module.resourceScopeId);
        if (module.embeddedResourceScope?.localeVariableId)
          add('variables', module.embeddedResourceScope.localeVariableId);
        for (const id of Object.values(module.embeddedResourceScope?.assetAliases ?? {}))
          add('assets', id);
        for (const [key, property] of Object.entries(module.exposedProps)) {
          const definition = moduleDefaultDefinition(module, key, source.modules),
            kind = refKind(definition?.reference);
          if (kind && typeof property.default === 'string' && property.default)
            add(kind, kind === 'assets' ? assetId(property.default, resources) : property.default);
        }
        for (const definition of Object.values(module.propertyDefinitions ?? {})) {
          const kind = refKind(definition.reference);
          if (kind)
            for (const value of [definition.initialValue, definition.fallbackValue])
              if (typeof value === 'string' && value)
                add(kind, kind === 'assets' ? assetId(value, resources) : value);
        }
      } else if (kind === 'windows') {
        const window = item as ProjectWindow;
        scanWidgets(window.widgets);
        if (window.config.icon) add('assets', window.config.icon);
      } else if (kind === 'resourceScopes') {
        const resources = item as ResourceScope;
        if (resources.localeVariableId) add('variables', resources.localeVariableId);
        for (const id of Object.values(resources.assetAliases ?? {})) add('assets', id);
      }
    }
    // Include automatic producers for every newly reachable variable, reaching a
    // fixed point when a producer itself pulls additional dependencies into scope.
    for (const flow of source.flows)
      if (
        !needed.flows.has(flow.id) &&
        flow.nodes.some(
          (node) =>
            node.kind === 'event' && ['startup', 'interval'].includes(String(node.config.trigger)),
        )
      ) {
        const supplies = flow.nodes.some((node) => {
          if (node.kind === 'write' && typeof node.config.variable === 'string')
            return needed.variables.has(resolveVariable(source, node.config.variable).id);
          if (node.kind !== 'script') return false;
          const script = source.scripts.find((script) => script.id === node.config.scriptId);
          if (!script)
            throw new Error(`Missing script dependency: ${String(node.config.scriptId)}`);
          return script.variableAliases === undefined
            ? source.variables.some(
                (variable) => variable.type === 'number' && needed.variables.has(variable.id),
              )
            : Object.values(script.variableAliases).some((id) => needed.variables.has(id));
        });
        if (supplies) add('flows', flow.id);
      }
    if (!pending.length) break;
  }
  const select = <T extends { id: string }>(values: T[], kind: DependencyKind) =>
    clone(values.filter((value) => needed[kind].has(value.id)));
  const bundle: ClipboardBundle = {
    format: 'quickgui-clipboard',
    version: 1,
    source: {
      projectId: project.id,
      projectName: project.name,
      schemaVersion: project.schemaVersion,
      scope: clone(scope),
      windowId: sourceWindowId,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    },
    rootIds,
    widgets,
    variables: select(source.variables, 'variables'),
    flows: select(source.flows, 'flows'),
    scripts: select(source.scripts, 'scripts'),
    modules: select(source.modules, 'modules'),
    assets: select(source.assets, 'assets'),
    connections: select(source.connections, 'connections').map((connection) =>
      sanitizeConnection(connection, warnings),
    ),
    windows: select(windows, 'windows'),
    resourceScopes: select(source.resourceScopes ?? [], 'resourceScopes'),
    defaultResourceScope: defaultResources,
    warnings,
  };
  return validateBundle(bundle);
}

function validateBundle(raw: unknown): ClipboardBundle {
  assertSize(JSON.stringify(raw));
  const bundle = bundleSchema.parse(raw) as ClipboardBundle;
  bundle.connections = bundle.connections.map((connection) =>
    sanitizeConnection(connection, bundle.warnings),
  );
  bundle.warnings = [...new Set(bundle.warnings)];
  const ids = new Set(bundle.widgets.map((widget) => widget.id));
  if (ids.size !== bundle.widgets.length || new Set(bundle.rootIds).size !== bundle.rootIds.length)
    throw new Error('Duplicate clipboard widget/root IDs');
  const roots = new Set(bundle.rootIds);
  for (const id of roots) if (!ids.has(id)) throw new Error(`Missing clipboard root: ${id}`);
  for (const widget of bundle.widgets) {
    if (roots.has(widget.id) ? !!widget.parentId : !widget.parentId || !ids.has(widget.parentId))
      throw new Error(`Invalid clipboard subtree parent: ${widget.id}`);
    let current: Widget | undefined = widget;
    const visiting = new Set<string>();
    while (current?.parentId) {
      if (visiting.has(current.id)) throw new Error('Cyclic clipboard subtree');
      visiting.add(current.id);
      current = bundle.widgets.find((item) => item.id === current!.parentId);
    }
    if (!current || !roots.has(current.id))
      throw new Error('Clipboard contains widgets outside selected subtrees');
  }
  for (const kind of dependencyKinds) {
    const items = bundle[kind];
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error(`Duplicate clipboard ${kind} IDs`);
  }
  if (bundle.resourceScopes.some((scope) => scope.id === bundle.defaultResourceScope.id))
    throw new Error('Default resource scope ID collides with a dependency');
  return bundle;
}

const registeredPlans = new WeakMap<PastePlan, { base: string; candidate: string }>();

function makeMappings(previous?: PasteMappings): PasteMappings {
  return {
    variables: record(),
    flows: record(),
    scripts: record(),
    modules: record(),
    assets: record(),
    connections: record(),
    windows: record(),
    resourceScopes: record(),
    widgets: record(),
    moduleWidgets: record(),
    windowWidgets: record(),
    nodes: record(),
    edges: record(),
    reserved: clone(previous?.reserved ?? {}),
  };
}
function reserveId(
  mappings: PasteMappings,
  used: Set<string>,
  prefix: string,
  ...identity: string[]
): string {
  const key = JSON.stringify([prefix, ...identity]),
    previous = mappings.reserved[key];
  const id = previous && !used.has(previous) ? previous : newId(prefix, used);
  used.add(id);
  mappings.reserved[key] = id;
  return id;
}
function finishPlan(
  target: Project,
  candidate: Project,
  rootIds: string[],
  mappings: PasteMappings,
  summary: string[],
  warnings: string[],
  codeTrustRequired: boolean,
): PastePlan {
  candidate.revision = target.revision + 1;
  validateProject(candidate);
  const plan: PastePlan = {
    candidate,
    rootIds,
    mappings,
    summary,
    warnings: [...new Set(warnings)],
    codeTrustRequired,
    baseFingerprint: fingerprint(target),
  };
  registeredPlans.set(plan, { base: plan.baseFingerprint, candidate: fingerprint(candidate) });
  return plan;
}
function sameDocumentPaste(
  target: Project,
  bundle: ClipboardBundle,
  scope: EditScope,
  point: Point | undefined,
  options: PasteOptions,
): PastePlan {
  const candidate = clone(target),
    destination = widgetsIn(candidate, scope),
    mappings = makeMappings(options.previousMappings);
  if (
    scope.kind === 'module' &&
    candidate.modules.find((module) => module.id === scope.id)?.implementation?.kind === 'react'
  )
    throw new Error('A React module has no editable widget scene');
  if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y)))
    throw new Error('Paste position must be finite');
  const targetItems = (kind: DependencyKind): Array<{ id: string }> =>
    kind === 'windows' ? listProjectWindows(candidate) : (candidate[kind] ?? []);
  for (const kind of dependencyKinds) {
    for (const [id, reuse] of Object.entries(options.reuse?.[kind] ?? {})) {
      if (!bundle[kind].some((item) => item.id === id))
        throw new Error(`Unknown reuse source: ${kind}.${id}`);
      if (!targetItems(kind).some((item) => item.id === reuse))
        throw new Error(`Unknown reuse target: ${kind}.${reuse}`);
    }
    for (const item of bundle[kind]) {
      const id = own(options.reuse?.[kind], item.id) ?? item.id;
      if (targetItems(kind).some((item) => item.id === id)) {
        if (
          kind === 'variables' &&
          bundle.variables.find((v) => v.id === item.id)!.type !==
            candidate.variables.find((v) => v.id === id)!.type
        )
          throw new Error(`Incompatible reused variable type: ${item.id}`);
        mappings[kind][item.id] = id;
      }
    }
  }
  const shared = (kind: DependencyKind, id: string) => {
    const canonical = kind === 'variables' ? resolveVariable(bundle, id).id : id;
    const result = mappings[kind][canonical];
    if (!result) throw new Error(`Shared ${kind} dependency no longer exists: ${id}`);
    return result;
  };
  const used = new Set([
    ...listProjectWindows(candidate).flatMap((w) => w.widgets.map((w) => w.id)),
    ...candidate.modules.flatMap((m) => m.widgets.map((w) => w.id)),
  ]);
  const names = new Set(destination.map((w) => w.name));
  for (const widget of bundle.widgets)
    mappings.widgets[widget.id] = reserveId(mappings, used, 'widget', 'selection', widget.id);
  const widgets = bundle.widgets.map((original) => {
    const next = clone(original);
    next.id = mappings.widgets[original.id];
    next.name = newName(original.name, names);
    if (next.parentId) next.parentId = mappings.widgets[next.parentId];
    if (next.moduleId) next.moduleId = shared('modules', next.moduleId);
    if (next.resourceScopeId) {
      if (mappings.resourceScopes[next.resourceScopeId])
        next.resourceScopeId = mappings.resourceScopes[next.resourceScopeId];
      else delete next.resourceScopeId; // A package-local inherited scope is not a project dependency.
    }
    for (const binding of Object.values(next.bindings))
      binding.variable = shared('variables', binding.variable);
    for (const [event, id] of Object.entries(next.events)) next.events[event] = shared('flows', id);
    for (const definition of referenceProperties(original, bundle.modules)) {
      const kind = refKind(definition.reference),
        value = getJsonPath(original.props, propertyPath(definition.key, original.props));
      if (kind && typeof value === 'string' && value) {
        if (kind === 'variables' || kind === 'modules')
          next.props = setProperty(next.props, definition.key, shared(kind, value));
        else if (mappings.assets[value])
          next.props = setProperty(next.props, definition.key, mappings.assets[value]);
      }
    }
    if (next.type === 'chart' && Array.isArray(next.props.series))
      for (const series of next.props.series)
        if (
          series &&
          typeof series === 'object' &&
          !Array.isArray(series) &&
          typeof series.variableId === 'string' &&
          series.variableId
        )
          series.variableId = shared('variables', series.variableId);
    return next;
  });
  const roots = widgets.filter((widget) =>
    bundle.rootIds.some((id) => mappings.widgets[id] === widget.id),
  );
  const minX = Math.min(...roots.map((w) => w.layout.x)),
    minY = Math.min(...roots.map((w) => w.layout.y)),
    anchor = point ?? { x: minX + 20, y: minY + 20 };
  for (const root of roots) {
    root.layout.x += anchor.x - minX;
    root.layout.y += anchor.y - minY;
  }
  destination.push(...widgets);
  return finishPlan(
    target,
    candidate,
    roots.map((w) => w.id),
    mappings,
    [
      `Paste ${widgets.length} widgets with shared document references; keep schema ${target.schemaVersion}.`,
    ],
    [...bundle.warnings],
    false,
  );
}
export function preparePaste(
  target: Project,
  rawBundle: ClipboardBundle,
  scope: EditScope,
  point?: Point,
  options: PasteOptions = {},
): PastePlan {
  validateProject(target);
  const bundle = validateBundle(rawBundle);
  const sameDocument =
    options.sameDocument === true &&
    !!bundle.source.sessionKey &&
    bundle.source.sessionKey === options.sessionKey;
  if (options.sameDocument && !sameDocument)
    throw new Error('Same-document reuse requires a matching document session key');
  if (sameDocument) return sameDocumentPaste(target, bundle, scope, point, options);
  const candidate = upgradeProject(target);
  const destination = widgetsIn(candidate, scope);
  if (
    scope.kind === 'module' &&
    candidate.modules.find((module) => module.id === scope.id)?.implementation?.kind === 'react'
  )
    throw new Error('A React module has no editable widget scene');
  const currentWindowId = scope.kind === 'window' ? scope.id : options.currentWindowId;
  if (
    scope.kind === 'module' &&
    !currentWindowId &&
    bundle.flows.some((flow) => flow.nodes.some((node) => node.kind === 'window'))
  )
    throw new Error('Pasting window actions into a module requires currentWindowId');
  if (
    currentWindowId &&
    !listProjectWindows(candidate).some((window) => window.id === currentWindowId)
  )
    throw new Error(`Missing target current window: ${currentWindowId}`);
  if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y)))
    throw new Error('Paste position must be finite');
  const warnings = [...bundle.warnings],
    summary: string[] = [];
  if (target.schemaVersion !== 3)
    summary.push(
      'Upgrade the target working copy to schema v3; existing widgets keep definition version 1.',
    );
  const mappings = makeMappings(options.previousMappings);
  const imported = Object.fromEntries(
    dependencyKinds.map((kind) => [kind, new Set<string>()]),
  ) as Record<DependencyKind, Set<string>>;
  const targetItems = (kind: DependencyKind): Array<{ id: string; name?: string }> =>
    kind === 'windows' ? listProjectWindows(candidate) : (candidate[kind] ?? []);
  const allUsedIds = new Set([
    ...dependencyKinds.flatMap((kind) => targetItems(kind).map((item) => item.id)),
    ...candidate.widgets.map((widget) => widget.id),
    ...candidate.windows!.flatMap((window) => window.widgets.map((widget) => widget.id)),
    ...candidate.modules.flatMap((module) => module.widgets.map((widget) => widget.id)),
    ...candidate.flows.flatMap((flow) => [
      ...flow.nodes.map((node) => node.id),
      ...flow.edges.map((edge) => edge.id),
    ]),
  ]);
  const names = Object.fromEntries(
    dependencyKinds.map((kind) => [
      kind,
      new Set(
        targetItems(kind)
          .map((item) => item.name)
          .filter((name): name is string => name !== undefined),
      ),
    ]),
  ) as Record<DependencyKind, Set<string>>;
  for (const kind of dependencyKinds) {
    for (const [sourceId, targetId] of Object.entries(options.reuse?.[kind] ?? {})) {
      if (
        !bundle[kind].some((item) => item.id === sourceId) &&
        !(kind === 'resourceScopes' && sourceId === bundle.defaultResourceScope.id)
      )
        throw new Error(`Unknown reuse source: ${kind}.${sourceId}`);
      if (!targetItems(kind).some((item) => item.id === targetId))
        throw new Error(`Unknown reuse target: ${kind}.${targetId}`);
    }
    for (const item of bundle[kind]) {
      const reuse =
        own(options.reuse?.[kind], item.id) ??
        (sameDocument && targetItems(kind).some((existing) => existing.id === item.id)
          ? item.id
          : undefined);
      if (reuse) {
        if (
          kind === 'variables' &&
          bundle.variables.find((variable) => variable.id === item.id)!.type !==
            candidate.variables.find((variable) => variable.id === reuse)!.type
        )
          throw new Error(`Incompatible reused variable type: ${item.id}`);
        mappings[kind][item.id] = reuse;
        summary.push(`Reuse ${kind}: ${item.id} → ${reuse}`);
      } else {
        mappings[kind][item.id] = reserveId(mappings, allUsedIds, kind.slice(0, -1), kind, item.id);
        imported[kind].add(item.id);
      }
    }
  }
  mappings.windows[bundle.source.windowId] = currentWindowId ?? 'main';
  const mapped = (kind: DependencyKind, key: string): string => {
    const canonical = kind === 'variables' ? resolveVariable(bundle, key).id : key;
    const result = mappings[kind][canonical];
    if (!result) throw new Error(`Clipboard dependency is missing: ${kind}.${key}`);
    return result;
  };
  const importScope = (original: ResourceScope, id: string): ResourceScope => ({
    ...clone(original),
    id,
    theme: clone(options.useTargetTheme ? candidate.theme : original.theme),
    assetAliases: {
      ...mappings.assets,
      ...Object.fromEntries(
        Object.entries(original.assetAliases ?? {}).map(([alias, id]) => [
          alias,
          mapped('assets', id),
        ]),
      ),
    },
    ...(original.localeVariableId
      ? { localeVariableId: mapped('variables', original.localeVariableId) }
      : {}),
  });
  candidate.resourceScopes ??= [];
  for (const resources of bundle.resourceScopes)
    if (imported.resourceScopes.has(resources.id))
      candidate.resourceScopes.push(importScope(resources, mapped('resourceScopes', resources.id)));
  let defaultScopeId: string | undefined;
  if (!sameDocument) {
    defaultScopeId =
      own(options.reuse?.resourceScopes, bundle.defaultResourceScope.id) ??
      reserveId(mappings, allUsedIds, 'resources', 'default', bundle.defaultResourceScope.id);
    mappings.resourceScopes[bundle.defaultResourceScope.id] = defaultScopeId;
    if (!own(options.reuse?.resourceScopes, bundle.defaultResourceScope.id))
      candidate.resourceScopes.push(importScope(bundle.defaultResourceScope, defaultScopeId));
  }
  const bundleScope = (id?: string) => bundle.resourceScopes.find((r) => r.id === id);
  const mapReference = (
    kind: DependencyKind | undefined,
    value: Json,
    resources?: ResourceScope,
  ): Json =>
    kind && typeof value === 'string' && value
      ? mapped(kind, kind === 'assets' ? (own(resources?.assetAliases, value) ?? value) : value)
      : value;
  const transformWidgets = (
    originals: Widget[],
    widgetMap: Record<string, string>,
    roots?: Set<string>,
    inherited?: ResourceScope,
    widgetIdentity: string[] = ['selection'],
  ): Widget[] => {
    for (const widget of originals)
      widgetMap[widget.id] = reserveId(
        mappings,
        allUsedIds,
        'widget',
        ...widgetIdentity,
        widget.id,
      );
    const usedNames = new Set(destination.map((widget) => widget.name));
    return originals.map((original) => {
      let resources = inherited,
        current: Widget | undefined = original;
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        if (current.resourceScopeId) {
          resources = bundleScope(current.resourceScopeId);
          break;
        }
        current = originals.find((item) => item.id === current!.parentId);
      }
      const sourceModule = bundle.modules.find((module) => module.id === original.moduleId);
      resources ??=
        bundleScope(sourceModule?.resourceScopeId) ?? sourceModule?.embeddedResourceScope;
      const widget = clone(original);
      widget.id = widgetMap[original.id];
      widget.name = newName(original.name, usedNames);
      if (original.parentId) {
        if (!widgetMap[original.parentId])
          throw new Error(`Missing copied parent: ${original.parentId}`);
        widget.parentId = widgetMap[original.parentId];
      }
      if (original.moduleId) widget.moduleId = mapped('modules', original.moduleId);
      if (original.resourceScopeId)
        widget.resourceScopeId = mapped('resourceScopes', original.resourceScopeId);
      else if (defaultScopeId && roots?.has(original.id) && original.type !== 'module')
        widget.resourceScopeId = defaultScopeId;
      for (const binding of Object.values(widget.bindings))
        binding.variable = mapped('variables', binding.variable);
      for (const [event, flowId] of Object.entries(widget.events))
        widget.events[event] = mapped('flows', flowId);
      for (const definition of referenceProperties(original, bundle.modules)) {
        const value = getJsonPath(original.props, propertyPath(definition.key, original.props));
        if (value !== undefined)
          widget.props = setProperty(
            widget.props,
            definition.key,
            mapReference(refKind(definition.reference), value, resources),
          );
      }
      for (const key of original.type === 'button'
        ? ['iconAssetId']
        : original.type === 'image'
          ? ['assetId']
          : [])
        if (typeof original.props[key] === 'string' && original.props[key])
          widget.props[key] = mapReference('assets', original.props[key], resources);
      if (widget.type === 'chart' && Array.isArray(widget.props.series))
        for (const series of widget.props.series)
          if (
            series &&
            typeof series === 'object' &&
            !Array.isArray(series) &&
            typeof series.variableId === 'string' &&
            series.variableId
          )
            series.variableId = mapped('variables', series.variableId);
      return widget;
    });
  };
  for (const variable of bundle.variables)
    if (imported.variables.has(variable.id))
      candidate.variables.push({
        ...clone(variable),
        id: mapped('variables', variable.id),
        name: newName(variable.name, names.variables),
      });
  for (const asset of bundle.assets)
    if (imported.assets.has(asset.id))
      candidate.assets.push({
        ...clone(asset),
        id: mapped('assets', asset.id),
        name: newName(asset.name, names.assets),
      });
  for (const connection of bundle.connections)
    if (imported.connections.has(connection.id))
      candidate.connections.push({
        ...sanitizeConnection(connection, warnings),
        id: mapped('connections', connection.id),
        name: newName(connection.name, names.connections),
      });
  for (const script of bundle.scripts)
    if (imported.scripts.has(script.id)) {
      const aliases = record<string>();
      if (script.variableAliases !== undefined)
        for (const [alias, targetId] of Object.entries(script.variableAliases))
          aliases[alias] = mapped('variables', targetId);
      else {
        // Names are installed first and stable IDs last, matching the native host's
        // collision rule. Aliases bind canonical slots without changing C bytes.
        for (const variable of bundle.variables.filter((v) => v.type === 'number'))
          aliases[variable.name] = mapped('variables', variable.id);
        for (const variable of bundle.variables.filter((v) => v.type === 'number'))
          aliases[variable.id] = mapped('variables', variable.id);
      }
      candidate.scripts.push({
        ...clone(script),
        id: mapped('scripts', script.id),
        name: newName(script.name, names.scripts),
        variableAliases: aliases,
      });
    }
  for (const module of bundle.modules)
    if (imported.modules.has(module.id)) {
      const local = record<string>();
      mappings.moduleWidgets[module.id] = local;
      const next = clone(module);
      next.id = mapped('modules', module.id);
      next.name = newName(module.name, names.modules);
      if (module.implementation?.kind === 'react')
        next.packageIdentity = clone(
          module.packageIdentity ?? {
            id: module.id,
            name: module.name,
            version: module.version,
            width: module.width,
            height: module.height,
          },
        );
      const sourceResources = bundleScope(module.resourceScopeId) ?? module.embeddedResourceScope;
      next.widgets = transformWidgets(module.widgets, local, undefined, sourceResources, [
        'module',
        module.id,
      ]);
      next.resourceScopeId = module.resourceScopeId
        ? mapped('resourceScopes', module.resourceScopeId)
        : defaultScopeId;
      if (module.embeddedResourceScope) {
        const embeddedId = reserveId(mappings, allUsedIds, 'resources', 'module', module.id);
        candidate.resourceScopes.push(importScope(module.embeddedResourceScope, embeddedId));
        next.resourceScopeId = embeddedId;
        next.embeddedResourceScope = importScope(module.embeddedResourceScope, embeddedId);
      }
      for (const [key, property] of Object.entries(next.exposedProps)) {
        if (property.widgetId !== '$component')
          property.widgetId =
            local[property.widgetId] ??
            (() => {
              throw new Error(`Missing exposed widget: ${property.widgetId}`);
            })();
        if (module.implementation?.kind !== 'react')
          property.default = mapReference(
            refKind(moduleDefaultDefinition(module, key, bundle.modules)?.reference),
            property.default,
            sourceResources,
          );
      }
      if (module.implementation?.kind !== 'react')
        for (const definition of Object.values(next.propertyDefinitions ?? {}))
          for (const key of ['initialValue', 'fallbackValue'] as const)
            definition[key] = mapReference(
              refKind(definition.reference),
              definition[key],
              sourceResources,
            );
      candidate.modules.push(next);
    }
  for (const flow of bundle.flows)
    if (imported.flows.has(flow.id)) {
      const next = clone(flow),
        nodeMap = record<string>(),
        edgeMap = record<string>();
      mappings.nodes[flow.id] = nodeMap;
      mappings.edges[flow.id] = edgeMap;
      for (const node of next.nodes)
        nodeMap[node.id] = reserveId(mappings, allUsedIds, 'node', flow.id, node.id);
      for (const node of next.nodes) {
        node.id = nodeMap[node.id];
        const c = node.config;
        if ((node.kind === 'read' || node.kind === 'write') && typeof c.variable === 'string')
          c.variable = mapped('variables', c.variable);
        if (node.kind === 'script' && typeof c.scriptId === 'string')
          c.scriptId = mapped('scripts', c.scriptId);
        if (node.kind === 'connection' && typeof c.connectionId === 'string')
          c.connectionId = mapped('connections', c.connectionId);
        if (node.kind === 'window' && typeof c.windowId === 'string') {
          c.windowId = mapped('windows', c.windowId);
          if (c.action === 'close' && c.windowId === 'main')
            throw new Error('A copied close action would close the target main window');
        }
      }
      for (const edge of next.edges) {
        const id = reserveId(mappings, allUsedIds, 'edge', flow.id, edge.id);
        edgeMap[edge.id] = id;
        edge.id = id;
        edge.source = nodeMap[edge.source];
        edge.target = nodeMap[edge.target];
      }
      next.id = mapped('flows', flow.id);
      next.name = newName(flow.name, names.flows);
      next.enabled = options.enableFlows?.includes(flow.id) ?? false;
      summary.push(
        `Flow ${flow.name}: source enabled=${flow.enabled}; pasted enabled=${next.enabled}`,
      );
      candidate.flows.push(next);
    }
  for (const window of bundle.windows)
    if (imported.windows.has(window.id)) {
      const widgetMap = record<string>();
      mappings.windowWidgets[window.id] = widgetMap;
      const next = clone(window);
      next.id = mapped('windows', window.id);
      next.name = newName(window.name, names.windows);
      next.widgets = transformWidgets(
        window.widgets,
        widgetMap,
        new Set(window.widgets.filter((widget) => !widget.parentId).map((widget) => widget.id)),
        undefined,
        ['window', window.id],
      );
      if (next.config.icon) next.config.icon = mapped('assets', next.config.icon);
      next.openOnStart = options.openWindows?.includes(window.id) ?? false;
      summary.push(
        `Window ${window.name}: source openOnStart=${window.openOnStart}; pasted openOnStart=${next.openOnStart}`,
      );
      candidate.windows!.push(next);
    }
  const pasted = transformWidgets(bundle.widgets, mappings.widgets, new Set(bundle.rootIds));
  const roots = pasted.filter((widget) =>
    bundle.rootIds.some((id) => mappings.widgets[id] === widget.id),
  );
  const minX = Math.min(...roots.map((widget) => widget.layout.x)),
    minY = Math.min(...roots.map((widget) => widget.layout.y));
  const anchor = point ?? { x: minX + 20, y: minY + 20 };
  for (const widget of roots) {
    widget.layout.x += anchor.x - minX;
    widget.layout.y += anchor.y - minY;
  }
  destination.push(...pasted);
  candidate.revision = target.revision + 1;
  validateProject(candidate);
  const codeTrustRequired =
    imported.scripts.size > 0 ||
    bundle.modules.some(
      (module) => imported.modules.has(module.id) && module.implementation?.kind === 'react',
    );
  if (codeTrustRequired)
    warnings.push(
      'Imported C or React code is preserved verbatim; review and trust it before running.',
    );
  summary.unshift(
    `Paste ${pasted.length} widgets (${roots.length} roots); ${dependencyKinds.map((kind) => `${kind}=${imported[kind].size}`).join(', ')}`,
  );
  return finishPlan(
    target,
    candidate,
    roots.map((widget) => widget.id),
    mappings,
    summary,
    warnings,
    codeTrustRequired,
  );
}

export function applyPastePlan(target: Project, plan: PastePlan): Project {
  validateProject(target);
  const registered = registeredPlans.get(plan);
  if (!registered || registered.base !== fingerprint(target))
    throw new Error('The target project changed after paste planning; prepare a new paste plan');
  if (registered.candidate !== fingerprint(plan.candidate))
    throw new Error('The paste candidate changed after validation; prepare a new paste plan');
  validateProject(plan.candidate);
  return clone(plan.candidate);
}

let memoryClipboard: ClipboardBundle | undefined;
let clipboardStorage: 'system' | 'memory' = 'memory';
export function getClipboardStorage(): 'system' | 'memory' {
  return clipboardStorage;
}
export async function writeClipboard(raw: ClipboardBundle): Promise<void> {
  const bundle = validateBundle(raw),
    text = JSON.stringify(bundle);
  assertSize(text);
  memoryClipboard = clone(bundle);
  try {
    if (native.isDesktop()) await native.writeClipboardText(text);
    else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText)
      await navigator.clipboard.writeText(text);
    else throw new Error('System clipboard unavailable');
    clipboardStorage = 'system';
  } catch {
    clipboardStorage = 'memory';
    memoryClipboard.warnings = [
      ...memoryClipboard.warnings,
      'System clipboard unavailable; using this process clipboard only.',
    ];
  }
}
export async function readClipboard(): Promise<ClipboardBundle> {
  let text: string;
  try {
    if (native.isDesktop()) text = await native.readClipboardText();
    else if (typeof navigator !== 'undefined' && navigator.clipboard?.readText)
      text = await navigator.clipboard.readText();
    else throw new Error('System clipboard unavailable');
    clipboardStorage = 'system';
  } catch (error) {
    if (!memoryClipboard) throw new Error(`Clipboard unavailable: ${String(error)}`);
    clipboardStorage = 'memory';
    const fallback = clone(memoryClipboard);
    fallback.warnings = [
      ...fallback.warnings,
      'System clipboard unavailable; using this process clipboard only.',
    ];
    return validateBundle(fallback);
  }
  assertSize(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Clipboard does not contain a QuickGUI bundle');
  }
  return validateBundle(value);
}
