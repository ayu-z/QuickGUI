import type { ComponentModule, Project, Widget } from './types';
import { createWidget, subtreeIds, uid } from './project';
import { getProjectWindow, listProjectWindows } from './windows';
import { validateProject } from './validation';
import {
  getWidgetDefinition,
  setProperty,
  validatePropertyPatch,
  validatePropertyValue,
} from './widgetDefinitions';

export type ModuleScope = { kind: 'window' | 'module'; id: string };
export type ModuleDrafts = Readonly<Record<string, string>>;
export type ModuleDefinitionPatch = Partial<
  Pick<ComponentModule, 'name' | 'version' | 'width' | 'height' | 'exposedProps'>
>;

function findModule(project: Project, id: string): ComponentModule {
  const module = project.modules.find((item) => item.id === id);
  if (!module) throw new Error('模块不存在 / Module does not exist');
  return module;
}
function scopeWidgets(project: Project, scope: ModuleScope): Widget[] {
  return scope.kind === 'window'
    ? getProjectWindow(project, scope.id).widgets
    : findModule(project, scope.id).widgets;
}
function checkDrafts(
  project: Project,
  scope: ModuleScope,
  widgets: Widget[],
  drafts: ModuleDrafts = {},
): void {
  const prefix = `${project.id}/${scope.kind}/${scope.id}`;
  if (
    widgets.some(
      (widget) =>
        Object.hasOwn(drafts, widget.id) || Object.hasOwn(drafts, `${prefix}::${widget.id}`),
    )
  )
    throw new Error(
      '请先应用或还原选中控件的 CODE 草稿 / Apply or restore the selected widgets’ CODE drafts first',
    );
}
function checkName(project: Project, name: string, exceptId?: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized))
    throw new Error('模块名称应为 1–200 个有效字符 / Module names require 1–200 valid characters');
  if (project.modules.some((module) => module.id !== exceptId && module.name === normalized))
    throw new Error('模块名称已存在 / Module name already exists');
  return normalized;
}
function commitModules(project: Project, candidate: Project): void {
  validateProject(candidate);
  project.modules = candidate.modules;
}
function cloneWidgets(widgets: Widget[]): { widgets: Widget[]; ids: Map<string, string> } {
  const ids = new Map(widgets.map((widget) => [widget.id, uid(widget.type)]));
  return {
    ids,
    widgets: widgets.map((widget) => {
      const next = structuredClone(widget);
      next.id = ids.get(widget.id)!;
      if (next.parentId) {
        if (ids.has(next.parentId)) next.parentId = ids.get(next.parentId)!;
        else delete next.parentId;
      }
      return next;
    }),
  };
}

/** Every reference is counted, including nested instances in other module definitions. */
export function moduleReferences(project: Project, id: string): string[] {
  return [
    ...listProjectWindows(project).flatMap((window) =>
      window.widgets
        .filter((widget) => widget.moduleId === id)
        .map((widget) => `${window.name} / ${widget.name}`),
    ),
    ...project.modules.flatMap((module) =>
      module.widgets
        .filter((widget) => widget.moduleId === id)
        .map((widget) => `${module.name} / ${widget.name}`),
    ),
  ];
}

