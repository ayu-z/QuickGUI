import type { Locale, Widget } from '../core/types';
import { groupIssue, ungroupIssue } from '../core/hierarchy';

export interface Point {
  x: number;
  y: number;
}
export interface WidgetPatch {
  id: string;
  patch: Partial<Widget>;
}
export type DesignerCommand =
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'group'
  | 'ungroup'
  | 'delete'
  | 'select-all'
  | 'clear-selection'
  | 'undo'
  | 'redo'
  | 'front'
  | 'back'
  | 'raise'
  | 'lower'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-top'
  | 'align-middle'
  | 'align-bottom'
  | 'distribute-x'
  | 'distribute-y'
  | 'lock'
  | 'unlock'
  | 'hide'
  | 'show';
export interface CommandItem {
  id: DesignerCommand;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  divider?: boolean;
  reason?: string;
}

export function inheritedFlag(
  widget: Widget,
  widgets: Widget[],
  flag: 'locked' | 'hidden',
): boolean {
  const seen = new Set<string>();
  let current: Widget | undefined = widget;
  while (current && !seen.has(current.id)) {
    if (current.editor?.[flag]) return true;
    seen.add(current.id);
    current = widgets.find((item) => item.id === current?.parentId);
  }
  return false;
}
export function selectionRoots(widgets: Widget[], ids: string[]): Widget[] {
  const selected = new Set(ids);
  return widgets.filter((widget) => {
    if (!selected.has(widget.id)) return false;
    let parent = widget.parentId;
    const seen = new Set([widget.id]);
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) return false;
      seen.add(parent);
      parent = widgets.find((item) => item.id === parent)?.parentId;
    }
    return true;
  });
}
export function canArrange(widgets: Widget[], ids: string[], minimum = 2): boolean {
  const roots = selectionRoots(widgets, ids);
  if (
    roots.length < minimum ||
    roots.some(
      (item) => inheritedFlag(item, widgets, 'locked') || inheritedFlag(item, widgets, 'hidden'),
    )
  )
    return false;
  if (roots.some((item) => item.parentId !== roots[0].parentId)) return false;
  const mode = widgets.find((item) => item.id === roots[0].parentId)?.layout.mode;
  return !mode || mode === 'absolute';
}
export function arrangementPatches(
  widgets: Widget[],
  ids: string[],
  command: DesignerCommand,
): WidgetPatch[] {
  if (!canArrange(widgets, ids, command.startsWith('distribute') ? 3 : 2)) return [];
  const roots = selectionRoots(widgets, ids);
  const left = Math.min(...roots.map((w) => w.layout.x)),
    top = Math.min(...roots.map((w) => w.layout.y));
  const right = Math.max(...roots.map((w) => w.layout.x + w.layout.width)),
    bottom = Math.max(...roots.map((w) => w.layout.y + w.layout.height));
  if (command === 'distribute-x' || command === 'distribute-y') {
    const x = command === 'distribute-x',
      position = x ? 'x' : 'y',
      size = x ? 'width' : 'height';
    const sorted = [...roots].sort((a, b) => a.layout[position] - b.layout[position]);
    const start = x ? left : top,
      end = x ? right : bottom;
    const gap =
      (end - start - sorted.reduce((sum, w) => sum + w.layout[size], 0)) / (sorted.length - 1);
    let cursor = start;
    return sorted.map((widget) => {
      const patch = {
        id: widget.id,
        patch: { layout: { ...widget.layout, [position]: Math.round(cursor * 100) / 100 } },
      };
      cursor += widget.layout[size] + gap;
      return patch;
    });
  }
  return roots.map((widget) => {
    let { x, y } = widget.layout;
    if (command === 'align-left') x = left;
    if (command === 'align-center') x = (left + right - widget.layout.width) / 2;
    if (command === 'align-right') x = right - widget.layout.width;
    if (command === 'align-top') y = top;
    if (command === 'align-middle') y = (top + bottom - widget.layout.height) / 2;
    if (command === 'align-bottom') y = bottom - widget.layout.height;
    return { id: widget.id, patch: { layout: { ...widget.layout, x, y } } };
  });
}
export function reorderedWidgets(
  widgets: Widget[],
  ids: string[],
  command: 'front' | 'back' | 'raise' | 'lower',
): Widget[] {
  const roots = selectionRoots(widgets, ids),
    selected = new Set(roots.map((item) => item.id));
  if (
    !roots.length ||
    roots.some(
      (item) => item.parentId !== roots[0].parentId || inheritedFlag(item, widgets, 'locked'),
    )
  )
    return widgets;
  let siblings = widgets.filter((item) => item.parentId === roots[0].parentId);
  if (command === 'front')
    siblings = [
      ...siblings.filter((w) => !selected.has(w.id)),
      ...siblings.filter((w) => selected.has(w.id)),
    ];
  if (command === 'back')
    siblings = [
      ...siblings.filter((w) => selected.has(w.id)),
      ...siblings.filter((w) => !selected.has(w.id)),
    ];
  if (command === 'raise')
    for (let i = siblings.length - 2; i >= 0; i--)
      if (selected.has(siblings[i].id) && !selected.has(siblings[i + 1].id))
        [siblings[i], siblings[i + 1]] = [siblings[i + 1], siblings[i]];
  if (command === 'lower')
    for (let i = 1; i < siblings.length; i++)
      if (selected.has(siblings[i].id) && !selected.has(siblings[i - 1].id))
        [siblings[i], siblings[i - 1]] = [siblings[i - 1], siblings[i]];
  let index = 0;
  return widgets.map((widget) =>
    widget.parentId === roots[0].parentId ? siblings[index++] : widget,
  );
}
export function commandItems(
  widgets: Widget[],
  ids: string[],
  locale: Locale,
  options: { copy?: boolean; cut?: boolean; paste?: boolean; undo?: boolean; redo?: boolean } = {},
): CommandItem[] {
  const zh = locale === 'zh-CN',
    roots = selectionRoots(widgets, ids),
    empty = !roots.length;
  const locked = roots.some((item) => inheritedFlag(item, widgets, 'locked'));
  const mutable = !empty && !locked,
    sameParent = roots.every((item) => item.parentId === roots[0]?.parentId);
  const groupingIssue = groupIssue(widgets, ids),
    ungroupingIssue = ungroupIssue(widgets, ids);
  const item = (
    id: DesignerCommand,
    chinese: string,
    english: string,
    disabled = false,
    shortcut?: string,
    divider = false,
  ): CommandItem => ({ id, label: zh ? chinese : english, disabled, shortcut, divider });
  return [
    item('copy', '复制', 'Copy', empty || !options.copy, '⌘/Ctrl C'),
    item('cut', '剪切', 'Cut', !mutable || !options.cut, '⌘/Ctrl X'),
    item('paste', '粘贴', 'Paste', !options.paste, '⌘/Ctrl V'),
    item('duplicate', '创建副本', 'Duplicate', !mutable, '⌘/Ctrl D'),
    item('delete', '删除', 'Delete', !mutable, 'Delete'),
    {
      ...item('group', '组合所选图层', 'Group selection', !!groupingIssue, '⌘/Ctrl G', true),
      reason: groupingIssue,
    },
    {
      ...item('ungroup', '取消组合', 'Ungroup', !!ungroupingIssue, '⌘/Ctrl ⇧G'),
      reason: ungroupingIssue,
    },
    item('select-all', '全选', 'Select all', !widgets.length, '⌘/Ctrl A', true),
    item('clear-selection', '取消选择', 'Clear selection', empty, 'Esc'),
    item('front', '置于顶层', 'Bring to front', !mutable || !sameParent, undefined, true),
    item('raise', '上移一层', 'Bring forward', !mutable || !sameParent),
    item('lower', '下移一层', 'Send backward', !mutable || !sameParent),
    item('back', '置于底层', 'Send to back', !mutable || !sameParent),
    ...(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map((edge, index) =>
      item(
        `align-${edge}`,
        ['左对齐', '水平居中', '右对齐', '顶部对齐', '垂直居中', '底部对齐'][index],
        ['Align left', 'Align center', 'Align right', 'Align top', 'Align middle', 'Align bottom'][
          index
        ],
        !canArrange(widgets, ids),
        undefined,
        index === 0,
      ),
    ),
    item('distribute-x', '水平等间距', 'Distribute horizontally', !canArrange(widgets, ids, 3)),
    item('distribute-y', '垂直等间距', 'Distribute vertically', !canArrange(widgets, ids, 3)),
    item(
      locked ? 'unlock' : 'lock',
      locked ? '解除锁定' : '锁定',
      locked ? 'Unlock' : 'Lock',
      empty,
      undefined,
      true,
    ),
    item(
      roots.some((w) => w.editor?.hidden) ? 'show' : 'hide',
      roots.some((w) => w.editor?.hidden) ? '在设计器中显示' : '在设计器中隐藏',
      roots.some((w) => w.editor?.hidden) ? 'Show in designer' : 'Hide in designer',
      empty,
    ),
    item('undo', '撤销', 'Undo', !options.undo, '⌘/Ctrl Z', true),
    item('redo', '重做', 'Redo', !options.redo, '⌘/Ctrl ⇧Z'),
  ];
}
export function commandForKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): DesignerCommand | null {
  if (event.altKey) return null;
  if (event.metaKey || event.ctrlKey) {
    const key = event.key.toLowerCase();
    return (
      (
        {
          c: 'copy',
          x: 'cut',
          v: 'paste',
          d: 'duplicate',
          g: event.shiftKey ? 'ungroup' : 'group',
          a: 'select-all',
          z: event.shiftKey ? 'redo' : 'undo',
          y: 'redo',
        } as Record<string, DesignerCommand>
      )[key] ?? null
    );
  }
  return event.key === 'Delete' || event.key === 'Backspace'
    ? 'delete'
    : event.key === 'Escape'
      ? 'clear-selection'
      : null;
}
export function isEditingText(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      'input,textarea,select,[contenteditable="true"],.monaco-editor,[role="dialog"],[role="menu"]',
    )
  );
}
