import { useState } from 'react';
import { Box, ChevronRight, Eye, EyeOff, Lock, Unlock, Puzzle, Square, Type } from 'lucide-react';
import type { Locale, Widget } from '../core/types';
import { ContextMenu } from './ContextMenu';
import { commandItems, inheritedFlag, type DesignerCommand, type Point } from './commands';

export function LayerTree({
  widgets,
  selectedIds,
  filter,
  locale,
  onSelectionChange,
  onCommand,
  canUndo,
  canRedo,
  onCopy,
  onCut,
  onPaste,
}: {
  widgets: Widget[];
  selectedIds: string[];
  filter: string;
  locale: Locale;
  onSelectionChange: (ids: string[], primary?: string | null) => void;
  onCommand: (command: DesignerCommand) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [menu, setMenu] = useState<Point | null>(null);
  const zh = locale === 'zh-CN';
  const matching = new Set(
    widgets
      .filter((w) => !filter || w.name.toLowerCase().includes(filter.toLowerCase()))
      .map((w) => w.id),
  );
  for (const id of [...matching]) {
    let parent = widgets.find((w) => w.id === id)?.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      matching.add(parent);
      seen.add(parent);
      parent = widgets.find((w) => w.id === parent)?.parentId;
    }
  }
  const visible: Widget[] = [];
  const select = (id: string, toggle = false) =>
    onSelectionChange(
      toggle
        ? selectedIds.includes(id)
          ? selectedIds.filter((item) => item !== id)
          : [...selectedIds, id]
        : [id],
      id,
    );
  const render = (parentId?: string, depth = 0): React.ReactNode =>
    widgets
      .filter((w) => w.parentId === parentId && matching.has(w.id))
      .map((widget) => {
        visible.push(widget);
        const children = widgets.some((w) => w.parentId === widget.id),
          open = !!filter || !collapsed.has(widget.id),
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
        return (
          <div
            key={widget.id}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={children ? open : undefined}
            aria-selected={selected}
          >
            <div
              className={`qg-tree-row ${selected ? 'selected' : ''} ${hidden ? 'editor-hidden' : ''}`}
              style={{ paddingLeft: 7 + depth * 13 }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!selected) select(widget.id);
                setMenu({ x: event.clientX, y: event.clientY });
              }}
            >
              <button
                className={`qg-tree-toggle ${children ? '' : 'empty'}`}
                aria-label={`${open ? (zh ? '折叠' : 'Collapse') : zh ? '展开' : 'Expand'} ${widget.name}`}
                disabled={!children}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(widget.id)) next.delete(widget.id);
                    else next.add(widget.id);
                    return next;
                  })
                }
              >
                <ChevronRight size={11} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
              </button>
              <button
                className={`layer-row ${selected ? 'selected' : ''}`}
                data-layer-id={widget.id}
                onClick={(event) =>
                  select(widget.id, event.shiftKey || event.ctrlKey || event.metaKey)
                }
                title={widget.name}
              >
                <Icon size={12} />
                <span>{widget.name}</span>
                {Object.keys(widget.bindings).length > 0 && <i className="binding-dot" />}
              </button>
              <button
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
            {children && open && <div role="group">{render(widget.id, depth + 1)}</div>}
          </div>
        );
      });
  return (
    <div
      className="layer-list qg-layer-tree"
      role="tree"
      aria-label={zh ? '图层' : 'Layers'}
      aria-multiselectable="true"
      onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const current = widgets.find((widget) => widget.id === selectedIds.at(-1));
        if (current && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          const children = widgets.filter((widget) => widget.parentId === current.id);
          if (event.key === 'ArrowLeft' && children.length && !collapsed.has(current.id)) {
            setCollapsed((previous) => new Set([...previous, current.id]));
            return;
          }
          if (event.key === 'ArrowRight' && children.length && collapsed.has(current.id)) {
            setCollapsed((previous) => {
              const next = new Set(previous);
              next.delete(current.id);
              return next;
            });
            return;
          }
          const target =
            event.key === 'ArrowLeft'
              ? widgets.find((widget) => widget.id === current.parentId)
              : children[0];
          if (target) {
            select(target.id);
            event.currentTarget
              .querySelector<HTMLButtonElement>(`[data-layer-id="${CSS.escape(target.id)}"]`)
              ?.focus();
          }
          return;
        }
        const index = visible.findIndex((w) => w.id === selectedIds.at(-1));
        const next =
          visible[
            Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
          ];
        if (next) {
          select(next.id, event.shiftKey);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-layer-id="${CSS.escape(next.id)}"]`)
            ?.focus();
        }
      }}
    >
      {render()}
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