/** Copies selection roots and their complete subtrees; the originals and all shared logic stay intact. */
export function createModuleFromSelection(
  project: Project,
  options: {
    name: string;
    scope: ModuleScope;
    selectedIds: readonly string[];
    drafts?: ModuleDrafts;
    positions?: Readonly<Record<string, { x: number; y: number }>>;
  },
): ComponentModule {
  const name = checkName(project, options.name);
  const source = scopeWidgets(project, options.scope);
  if (options.scope.kind === 'module' && findModule(project, options.scope.id).implementation)
    throw new Error(
      '源码模块不能作为可视布局编辑 / Source components cannot be edited as visual layouts',
    );
  const selected = new Set(options.selectedIds);
  if ([...selected].some((id) => !source.some((widget) => widget.id === id)))
    throw new Error(
      '选中控件不属于当前编辑范围 / Selected widgets are outside the current editing scope',
    );
  const byId = new Map(source.map((widget) => [widget.id, widget]));
  const roots = source.filter((widget) => {
    if (!selected.has(widget.id)) return false;
    let parent = widget.parentId;
    while (parent) {
      if (selected.has(parent)) return false;
      parent = byId.get(parent)?.parentId;
    }
    return true;
  });
  const included = new Set(roots.flatMap((root) => [...subtreeIds(source, root.id)]));
  const originals = source.filter((widget) => included.has(widget.id));
  checkDrafts(project, options.scope, originals, options.drafts);
  const owner = options.scope.kind === 'module' ? findModule(project, options.scope.id) : undefined;
  const worldPosition = (widget: Widget) => {
    let { x, y } = widget.layout;
    let parent = widget.parentId;
    while (parent) {
      const ancestor = byId.get(parent)!;
      if (!included.has(parent) && ancestor.layout.mode && ancestor.layout.mode !== 'absolute')
        throw new Error(
          '请同时选择弹性或网格布局的容器 / Select the containing flex or grid layout as well',
        );
      x += ancestor.layout.x;
      y += ancestor.layout.y;
      parent = ancestor.parentId;
    }
    return { x, y };
  };
  const positions = new Map(
    roots.map((widget) => {
      const fallback = worldPosition(widget);
      const position = options.positions?.[widget.id] ?? fallback;
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
        throw new Error('控件位置必须为有限数值 / Widget positions must be finite');
      return [widget.id, position] as const;
    }),
  );
  const left = originals.length
    ? Math.min(...roots.map((widget) => positions.get(widget.id)!.x))
    : 0;
  const top = originals.length
    ? Math.min(...roots.map((widget) => positions.get(widget.id)!.y))
    : 0;
  const width = roots.length
    ? Math.max(...roots.map((widget) => positions.get(widget.id)!.x + widget.layout.width)) - left
    : 300;
  const height = roots.length
    ? Math.max(...roots.map((widget) => positions.get(widget.id)!.y + widget.layout.height)) - top
    : 180;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0 && value <= 10000))
    throw new Error(
      '模块画布尺寸应大于 0 且不超过 10000 / Module dimensions must be positive and at most 10000',
    );
  const cloned = cloneWidgets(originals);
  for (const root of roots) {
    const next = cloned.widgets.find((widget) => widget.id === cloned.ids.get(root.id))!;
    next.layout.x = positions.get(root.id)!.x - left;
    next.layout.y = positions.get(root.id)!.y - top;
    let ancestor = root.parentId;
    while (!next.resourceScopeId && ancestor) {
      const parent = byId.get(ancestor)!;
      next.resourceScopeId = parent.resourceScopeId;
      ancestor = parent.parentId;
    }
    if (next.resourceScopeId === undefined) delete next.resourceScopeId;
  }
  const module: ComponentModule = {
    id: uid('module'),
    name,
    version: '1.0.0',
    width,
    height,
    widgets: cloned.widgets,
    exposedProps: {},
    ...(owner?.resourceScopeId ? { resourceScopeId: owner.resourceScopeId } : {}),
    ...(owner?.embeddedResourceScope
      ? { embeddedResourceScope: structuredClone(owner.embeddedResourceScope) }
      : {}),
  };
  const candidate = structuredClone(project);
  candidate.modules.push(module);
  commitModules(project, candidate);
  return findModule(project, module.id);
}

export function insertModuleInstance(
  project: Project,
  moduleId: string,
  scope: ModuleScope,
  position = { x: 32, y: 32 },
): Widget {
  const module = findModule(project, moduleId);
  if (scope.kind === 'module' && findModule(project, scope.id).implementation)
    throw new Error('源码模块布局为只读 / Source component layouts are read-only');
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
    throw new Error('实例位置必须是有限数值 / Instance position must be finite');
  const candidate = structuredClone(project);
  const widget = createWidget('module', position.x, position.y, 2);
  widget.name = module.name;
  widget.moduleId = module.id;
  widget.layout.width = module.width;
  widget.layout.height = module.height;
  widget.props = Object.fromEntries(
    Object.entries(module.exposedProps).map(([key, value]) => [
      key,
      structuredClone(value.default),
    ]),
  );
  scopeWidgets(candidate, scope).push(widget);
  validateProject(candidate);
  if (scope.kind === 'module') project.modules = candidate.modules;
  else if (scope.id === 'main') project.widgets = candidate.widgets;
  else project.windows = candidate.windows;
  return widget;
}

