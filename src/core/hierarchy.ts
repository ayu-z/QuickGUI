import { createWidget } from './project';
import type { Widget } from './types';

export interface HierarchyTarget {
  parentId?: string;
  /** Insert before this sibling; omitted means append at the front of the stacking order. */
  beforeId?: string;
}

function roots(widgets: Widget[], ids: string[]): Widget[] {
  const selected = new Set(ids);
  return widgets.filter((widget) => {
    if (!selected.has(widget.id)) return false;
    const seen = new Set([widget.id]);
    let parent = widget.parentId;
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) return false;
      seen.add(parent);
      parent = widgets.find((entry) => entry.id === parent)?.parentId;
    }
    return true;
  });
}

function ancestors(widgets: Widget[], parentId?: string): Widget[] {
  const found: Widget[] = [],
    seen = new Set<string>();
  while (parentId) {
    if (seen.has(parentId)) throw new Error('层级存在循环 / Cyclic hierarchy');
    seen.add(parentId);
    const parent = widgets.find((entry) => entry.id === parentId);
    if (!parent) throw new Error('父容器不存在 / Parent container does not exist');
    found.push(parent);
    parentId = parent.parentId;
  }
  return found;
}

function subtree(widgets: Widget[], id: string): Widget[] {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const widget of widgets)
      if (widget.parentId && ids.has(widget.parentId) && !ids.has(widget.id)) {
        ids.add(widget.id);
        changed = true;
      }
  }
  return widgets.filter((widget) => ids.has(widget.id));
}

