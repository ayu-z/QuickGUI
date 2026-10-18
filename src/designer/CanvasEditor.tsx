import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Grid3X3, Magnet, Minus, Plus, Maximize, MousePointer2, Monitor, Hand } from 'lucide-react';
import type { Project, RuntimeValue, Widget, WidgetType } from '../core/types';
import { WidgetView } from '../runtime/WidgetRenderer';
import { WIDGET_CATALOG } from './Library';
import { ContextMenu } from './ContextMenu';
import {
  commandItems,
  inheritedFlag,
  isEditingText,
  selectionRoots,
  type DesignerCommand,
  type Point,
  type WidgetPatch,
} from './commands';
import './designer.css';

export interface CanvasEditorProps {
  project: Project;
  selectedId?: string | null;
  selectedIds?: string[];
  scopeKey?: string;
  onSelect: (id: string | null) => void;
  onSelectionChange?: (ids: string[], primary?: string | null) => void;
  onUpdate: (widgetId: string, patch: Partial<Widget>) => void;
  onUpdateMany?: (patches: WidgetPatch[]) => void;
  onBeginTransaction?: (label: string) => void;
  onCommitTransaction?: () => void;
  onCancelTransaction?: () => void;
  onCommand?: (command: DesignerCommand, point?: Point) => void;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: (point?: Point) => void;
  onRequestUpgrade?: (reason: string) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onAdd: (type: WidgetType, x?: number, y?: number) => void;
  renderWidget?: (widget: Widget) => ReactNode;
  heading?: ReactNode;
}
interface View {
  zoom: number;
  x: number;
  y: number;
}
type Direction = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
type Gesture = {
  kind: 'move' | 'resize' | 'pan' | 'marquee';
  owner: HTMLDivElement;
  pointer: number;
  start: Point;
  view: View;
  layouts: { id: string; layout: Widget['layout'] }[];
  direction?: Direction;
  additive: string[];
  moved: boolean;
  last: string;
};
const MIN_ZOOM = 0.1,
  MAX_ZOOM = 8;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function resizeLayout(
  layout: Widget['layout'],
  direction: Direction,
  dx: number,
  dy: number,
  aspect: boolean,
  step: number,
): Widget['layout'] {
  const west = direction.includes('w'),
    east = direction.includes('e'),
    north = direction.includes('n'),
    south = direction.includes('s');
  const horizontal = west || east,
    vertical = north || south;
  const round = (value: number) => Math.round(value / step) * step;
  const right = layout.x + layout.width,
    bottom = layout.y + layout.height;
  const centerX = layout.x + layout.width / 2,
    centerY = layout.y + layout.height / 2;
  let width = horizontal ? round(layout.width + (east ? dx : -dx)) : layout.width;
  let height = vertical ? round(layout.height + (south ? dy : -dy)) : layout.height;
  if (aspect) {
    const primaryX =
      horizontal &&
      (!vertical || Math.abs(width / layout.width - 1) >= Math.abs(height / layout.height - 1));
    const requested = primaryX ? width / layout.width : height / layout.height;
    const minimum = Math.max(20 / layout.width, 20 / layout.height);
    const maximum = Math.min(
      west ? right / layout.width : !horizontal ? (centerX * 2) / layout.width : Infinity,
      north ? bottom / layout.height : !vertical ? (centerY * 2) / layout.height : Infinity,
    );
    const scale = Math.min(maximum, Math.max(minimum, requested));
    width = layout.width * scale;
    height = layout.height * scale;
  } else {
    width = Math.min(west ? right : Infinity, Math.max(20, width));
    height = Math.min(north ? bottom : Infinity, Math.max(20, height));
  }
  const x = west ? right - width : aspect && !horizontal ? centerX - width / 2 : layout.x;
  const y = north ? bottom - height : aspect && !vertical ? centerY - height / 2 : layout.y;
  return {
    ...layout,
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

export function CanvasEditor({
  project,
  selectedId,
  selectedIds,
  scopeKey,
  onSelect,
  onSelectionChange,
  onUpdate,
  onUpdateMany,
  onBeginTransaction,
  onCommitTransaction,
  onCancelTransaction,
  onCommand,
  onCopy,
  onCut,
  onPaste,
  onRequestUpgrade,
  canUndo,
  canRedo,
  onAdd,
  renderWidget,
  heading,
}: CanvasEditorProps) {
  const viewportRef = useRef<HTMLDivElement>(null),
    artboardRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null),
    space = useRef(false),
    nudge = useRef(false);
  const [view, setView] = useState<View>({ zoom: 0.7, x: 55, y: 65 }),
    viewRef = useRef(view);
  const [grid, setGrid] = useState(true),
    [snap, setSnap] = useState(true),
    [dragOver, setDragOver] = useState(false),
    [panning, setPanning] = useState(false);
  const [marquee, setMarquee] = useState<{ start: Point; end: Point } | null>(null);
  const [menu, setMenu] = useState<{ screen: Point; world: Point } | null>(null);
  const ids = selectedIds ?? (selectedId ? [selectedId] : []),
    zh = project.locale === 'zh-CN',
    width = project.window.width,
    height = project.window.height;
  const storageKey = `quickgui.canvas-view.v1/${scopeKey ?? project.id}`;
  const callbacks = useRef({
    onUpdate,
    onUpdateMany,
    onSelectionChange,
    onSelect,
    onBeginTransaction,
    onCommitTransaction,
    onCancelTransaction,
  });
  callbacks.current = {
    onUpdate,
    onUpdateMany,
    onSelectionChange,
    onSelect,
    onBeginTransaction,
    onCommitTransaction,
    onCancelTransaction,
  };
  const changeView = (next: View) => {
    viewRef.current = next;
    setView(next);
  };
  const select = (next: string[], primary?: string | null) =>
    onSelectionChange ? onSelectionChange(next, primary) : onSelect(primary ?? next.at(-1) ?? null);
  const update = (patches: WidgetPatch[]) => {
    if (onUpdateMany) onUpdateMany(patches);
    else patches.forEach(({ id, patch }) => onUpdate(id, patch));
  };
  const fit = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const zoom = clamp(
      Math.min((viewport.clientWidth - 100) / width, (viewport.clientHeight - 100) / height, 1),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    changeView({
      zoom,
      x: (viewport.clientWidth - width * zoom) / 2,
      y: (viewport.clientHeight - height * zoom) / 2,
    });
  };
  const zoomAt = (zoom: number, anchor?: Point) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const previous = viewRef.current,
      point = anchor ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM),
      ratio = next / previous.zoom;
    changeView({
      zoom: next,
      x: point.x - (point.x - previous.x) * ratio,
      y: point.y - (point.y - previous.y) * ratio,
    });
  };
  const local = (event: { clientX: number; clientY: number }) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const world = (point: Point) => ({
    x: (point.x - viewRef.current.x) / viewRef.current.zoom,
    y: (point.y - viewRef.current.y) / viewRef.current.zoom,
  });
  useLayoutEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (
        saved &&
        [saved.zoom, saved.x, saved.y].every(Number.isFinite) &&
        saved.zoom >= MIN_ZOOM &&
        saved.zoom <= MAX_ZOOM
      ) {
        changeView(saved);
        setGrid(saved.grid !== false);
        setSnap(saved.snap !== false);
        return;
      }
    } catch {
      /* A broken view preference never affects project data. */
    }
    fit();
  }, [storageKey]);
  const dimensions = useRef({ width, height });
  useLayoutEffect(() => {
    if (dimensions.current.width !== width || dimensions.current.height !== height) {
      dimensions.current = { width, height };
      fit();
    }
  }, [width, height]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ ...view, grid, snap }));
      } catch {
        /* View preferences may be unavailable. */
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [view, grid, snap, storageKey]);
  useEffect(() => {
    const viewport = viewportRef.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (gesture.current) return;
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      const rect = viewport.getBoundingClientRect();
      zoomAt(viewRef.current.zoom * Math.exp(-clamp(delta, -250, 250) * 0.002), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, []);
  const finish = (commit: boolean) => {
    const current = gesture.current;
    gesture.current = null;
    setMarquee(null);
    setPanning(false);
    if (!current) return;
    if (current.kind === 'move' || current.kind === 'resize') {
      if (commit) callbacks.current.onCommitTransaction?.();
      else callbacks.current.onCancelTransaction?.();
    }
    if (current.kind === 'pan' && !commit) changeView(current.view);
    if (current.owner.hasPointerCapture(current.pointer))
      current.owner.releasePointerCapture(current.pointer);
  };
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (gesture.current || nudge.current)) {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        if (nudge.current) {
          callbacks.current.onCancelTransaction?.();
          nudge.current = false;
        }
        return;
      }
      if (
        event.code === 'Space' &&
        !isEditingText(event.target) &&
        event.target instanceof Element &&
        event.target.closest('.qg-canvas-viewport')
      ) {
        event.preventDefault();
        space.current = true;
        setPanning(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        space.current = false;
        if (gesture.current?.kind !== 'pan') setPanning(false);
      }
    };
    const blur = () => {
      space.current = false;
      finish(false);
      if (nudge.current) {
        nudge.current = false;
        callbacks.current.onCancelTransaction?.();
      }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
      if (gesture.current?.kind === 'move' || gesture.current?.kind === 'resize' || nudge.current)
        callbacks.current.onCancelTransaction?.();
    };
  }, []);
  const begin = (
    event: PointerEvent<HTMLDivElement>,
    kind: Gesture['kind'],
    layouts: Gesture['layouts'] = [],
    direction?: Direction,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (kind === 'resize')
      event.currentTarget.closest<HTMLElement>('[data-design-widget]')?.focus();
    else event.currentTarget.focus();
    gesture.current = {
      kind,
      owner: event.currentTarget,
      pointer: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      view: { ...viewRef.current },
      layouts,
      direction,
      additive: event.shiftKey ? [...ids] : [],
      moved: false,
      last: '',
    };
    if (kind === 'move' || kind === 'resize')
      onBeginTransaction?.(kind === 'move' ? 'Move widgets' : 'Resize widget');
    if (kind === 'pan') setPanning(true);
  };
  const startWidget = (
    event: PointerEvent<HTMLDivElement>,
    widget: Widget,
    direction?: Direction,
  ) => {
    if (event.button !== 0 || inheritedFlag(widget, project.widgets, 'locked')) return;
    if (!direction && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.stopPropagation();
      event.preventDefault();
      select(
        ids.includes(widget.id) ? ids.filter((id) => id !== widget.id) : [...ids, widget.id],
        widget.id,
      );
      return;
    }
    const next = ids.includes(widget.id) ? ids : [widget.id];
    if (!ids.includes(widget.id)) select(next, widget.id);
    const roots = direction ? [widget] : selectionRoots(project.widgets, next);
    if (
      roots.some(
        (item) =>
          inheritedFlag(item, project.widgets, 'locked') ||
          inheritedFlag(item, project.widgets, 'hidden'),
      )
    )
      return;
    const automatic = roots.some((item) => {
      const parent = project.widgets.find((w) => w.id === item.parentId);
      return parent?.layout.mode && parent.layout.mode !== 'absolute';
    });
    if (!direction && automatic) {
      event.stopPropagation();
      event.currentTarget.focus();
      return;
    }
    begin(
      event,
      direction ? 'resize' : 'move',
      roots.map((item) => ({ id: item.id, layout: { ...item.layout } })),
      direction,
    );
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const dx = (event.clientX - current.start.x) / current.view.zoom,
      dy = (event.clientY - current.start.y) / current.view.zoom;
    current.moved ||=
      Math.abs(event.clientX - current.start.x) + Math.abs(event.clientY - current.start.y) > 2;
    if (current.kind === 'pan') {
      changeView({
        ...current.view,
        x: current.view.x + event.clientX - current.start.x,
        y: current.view.y + event.clientY - current.start.y,
      });
      return;
    }
    if (current.kind === 'marquee') {
      const start = local({ clientX: current.start.x, clientY: current.start.y }),
        end = local(event);
      setMarquee({ start, end });
      const left = Math.min(current.start.x, event.clientX),
        right = Math.max(current.start.x, event.clientX),
        top = Math.min(current.start.y, event.clientY),
        bottom = Math.max(current.start.y, event.clientY);
      const hits = [...artboardRef.current!.querySelectorAll<HTMLElement>('[data-design-widget]')]
        .filter((element) => {
          const widget = project.widgets.find((w) => w.id === element.dataset.designWidget)!;
          const r = element.getBoundingClientRect();
          return (
            !inheritedFlag(widget, project.widgets, 'locked') &&
            !inheritedFlag(widget, project.widgets, 'hidden') &&
            r.left >= left &&
            r.right <= right &&
            r.top >= top &&
            r.bottom <= bottom
          );
        })
        .map((element) => element.dataset.designWidget!);
      if (current.moved)
        select(
          selectionRoots(project.widgets, [...new Set([...current.additive, ...hits])]).map(
            (w) => w.id,
          ),
        );
      return;
    }
    if (!current.moved) return;
    let patches: WidgetPatch[];
    if (current.kind === 'resize') {
      const item = current.layouts[0];
      patches = [
        {
          id: item.id,
          patch: {
            layout: resizeLayout(
              item.layout,
              current.direction!,
              dx,
              dy,
              event.shiftKey,
              snap ? 8 : 1,
            ),
          },
        },
      ];
    } else {
      const anchor = current.layouts[0]?.layout;
      if (!anchor) return;
      const sx = snap ? Math.round((anchor.x + dx) / 8) * 8 - anchor.x : Math.round(dx),
        sy = snap ? Math.round((anchor.y + dy) / 8) * 8 - anchor.y : Math.round(dy);
      const x = Math.max(sx, -Math.min(...current.layouts.map((w) => w.layout.x))),
        y = Math.max(sy, -Math.min(...current.layouts.map((w) => w.layout.y)));
      patches = current.layouts.map((item) => ({
        id: item.id,
        patch: { layout: { ...item.layout, x: item.layout.x + x, y: item.layout.y + y } },
      }));
    }
    const signature = JSON.stringify(patches);
    if (signature === current.last) return;
    current.last = signature;
    update(patches);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (current.kind === 'marquee' && !current.moved && !event.shiftKey) select([]);
    finish(true);
  };
  const keys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isEditingText(event.target)) return;
    const directions: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const d = directions[event.key];
    if (!d) return;
    event.preventDefault();
    event.stopPropagation();
    const roots = selectionRoots(project.widgets, ids);
    if (
      !roots.length ||
      roots.some(
        (w) =>
          inheritedFlag(w, project.widgets, 'locked') ||
          inheritedFlag(w, project.widgets, 'hidden') ||
          ['flex', 'grid'].includes(
            project.widgets.find((p) => p.id === w.parentId)?.layout.mode ?? '',
          ),
      )
    )
      return;
    if (!nudge.current) {
      onBeginTransaction?.('Nudge widgets');
      nudge.current = true;
    }
    const step = event.shiftKey ? 10 : 1;
    const dx = Math.max(d.x * step, -Math.min(...roots.map((w) => w.layout.x))),
      dy = Math.max(d.y * step, -Math.min(...roots.map((w) => w.layout.y)));
    update(
      roots.map((w) => ({
        id: w.id,
        patch: { layout: { ...w.layout, x: w.layout.x + dx, y: w.layout.y + dy } },
      })),
    );
  };
  const initialValues: Record<string, RuntimeValue> = {};
  for (const variable of project.variables) {
    const value: RuntimeValue = { value: variable.initial, quality: 'good', timestamp: 0 };
    initialValues[variable.id] = value;
    initialValues[variable.name] = value;
  }
  const themeVariables = Object.fromEntries(
    Object.entries(project.theme.tokens).map(([key, value]) => [
      `--qg-${key.replace('color.', '')}`,
      value,
    ]),
  );
  const renderTree = (parentId?: string): ReactNode => {
    const parent = project.widgets.find((w) => w.id === parentId),
      automatic = !!parent?.layout.mode && parent.layout.mode !== 'absolute';
    return project.widgets
      .filter((w) => w.parentId === parentId && !w.editor?.hidden)
      .map((widget) => {
        const locked = inheritedFlag(widget, project.widgets, 'locked'),
          selected = ids.includes(widget.id);
        return (
          <div
            key={widget.id}
            data-design-widget={widget.id}
            tabIndex={locked ? -1 : 0}
            role="button"
            aria-label={`${zh ? '选择' : 'Select'} ${widget.name}`}
            aria-disabled={locked}
            className={`qg-design-widget ${selected ? 'is-selected' : ''} ${locked ? 'is-locked' : ''}`}
            style={{
              position: automatic ? 'relative' : 'absolute',
              left: automatic ? undefined : widget.layout.x,
              top: automatic ? undefined : widget.layout.y,
              width: widget.layout.width,
              height: widget.layout.height,
              flexShrink: 0,
              outlineWidth: 1.5 / view.zoom,
            }}
            onPointerDown={(event) => startWidget(event, widget)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={() => finish(false)}
            onLostPointerCapture={(event) => {
              if (gesture.current?.owner === event.currentTarget) finish(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                select([widget.id], widget.id);
              } else keys(event);
            }}
          >
            <div
              className={`qg-design-widget-content ${widget.definitionVersion === 2 ? 'qg-modern-design-content' : ''}`}
            >
              {renderWidget ? (
                renderWidget(widget)
              ) : (
                <WidgetView
                  widget={widget}
                  project={project}
                  values={initialValues}
                  interactive={false}
                >
                  {widget.definitionVersion === 2 ? renderTree(widget.id) : undefined}
                </WidgetView>
              )}
            </div>
            {(widget.definitionVersion !== 2 || renderWidget) &&
              project.widgets.some((w) => w.parentId === widget.id) && (
                <div
                  className="qg-design-children"
                  style={{
                    display:
                      widget.layout.mode === 'flex'
                        ? 'flex'
                        : widget.layout.mode === 'grid'
                          ? 'grid'
                          : 'block',
                    flexDirection: widget.layout.direction,
                    gridTemplateColumns: `repeat(${widget.layout.columns ?? 2},1fr)`,
                    gap: widget.layout.gap,
                  }}
                >
                  {renderTree(widget.id)}
                </div>
              )}
            {selected && (
              <>
                <span
                  className="qg-selection-label"
                  style={{ transform: `scale(${1 / view.zoom})` }}
                >
                  {widget.name}
                  {locked ? ' · LOCK' : automatic ? ' · AUTO' : ''}
                </span>
                {ids.length === 1 &&
                  !locked &&
                  (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as Direction[]).map((direction) => (
                    <div
                      key={direction}
                      className={`qg-resize-grip ${direction === 'se' ? 'qg-resize-handle' : ''} qg-resize-${direction}`}
                      role="slider"
                      aria-label={`${zh ? '调整大小' : 'Resize'} ${direction}`}
                      aria-valuetext={`${widget.layout.width} × ${widget.layout.height}`}
                      style={{ transform: `scale(${1 / view.zoom})` }}
                      onPointerDown={(event) => startWidget(event, widget, direction)}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerCancel={() => finish(false)}
                      onLostPointerCapture={(event) => {
                        if (gesture.current?.owner === event.currentTarget) finish(false);
                      }}
                    />
                  ))}
              </>
            )}
          </div>
        );
      });
  };
  const execute = (command: DesignerCommand) => {
    if (command === 'copy') {
      onCopy?.();
      return;
    }
    if (command === 'cut') {
      onCut?.();
      return;
    }
    if (command === 'paste') {
      onPaste?.(menu?.world);
      return;
    }
    if (['lock', 'unlock', 'hide', 'show'].includes(command) && project.schemaVersion < 3) {
      onRequestUpgrade?.(command);
      return;
    }
    onCommand?.(command, menu?.world);
  };
  return (
    <div className="qg-canvas-editor">
      <div className="canvas-heading">
        <div className="canvas-heading-context">
          {heading ?? (
            <strong title={project.window.title || project.name}>
              {project.window.title || project.name}
            </strong>
          )}
        </div>
        <div
          className="canvas-heading-tools"
          role="toolbar"
          aria-label={zh ? '画布工具' : 'Canvas tools'}
        >
          <span className="qg-canvas-mode">
            {panning ? <Hand size={14} /> : <MousePointer2 size={14} />}{' '}
            {panning ? (zh ? '平移' : 'Pan') : zh ? '选择' : 'Select'}
          </span>
          <span className="dimension-label">
            <Monitor size={14} />
            {width} × {height}
          </span>
          <div className="qg-toolbar-cluster">
            <button
              className={grid ? 'qg-icon-button active' : 'qg-icon-button'}
              onClick={() => setGrid(!grid)}
              aria-label={zh ? '切换网格' : 'Toggle grid'}
              title={zh ? '网格' : 'Grid'}
              aria-pressed={grid}
            >
              <Grid3X3 size={15} />
            </button>
            <button
              className={snap ? 'qg-icon-button active' : 'qg-icon-button'}
              onClick={() => setSnap(!snap)}
              aria-label={zh ? '切换吸附' : 'Toggle snap'}
              title={zh ? '吸附网格（8px）' : 'Snap to grid (8px)'}
              aria-pressed={snap}
            >
              <Magnet size={15} />
            </button>
            <span className="qg-toolbar-divider" />
            <button
              className="qg-icon-button"
              onClick={() => zoomAt(viewRef.current.zoom - 0.1)}
              aria-label={zh ? '缩小' : 'Zoom out'}
            >
              <Minus size={14} />
            </button>
            <button
              className="qg-zoom-value"
              onClick={() => zoomAt(1)}
              title={zh ? '重置为100%' : 'Reset to 100%'}
            >
              {Math.round(view.zoom * 100)}%
            </button>
            <button
              className="qg-icon-button"
              onClick={() => zoomAt(viewRef.current.zoom + 0.1)}
              aria-label={zh ? '放大' : 'Zoom in'}
            >
              <Plus size={14} />
            </button>
            <button
              className="qg-icon-button"
              onClick={fit}
              aria-label={zh ? '适应画布' : 'Fit canvas'}
              title={zh ? '适应画布' : 'Fit canvas'}
            >
              <Maximize size={14} />
            </button>
          </div>
        </div>
      </div>
      <div
        ref={viewportRef}
        tabIndex={0}
        className={`qg-canvas-viewport qg-interactive-viewport ${grid ? 'show-grid' : ''} ${panning ? 'is-panning' : ''}`}
        onKeyDown={keys}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow') && nudge.current) {
            nudge.current = false;
            onCommitTransaction?.();
          }
        }}
        onBlur={(event) => {
          if (nudge.current && !event.currentTarget.contains(event.relatedTarget as Node)) {
            nudge.current = false;
            onCommitTransaction?.();
          }
        }}
        onPointerDownCapture={(event) => {
          if (event.button === 1 || (event.button === 0 && space.current)) begin(event, 'pan');
        }}
        onPointerDown={(event) => {
          if (
            event.button === 0 &&
            !(event.target as Element).closest('[data-design-widget],[role="menu"]')
          ) {
            begin(event, 'marquee');
            if (!event.shiftKey) select([]);
          }
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={(event) => {
          if (gesture.current?.owner === event.currentTarget) finish(false);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          finish(false);
          const target = (event.target as Element).closest<HTMLElement>('[data-design-widget]');
          if (target && !ids.includes(target.dataset.designWidget!))
            select([target.dataset.designWidget!]);
          setMenu({ screen: { x: event.clientX, y: event.clientY }, world: world(local(event)) });
        }}
      >
        <div
          className="qg-artboard-area"
          style={{
            width: width * view.zoom,
            height: height * view.zoom,
            transform: `translate(${view.x}px,${view.y}px)`,
          }}
        >
          <div className="qg-artboard-caption">
            <span>{project.window.title || project.name}</span>
            <span>{zh ? '画布' : 'CANVAS'}</span>
          </div>
          <div className="qg-artboard-ruler" aria-hidden="true">
            {Array.from({ length: Math.ceil(width / 160) }, (_, i) => (
              <span key={i} style={{ left: i * 160 * view.zoom }}>
                {i * 160}
              </span>
            ))}
          </div>
          <div
            ref={artboardRef}
            className={`qg-artboard ${dragOver ? 'is-drop-target' : ''}`}
            data-testid="design-canvas"
            style={
              {
                ...themeVariables,
                width,
                height,
                transform: `scale(${view.zoom})`,
                background: project.window.background,
                borderRadius: project.window.contentRadius,
                color: 'var(--qg-text)',
              } as CSSProperties
            }
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('application/quickgui-widget')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDragOver(true);
              }
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const type = event.dataTransfer.getData('application/quickgui-widget');
              if (!WIDGET_CATALOG.some((item) => item.type === type)) return;
              const position = world(local(event)),
                step = snap ? 8 : 1;
              onAdd(
                type as WidgetType,
                Math.max(0, Math.round(position.x / step) * step),
                Math.max(0, Math.round(position.y / step) * step),
              );
            }}
          >
            {renderTree()}
            {!project.widgets.length && (
              <div className="qg-canvas-empty">
                <MousePointer2 size={28} />
                <strong>{zh ? '在这里构建你的界面' : 'Build your interface here'}</strong>
                <span>
                  {zh
                    ? '拖入组件 · 滚轮缩放 · 空格拖动画布'
                    : 'Drag in widgets · Wheel to zoom · Space-drag to pan'}
                </span>
              </div>
            )}
          </div>
        </div>
        {marquee && (
          <div
            className="qg-marquee"
            style={{
              left: Math.min(marquee.start.x, marquee.end.x),
              top: Math.min(marquee.start.y, marquee.end.y),
              width: Math.abs(marquee.end.x - marquee.start.x),
              height: Math.abs(marquee.end.y - marquee.start.y),
            }}
          />
        )}
      </div>
      <div className="qg-canvas-status">
        <span>
          <span className="qg-status-dot" />
          {zh ? '设计画布' : 'Design canvas'}
        </span>
        <span>
          {ids.length > 1
            ? `${ids.length} ${zh ? '个已选择' : 'selected'}`
            : (project.widgets.find((w) => w.id === selectedId)?.name ??
              `${project.widgets.length} ${zh ? '个组件' : 'components'}`)}
        </span>
        <span>{zh ? '滚轮缩放 · 空格/中键平移' : 'Wheel zoom · Space/middle drag pan'}</span>
      </div>
      {menu && (
        <ContextMenu
          point={menu.screen}
          items={commandItems(project.widgets, ids, project.locale, {
            copy: !!onCopy,
            cut: !!onCut,
            paste: !!onPaste,
            undo: canUndo,
            redo: canRedo,
          })}
          onCommand={execute}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
export default CanvasEditor;