export function updateModuleDefinition(
  project: Project,
  id: string,
  patch: ModuleDefinitionPatch,
): void {
  const current = findModule(project, id);
  const candidate = structuredClone(project);
  const next = findModule(candidate, id);
  if (patch.name !== undefined) next.name = checkName(project, patch.name, id);
  if (current.implementation) {
    if (Object.keys(patch).some((key) => key !== 'name'))
      throw new Error(
        '源码组件的版本、尺寸与属性由源码清单定义，请导出源码包修改后重新导入 / Export and rebuild the source package to edit its version, size or properties',
      );
    if (next.name !== current.name)
      next.packageIdentity ??= {
        id: current.id,
        name: current.name,
        version: current.version,
        width: current.width,
        height: current.height,
      };
  }
  for (const key of ['width', 'height'] as const)
    if (patch[key] !== undefined) {
      if (!Number.isFinite(patch[key]) || patch[key]! <= 0 || patch[key]! > 10000)
        throw new Error(
          '模块画布尺寸应大于 0 且不超过 10000 / Module dimensions must be positive and at most 10000',
        );
      next[key] = patch[key]!;
    }
  if (patch.version !== undefined) {
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(patch.version))
      throw new Error('请输入有效版本，例如 1.0.0 / Enter a valid version, for example 1.0.0');
    next.version = patch.version;
  }
  if (patch.exposedProps !== undefined) {
    const before = Object.keys(current.exposedProps).sort().join('\n');
    const after = Object.keys(patch.exposedProps).sort().join('\n');
    if (before !== after && moduleReferences(project, id).length)
      throw new Error(
        '请先移除实例再增删暴露属性 / Remove instances before adding or removing exposed properties',
      );
    for (const [key, property] of Object.entries(patch.exposedProps)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key) ||
        ['__proto__', 'constructor', 'prototype'].includes(key)
      )
        throw new Error(
          '暴露属性名须为有效且非保留的标识符 / Exposed property names must be valid non-reserved identifiers',
        );
      const widget = next.widgets.find((widget) => widget.id === property.widgetId);
      const definition =
        widget &&
        getWidgetDefinition(
          widget.type,
          widget.definitionVersion ?? 1,
          project.modules.find((module) => module.id === widget.moduleId),
        ).properties.find((entry) => entry.key === property.property);
      if (!definition)
        throw new Error('请选择有效的控件与属性 / Choose a valid widget and property');
      const error = validatePropertyValue(definition, property.default);
      if (error) throw new Error(`${key}: ${error}`);
      const issues = validatePropertyPatch(
        widget!,
        { props: setProperty(widget!.props, property.property, property.default) },
        candidate,
      );
      if (issues.length)
        throw new Error(`${key}: ${issues.map((issue) => issue.message).join(', ')}`);
    }
    next.exposedProps = structuredClone(patch.exposedProps);
    if (next.propertyDefinitions)
      next.propertyDefinitions = Object.fromEntries(
        Object.entries(next.propertyDefinitions).filter(([key]) =>
          Object.hasOwn(next.exposedProps, key),
        ),
      );
  }
  commitModules(project, candidate);
}

export function duplicateModuleDefinition(
  project: Project,
  id: string,
  name?: string,
  drafts?: ModuleDrafts,
): ComponentModule {
  const current = findModule(project, id);
  checkDrafts(project, { kind: 'module', id }, current.widgets, drafts);
  let label = name;
  if (label === undefined) {
    const base = `${current.name} ${project.locale === 'zh-CN' ? '副本' : 'copy'}`;
    label = base;
    let index = 2;
    while (project.modules.some((module) => module.name === label)) label = `${base} ${index++}`;
  }
  const next = structuredClone(current);
  next.id = uid('module');
  next.name = checkName(project, label);
  const cloned = cloneWidgets(next.widgets);
  next.widgets = cloned.widgets;
  for (const value of Object.values(next.exposedProps))
    value.widgetId = cloned.ids.get(value.widgetId) ?? value.widgetId;
  if (current.implementation)
    next.packageIdentity ??= {
      id: current.id,
      name: current.name,
      version: current.version,
      width: current.width,
      height: current.height,
    };
  const candidate = structuredClone(project);
  candidate.modules.push(next);
  commitModules(project, candidate);
  return findModule(project, next.id);
}

export function deleteModuleDefinition(project: Project, id: string, drafts?: ModuleDrafts): void {
  const module = findModule(project, id);
  const references = moduleReferences(project, id);
  if (references.length)
    throw new Error(
      `请先移除模块实例引用 / Remove module instances first: ${references.join(', ')}`,
    );
  checkDrafts(project, { kind: 'module', id }, module.widgets, drafts);
  const candidate = structuredClone(project);
  candidate.modules = candidate.modules.filter((module) => module.id !== id);
  commitModules(project, candidate);
}
