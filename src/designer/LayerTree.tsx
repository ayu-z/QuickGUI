import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  Box,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownRight,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Puzzle,
  Square,
  Type,
} from 'lucide-react';
import type { Locale, Widget } from '../core/types';
import { moveIssue, type HierarchyTarget } from '../core/hierarchy';
import { ContextMenu } from './ContextMenu';
import { commandItems, inheritedFlag, type DesignerCommand, type Point } from './commands';
import './layers.css';

const dragType = 'application/x-quickgui-layers';
type Drop = {
  id: string;
  zone: 'before' | 'after' | 'inside' | 'root';
  target: HierarchyTarget;
  issue?: string;
};

export interface LayerTreeProps {
  widgets: Widget[];
  selectedIds: string[];
  filter: string;
  locale: Locale;
  scopeKey?: string;
  onSelectionChange: (ids: string[], primary?: string | null) => void;
  onCommand: (command: DesignerCommand) => void;
  onMove?: (ids: string[], target: HierarchyTarget) => void;
  onRename?: (id: string, name: string) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
}

export function LayerTree({
  widgets,
  selectedIds,
  filter,
  locale,
  scopeKey = 'main',
  onSelectionChange,
  onCommand,
  onMove,
  onRename,
  canUndo,
  canRedo,
  onCopy,
  onCut,
  onPaste,
}: LayerTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | undefined>(selectedIds.at(-1));
  const [menu, setMenu] = useState<Point | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [status, setStatus] = useState('');
  const tree = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | undefined>(selectedIds.at(-1));
  const dragged = useRef<string[]>([]);
  const renameDone = useRef(false);
  const localSelection = useRef<string | null>(null);
  const zh = locale === 'zh-CN',
    query = filter.trim().toLocaleLowerCase();
  const byId = useMemo(() => new Map(widgets.map((widget) => [widget.id, widget])), [widgets]);
  const children = useMemo(() => {
    const result = new Map<string | undefined, Widget[]>();
    for (const widget of widgets)
      result.set(widget.parentId, [...(result.get(widget.parentId) ?? []), widget]);
    return result;
  }, [widgets]);
  const selectionKey = selectedIds.join('\0');
  useEffect(() => {
    setCollapsed(new Set());
    setEditing(null);
    setMenu(null);
    setDrop(null);
    setStatus('');
    setDragging(false);
    dragged.current = [];
    anchor.current = undefined;
    localSelection.current = null;
    setFocused(undefined);
  }, [scopeKey]);
  useEffect(() => {
    const local = localSelection.current === selectionKey;
    localSelection.current = null;
    if (local) return;
    const id = selectedIds.at(-1);
    if (!id || !byId.has(id)) return;
    setFocused(id);
    if (tree.current?.contains(document.activeElement))
      tree.current.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();
  }, [selectionKey, scopeKey]);
  useEffect(() => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      for (const id of selectedIds) {
        let parent = byId.get(id)?.parentId;
        const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          next.delete(parent);
          parent = byId.get(parent)?.parentId;
        }
      }
      return next.size === previous.size ? previous : next;
    });
  }, [selectionKey, byId]);
  useEffect(() => {
    if (drop?.zone !== 'inside' || drop.issue) return;
    const timer = setTimeout(
      () =>
        setCollapsed((previous) => {
          if (!previous.has(drop.id)) return previous;
          const next = new Set(previous);
          next.delete(drop.id);
          return next;
        }),
      600,
    );
    return () => clearTimeout(timer);
  }, [drop?.id, drop?.zone, drop?.issue]);
  const matching = new Set(
    widgets
      .filter((widget) => !query || widget.name.toLocaleLowerCase().includes(query))
      .map((widget) => widget.id),
  );
  for (const id of [...matching]) {
    let parent = byId.get(id)?.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      matching.add(parent);
      parent = byId.get(parent)?.parentId;
    }
  }
  const visible: Widget[] = [];
  const collect = (parentId?: string) => {
    for (const widget of [...(children.get(parentId) ?? [])].reverse()) {
      if (!matching.has(widget.id)) continue;
      visible.push(widget);
      if (query || !collapsed.has(widget.id)) collect(widget.id);
    }
  };
  collect();
  const focusId = visible.some((widget) => widget.id === focused)
    ? focused
    : ([...selectedIds].reverse().find((id) => visible.some((widget) => widget.id === id)) ??
      visible[0]?.id);
  const focusRow = (id: string) => {
    setFocused(id);
    tree.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();
  };
  const select = (
    id: string,
    options: { toggle?: boolean; range?: boolean; additive?: boolean } = {},
  ) => {
    let ids = [id];
    if (options.range) {
      const from = visible.findIndex((widget) => widget.id === anchor.current),
        to = visible.findIndex((widget) => widget.id === id);
      const start =
        from < 0
          ? Math.max(
              0,
              visible.findIndex((widget) => widget.id === focusId),
            )
          : from;
      const range = visible
        .slice(Math.min(start, to), Math.max(start, to) + 1)
        .map((widget) => widget.id);
      ids = options.additive ? [...new Set([...selectedIds, ...range])] : range;
    } else {
      anchor.current = id;
      if (options.toggle)
        ids = selectedIds.includes(id)
          ? selectedIds.filter((item) => item !== id)
          : [...selectedIds, id];
    }
    localSelection.current = ids.join('\0');
    onSelectionChange(ids, ids.includes(id) ? id : (ids.at(-1) ?? null));
    focusRow(id);
  };
  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const startRename = (widget: Widget) => {
    if (!onRename || inheritedFlag(widget, widgets, 'locked')) return;
    renameDone.current = false;
    setEditing({ id: widget.id, value: widget.name });
    setStatus('');
  };
  const commitRename = () => {
    if (!editing || renameDone.current) return;
    const name = editing.value.trim();
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
      setStatus(
        zh ? '图层名称应为 1–200 个有效字符' : 'Enter a layer name of 1–200 valid characters',
      );
      return;
    }
    try {
      onRename?.(editing.id, name);
      renameDone.current = true;
      setEditing(null);
      setStatus('');
      focusRow(editing.id);
    } catch (error) {
      setStatus(String(error));
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target instanceof HTMLInputElement ||
      (event.target as Element).closest('[role="menu"]')
    )
      return;
    const widget = byId.get(focusId ?? '');
    if (!widget) return;
    if (event.key === 'F2') {
      event.preventDefault();
      event.stopPropagation();
      startRename(widget);
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedIds.includes(widget.id)) select(widget.id);
      const rect = tree.current
        ?.querySelector(`[data-tree-id="${CSS.escape(widget.id)}"] > .qg-tree-row`)
        ?.getBoundingClientRect();
      if (rect) setMenu({ x: rect.left + 20, y: rect.bottom });
      return;
    }
    if (
      !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ', 'Enter'].includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === ' ' || event.key === 'Enter') {
      select(widget.id, {
        toggle: event.key === ' ',
        range: event.shiftKey,
        additive: event.ctrlKey || event.metaKey,
      });
      return;
    }
    let target: Widget | undefined;
    const direct = children.get(widget.id) ?? [],
      open = !!query || !collapsed.has(widget.id);
    if (event.key === 'ArrowLeft') {
      if (direct.length && open && !query) {
        toggle(widget.id);
        return;
      }
      target = widget.parentId ? byId.get(widget.parentId) : undefined;
    } else if (event.key === 'ArrowRight') {
      if (direct.length && !open) {
        toggle(widget.id);
        return;
      }
      target = [...direct].reverse().find((entry) => matching.has(entry.id));
    } else {
      const index = visible.findIndex((entry) => entry.id === widget.id);
      target =
        visible[
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? visible.length - 1
              : Math.max(
                  0,
                  Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                )
        ];
    }
    if (target) {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey) focusRow(target.id);
      else select(target.id, { range: event.shiftKey, additive: event.ctrlKey || event.metaKey });
    }
  };
  const dragIds = (event: DragEvent): string[] => {
    if (dragged.current.length) return dragged.current;
    try {
      const data = JSON.parse(event.dataTransfer.getData(dragType));
      return data.scopeKey === scopeKey &&
        Array.isArray(data.ids) &&
        data.ids.every((id: unknown) => typeof id === 'string')
        ? data.ids
        : [];
    } catch {
      return [];
    }
  };
  const dragOver = (event: DragEvent, target: HierarchyTarget, id: string, zone: Drop['zone']) => {
    if (!onMove) return;
    const ids = dragIds(event);
    if (!ids.length) return;
    event.preventDefault();
    event.stopPropagation();
    const issue = moveIssue(widgets, ids, target);
    event.dataTransfer.dropEffect = issue ? 'none' : 'move';
    setDrop((previous) =>
      previous?.id === id && previous.zone === zone && previous.issue === issue
        ? previous
        : { id, zone, target, issue },
    );
  };
  const endDrag = () => {
    dragged.current = [];
    setDrop(null);
    setDragging(false);
  };
  const finishDrop = (event: DragEvent, target: HierarchyTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const ids = dragIds(event),
      issue = ids.length ? moveIssue(widgets, ids, target) : undefined;
    if (issue) setStatus(issue);
    else if (ids.length) {
      try {
        onMove?.(ids, target);
        if (target.parentId)
          setCollapsed((previous) => {
            const next = new Set(previous);
            next.delete(target.parentId!);
            return next;
          });
        setStatus('');
      } catch (error) {
        setStatus(String(error));
      }
    }
    endDrag();
  };
  const rowTarget = (
    event: DragEvent,
    widget: Widget,
  ): { target: HierarchyTarget; zone: Drop['zone'] } => {
    const rect = event.currentTarget.getBoundingClientRect(),
      fraction = (event.clientY - rect.top) / rect.height;
    if (widget.type === 'panel' && fraction > 0.25 && fraction < 0.75)
      return { target: { parentId: widget.id }, zone: 'inside' };
    const siblings = children.get(widget.parentId) ?? [],
      next = siblings[siblings.findIndex((entry) => entry.id === widget.id) + 1];
    if (fraction < 0.5)
      return { target: { parentId: widget.parentId, beforeId: next?.id }, zone: 'before' };
    return { target: { parentId: widget.parentId, beforeId: widget.id }, zone: 'after' };
  };
  const render = (parentId?: string, depth = 0): React.ReactNode =>
    (children.get(parentId) ?? [])
      .filter((widget) => matching.has(widget.id))
      .reverse()
      .map((widget, index, siblings) => {
        const direct = children.get(widget.id) ?? [],
          open = !!query || !collapsed.has(widget.id),
          selected = selectedIds.includes(widget.id),
          locked = inheritedFlag(widget, widgets, 'locked'),
          hidden = inheritedFlag(widget, widgets, 'hidden');
        const Icon =
          widget.type === 'panel'
            ? Box
            : widget.type === 'module'
              ? Puzzle
              : widget.type === 'text'
                ? Type
                : Square;
        const ownDrop = drop?.id === widget.id ? drop : null;
        return (
          <div
            key={widget.id}
            role="treeitem"
            aria-label={widget.name}
            aria-level={depth + 1}
            aria-setsize={siblings.length}
            aria-posinset={index + 1}
            aria-expanded={direct.length ? open : undefined}
            aria-selected={selected}
            tabIndex={focusId === widget.id ? 0 : -1}
            data-tree-id={widget.id}
            onFocus={(event) => {
              if (event.target === event.currentTarget) setFocused(widget.id);
            }}
          >
            <div
              className={`qg-tree-row ${selected ? 'selected' : ''} ${hidden ? 'editor-hidden' : ''} ${ownDrop ? `drop-${ownDrop.zone} ${ownDrop.issue ? 'drop-invalid' : ''}` : ''}`}
              style={{ paddingLeft: 7 + depth * 14 }}
              draggable={!!onMove && !locked && !editing}
              onDragStart={(event) => {
                if (!onMove || locked || editing) {
                  event.preventDefault();
                  return;
                }
                const ids = selected ? selectedIds : [widget.id];
                if (!selected) onSelectionChange(ids, widget.id);
                dragged.current = ids;
                event.dataTransfer.setData(dragType, JSON.stringify({ scopeKey, ids }));
                event.dataTransfer.effectAllowed = 'move';
                setDragging(true);
                setStatus('');
              }}
              onDragEnd={endDrag}
              onDragOver={(event) => {
                const { target, zone } = rowTarget(event, widget);
                dragOver(event, target, widget.id, zone);
              }}
              onDrop={(event) => finishDrop(event, rowTarget(event, widget).target)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!selected) select(widget.id);
                else focusRow(widget.id);
                setMenu({ x: event.clientX, y: event.clientY });
              }}
            >
              <button
                tabIndex={-1}
                className={`qg-tree-toggle ${direct.length ? '' : 'empty'}`}
                aria-label={`${open ? (zh ? '折叠' : 'Collapse') : zh ? '展开' : 'Expand'} ${widget.name}`}
                disabled={!direct.length || !!query}
                onClick={() => {
                  toggle(widget.id);
                  focusRow(widget.id);
                }}
              >
                <ChevronRight size={11} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
              </button>
              {editing?.id === widget.id ? (
                <div className="layer-row qg-layer-rename">
                  <Icon size={12} />
                  <input
                    autoFocus
                    aria-label={zh ? '图层名称' : 'Layer name'}
                    value={editing.value}
                    maxLength={200}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setEditing({ id: widget.id, value: event.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        renameDone.current = true;
                        setEditing(null);
                        setStatus('');
                        focusRow(widget.id);
                      }
                    }}
                  />
                </div>
              ) : (
                <button
                  tabIndex={-1}
                  className={`layer-row ${selected ? 'selected' : ''}`}
                  data-layer-id={widget.id}
                  onClick={(event) =>
                    select(widget.id, {
                      range: event.shiftKey,
                      toggle: event.ctrlKey || event.metaKey,
                      additive: event.ctrlKey || event.metaKey,
                    })
                  }
                  onDoubleClick={() => startRename(widget)}
                  title={widget.name}
                >
                  <Icon size={12} />
                  <span>{widget.name}</span>
                  {Object.keys(widget.bindings).length > 0 && <i className="binding-dot" />}
                </button>
              )}
              <button
                tabIndex={-1}
                className={`qg-tree-action ${locked ? 'on' : ''}`}
                aria-label={`${locked ? (zh ? '解锁' : 'Unlock') : zh ? '锁定' : 'Lock'} ${widget.name}`}
                onClick={() => {
                  onSelectionChange([widget.id], widget.id);
                  onCommand(locked ? 'unlock' : 'lock');
                }}
              >
                {locked ? <Lock size={11} /> : <Unlock size={11} />}
              </button>
              <button
                tabIndex={-1}
                className={`qg-tree-action ${hidden ? 'on' : ''}`}
                aria-label={`${hidden ? (zh ? '显示' : 'Show') : zh ? '隐藏' : 'Hide'} ${widget.name}`}
                onClick={() => {
                  onSelectionChange([widget.id], widget.id);
                  onCommand(hidden ? 'show' : 'hide');
                }}
              >
                {hidden ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </div>
            {direct.length > 0 && open && <div role="group">{render(widget.id, depth + 1)}</div>}
          </div>
        );
      });
  return (
    <div className="qg-layer-panel">
      <div className="qg-layer-toolbar">
        <span>
          {zh ? '图层' : 'Layers'} <small>{widgets.length}</small>
        </span>
        <button
          className="icon-button"
          aria-label={zh ? '展开全部图层' : 'Expand all layers'}
          title={zh ? '展开全部图层' : 'Expand all layers'}
          disabled={!widgets.some((widget) => children.has(widget.id)) || !!query}
          onClick={() => setCollapsed(new Set())}
        >
          <ChevronsUpDown size={13} />
        </button>
        <button
          className="icon-button"
          aria-label={zh ? '收起全部图层' : 'Collapse all layers'}
          title={zh ? '收起全部图层' : 'Collapse all layers'}
          disabled={!widgets.some((widget) => children.has(widget.id)) || !!query}
          onClick={() => {
            setCollapsed(
              new Set(
                widgets.filter((widget) => children.has(widget.id)).map((widget) => widget.id),
              ),
            );
            setFocused(undefined);
          }}
        >
          <ChevronsDownUp size={13} />
        </button>
      </div>
      <div
        ref={tree}
        className="layer-list qg-layer-tree"
        role="tree"
        aria-label={zh ? '图层' : 'Layers'}
        aria-multiselectable="true"
        onKeyDown={keyDown}
      >
        {render()}
        {!visible.length && (
          <div className="qg-layers-empty">
            {query
              ? zh
                ? '没有匹配的图层'
                : 'No matching layers'
              : zh
                ? '从组件库添加控件'
                : 'Add a widget from the library'}
          </div>
        )}
      </div>
      {onMove && (
        <div
          className={`qg-layer-root-drop ${dragging ? 'is-dragging' : ''} ${drop?.zone === 'root' ? (drop.issue ? 'drop-invalid' : 'drop-inside') : ''}`}
          data-layer-root-drop="true"
          onDragOver={(event) => dragOver(event, {}, 'root', 'root')}
          onDrop={(event) => finishDrop(event, {})}
        >
          <CornerDownRight size={12} />
          <span>{zh ? '拖到此处移至窗口根级' : 'Drop here to move to the root'}</span>
        </div>
      )}
      <div className="qg-layer-status" role="status" aria-live="polite">
        {status || (drop?.issue ?? '')}
      </div>
      {menu && (
        <ContextMenu
          point={menu}
          items={commandItems(widgets, selectedIds, locale, {
            copy: !!onCopy,
            cut: !!onCut,
            paste: !!onPaste,
            undo: canUndo,
            redo: canRedo,
          })}
          onCommand={onCommand}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