function locked(widgets: Widget[], widget: Widget): boolean {
  return [widget, ...ancestors(widgets, widget.parentId)].some((entry) => entry.editor?.locked);
}
function scope(widgets: Widget[], parentId?: string): string | undefined {
  return ancestors(widgets, parentId).find((entry) => entry.resourceScopeId)?.resourceScopeId;
}
function origin(widgets: Widget[], parentId?: string): { x: number; y: number } {
  return ancestors(widgets, parentId).reduce(
    (point, parent) => ({ x: point.x + parent.layout.x, y: point.y + parent.layout.y }),
    { x: 0, y: 0 },
  );
}
function absoluteAncestors(widgets: Widget[], parentId?: string): boolean {
  return ancestors(widgets, parentId).every(
    (entry) => !entry.layout.mode || entry.layout.mode === 'absolute',
  );
}
function structuralIssue(widgets: Widget[], ids: string[]): string | undefined {
  if (!ids.length || ids.some((id) => !widgets.some((widget) => widget.id === id)))
    return '请选择有效图层 / Select existing layers';
  const selected = roots(widgets, ids);
  if (
    selected.some(
      (widget) =>
        locked(widgets, widget) ||
        subtree(widgets, widget.id).some((entry) => entry.editor?.locked),
    )
  )
    return '请先解锁图层及其子图层 / Unlock layers and their descendants first';
  return undefined;
}
function message(check: () => string | undefined): string | undefined {
  try {
    return check();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function moveIssue(
  widgets: Widget[],
  ids: string[],
  target: HierarchyTarget,
): string | undefined {
  return message(() => {
    const issue = structuralIssue(widgets, ids);
    if (issue) return issue;
    const selected = roots(widgets, ids),
      selectedIds = new Set(selected.map((widget) => widget.id));
    const parent = target.parentId
      ? widgets.find((widget) => widget.id === target.parentId)
      : undefined;
    if (target.parentId && (!parent || parent.type !== 'panel'))
      return '仅可移入容器或窗口根级 / Move into a panel or the window root';
    if (parent && locked(widgets, parent)) return '目标容器已锁定 / Target container is locked';
    if (
      selected.some((widget) =>
        subtree(widgets, widget.id).some((entry) => entry.id === target.parentId),
      )
    )
      return '不能移入自身或后代图层 / Cannot move a layer into itself or its descendants';
    if (target.beforeId) {
      const before = widgets.find((widget) => widget.id === target.beforeId);
      if (!before || before.parentId !== target.parentId || selectedIds.has(before.id))
        return '放置位置无效 / Invalid drop position';
    }
    for (const widget of selected) {
      if (widget.parentId === target.parentId) continue;
      if (
        !absoluteAncestors(widgets, widget.parentId) ||
        !absoluteAncestors(widgets, target.parentId)
      )
        return '跨容器移动需要绝对布局，请先调整自动布局 / Reparenting requires absolute layout';
      if (
        !widget.resourceScopeId &&
        scope(widgets, widget.parentId) !== scope(widgets, target.parentId)
      )
        return '移动将改变资源作用域，请先设置显式作用域 / Moving would change the inherited resource scope';
    }
    return undefined;
  });
}

/** Rebuild a preorder list while preserving every unaffected sibling's stacking order. */
function ordered(widgets: Widget[], children: Map<string | undefined, string[]>): Widget[] {
  const byId = new Map(widgets.map((widget) => [widget.id, widget])),
    result: Widget[] = [],
    seen = new Set<string>();
  const visit = (parentId?: string) => {
    for (const id of children.get(parentId) ?? []) {
      if (seen.has(id)) throw new Error('层级存在循环 / Cyclic hierarchy');
      seen.add(id);
      result.push(byId.get(id)!);
      visit(id);
    }
  };
  visit();
  if (result.length !== widgets.length)
    throw new Error('层级存在孤立或循环图层 / Orphaned or cyclic layers');
  return result;
}
function childMap(widgets: Widget[]): Map<string | undefined, string[]> {
  const result = new Map<string | undefined, string[]>();
  for (const widget of widgets)
    result.set(widget.parentId, [...(result.get(widget.parentId) ?? []), widget.id]);
  return result;
}

export function moveWidgets(widgets: Widget[], ids: string[], target: HierarchyTarget): Widget[] {
  const issue = moveIssue(widgets, ids, target);
  if (issue) throw new Error(issue);
  const selected = roots(widgets, ids),
    selectedIds = new Set(selected.map((widget) => widget.id));
  const children = childMap(widgets);
  for (const [parentId, entries] of children)
    children.set(
      parentId,
      entries.filter((id) => !selectedIds.has(id)),
    );
  const siblings = children.get(target.parentId) ?? [],
    index = target.beforeId ? siblings.indexOf(target.beforeId) : siblings.length;
  siblings.splice(index, 0, ...selected.map((widget) => widget.id));
  children.set(target.parentId, siblings);
  const destination = origin(widgets, target.parentId);
  const next = widgets.map((widget) => {
    if (!selectedIds.has(widget.id) || widget.parentId === target.parentId) return widget;
    const source = origin(widgets, widget.parentId),
      copy = {
        ...widget,
        layout: {
          ...widget.layout,
          x: widget.layout.x + source.x - destination.x,
          y: widget.layout.y + source.y - destination.y,
        },
      };
    if (target.parentId) copy.parentId = target.parentId;
    else delete copy.parentId;
    return copy;
  });
  return ordered(next, children);
}

export function groupIssue(widgets: Widget[], ids: string[]): string | undefined {
  return message(() => {
    const issue = structuralIssue(widgets, ids);
    if (issue) return issue;
    const selected = roots(widgets, ids);
    if (selected.length < 2) return '请选择至少两个同级图层 / Select at least two sibling layers';
    if (selected.some((widget) => widget.parentId !== selected[0].parentId))
      return '只能组合同一父容器内的图层 / Group layers with the same parent';
    if (!absoluteAncestors(widgets, selected[0].parentId))
      return '组合需要绝对布局 / Grouping requires absolute layout';
    const width =
      Math.max(...selected.map((widget) => widget.layout.x + widget.layout.width)) -
      Math.min(...selected.map((widget) => widget.layout.x));
    const height =
      Math.max(...selected.map((widget) => widget.layout.y + widget.layout.height)) -
      Math.min(...selected.map((widget) => widget.layout.y));
    if (width > 10000 || height > 10000)
      return '组合尺寸超出工程限制 / Group dimensions exceed project limits';
    return undefined;
  });
}

export function groupWidgets(
  widgets: Widget[],
  ids: string[],
  name = '组合',
): { widgets: Widget[]; groupId: string } {
  const issue = groupIssue(widgets, ids);
  if (issue) throw new Error(issue);
  const selected = roots(widgets, ids),
    selectedIds = new Set(selected.map((widget) => widget.id));
  const x = Math.min(...selected.map((widget) => widget.layout.x)),
    y = Math.min(...selected.map((widget) => widget.layout.y));
  const group = createWidget('panel', x, y);
  group.name = name.trim() || '组合';
  group.layout = {
    x,
    y,
    width: Math.max(...selected.map((widget) => widget.layout.x + widget.layout.width)) - x,
    height: Math.max(...selected.map((widget) => widget.layout.y + widget.layout.height)) - y,
    mode: 'absolute',
  };
  group.style = {};
  group.props.overflow = 'visible';
  if (selected[0].parentId) group.parentId = selected[0].parentId;
  const children = childMap(widgets),
    siblings = children.get(group.parentId)!;
  const highest = siblings.indexOf(selected.at(-1)!.id);
  // The group takes the highest selected layer's slot. Unselected siblings retain their order.
  children.set(
    group.parentId,
    siblings.flatMap((id, index) =>
      index === highest ? [group.id] : selectedIds.has(id) ? [] : [id],
    ),
  );
  children.set(
    group.id,
    selected.map((widget) => widget.id),
  );
  const next = widgets.map((widget) =>
    selectedIds.has(widget.id)
      ? {
          ...widget,
          parentId: group.id,
          layout: { ...widget.layout, x: widget.layout.x - x, y: widget.layout.y - y },
        }
      : widget,
  );
  return { widgets: ordered([...next, group], children), groupId: group.id };
}

function plainContainer(widget: Widget): boolean {
  if (
    widget.type !== 'panel' ||
    widget.resourceScopeId ||
    widget.moduleId ||
    Object.keys(widget.bindings).length ||
    Object.keys(widget.events).length ||
    Object.values(widget.states).some((state) => Object.keys(state).length) ||
    widget.editor?.hidden
  )
    return false;
  if (widget.layout.mode && widget.layout.mode !== 'absolute') return false;
  // Modern panels otherwise default to clipping, which removing the wrapper would change.
  if (widget.definitionVersion !== 2 || widget.props.overflow !== 'visible') return false;
  const allowedProps: Record<string, unknown[]> = {
    enabled: [true],
    visible: [true],
    title: [''],
    overflow: ['visible'],
  };
  if (Object.entries(widget.props).some(([key, value]) => !allowedProps[key]?.includes(value)))
    return false;
  const neutralStyle: Record<string, unknown[]> = {
    background: ['transparent', 'none'],
    backgroundColor: ['transparent'],
    borderWidth: [0, '0', '0px'],
    borderRadius: [0, '0', '0px'],
    padding: [0, '0', '0px'],
    opacity: [1],
    boxShadow: ['none'],
  };
  return Object.entries(widget.style).every(([key, value]) => neutralStyle[key]?.includes(value));
}

export function ungroupIssue(widgets: Widget[], ids: string[]): string | undefined {
  return message(() => {
    const issue = structuralIssue(widgets, ids);
    if (issue) return issue;
    for (const widget of roots(widgets, ids)) {
      if (!plainContainer(widget))
        return '仅可取消组合透明、无行为和作用域的绝对布局容器 / Ungrouping requires a plain transparent absolute container';
      if (!absoluteAncestors(widgets, widget.parentId))
        return '自动布局中的组合无法无损展开 / Cannot safely ungroup inside automatic layout';
      if (!widgets.some((child) => child.parentId === widget.id))
        return '此容器没有可展开的子图层 / This container has no child layers';
    }
    return undefined;
  });
}

export function ungroupWidgets(
  widgets: Widget[],
  ids: string[],
): { widgets: Widget[]; selectedIds: string[] } {
  const issue = ungroupIssue(widgets, ids);
  if (issue) throw new Error(issue);
  const selected = roots(widgets, ids),
    removed = new Set(selected.map((widget) => widget.id)),
    byId = new Map(selected.map((widget) => [widget.id, widget]));
  const children = childMap(widgets),
    selectedIds: string[] = [];
  for (const group of selected) {
    const direct = children.get(group.id)!;
    selectedIds.push(...direct);
    children.set(
      group.parentId,
      children.get(group.parentId)!.flatMap((id) => (id === group.id ? direct : [id])),
    );
    children.delete(group.id);
  }
  const next = widgets
    .filter((widget) => !removed.has(widget.id))
    .map((widget) => {
      const group = widget.parentId ? byId.get(widget.parentId) : undefined;
      if (!group) return widget;
      const copy = {
        ...widget,
        layout: {
          ...widget.layout,
          x: widget.layout.x + group.layout.x,
          y: widget.layout.y + group.layout.y,
        },
      };
      if (group.parentId) copy.parentId = group.parentId;
      else delete copy.parentId;
      return copy;
    });
  return { widgets: ordered(next, children), selectedIds };
}
