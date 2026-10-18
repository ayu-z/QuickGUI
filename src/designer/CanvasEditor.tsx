import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Grid3X3, Magnet, Minus, Plus, Maximize, MousePointer2, Monitor } from 'lucide-react';
import type { Project, RuntimeValue, Widget, WidgetType } from '../core/types';
import { WidgetView } from '../runtime/WidgetRenderer';
import { WIDGET_CATALOG } from './Library';
import './designer.css';

export interface CanvasEditorProps {
  project: Project;
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  onUpdate: (widgetId: string, patch: Partial<Widget>) => void;
  onAdd: (type: WidgetType, x?: number, y?: number) => void;
  renderWidget?: (widget: Widget) => ReactNode;
}

export function CanvasEditor({
  project,
  selectedId,
  onSelect,
  onUpdate,
  onAdd,
  renderWidget,
}: CanvasEditorProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    id: string;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    layout: Widget['layout'];
  } | null>(null);
  const [zoom, setZoom] = useState(0.7);
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const zh = project.locale === 'zh-CN';
  const selected = project.widgets.find((widget) => widget.id === selectedId);
  const width = project.window.width,
    height = project.window.height;
  const fit = () => {
    const viewport = viewportRef.current;
    if (viewport)
      setZoom(
        Math.min(
          1,
          Math.max(
            0.1,
            Math.min((viewport.clientWidth - 110) / width, (viewport.clientHeight - 100) / height),
          ),
        ),
      );
  };
  useEffect(() => {
    fit();
  }, [project.id, width, height]);
  const quantize = (value: number) => Math.round(value / (snap ? 8 : 1)) * (snap ? 8 : 1);
  const startGesture = (
    event: PointerEvent<HTMLDivElement>,
    widget: Widget,
    mode: 'move' | 'resize',
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    onSelect(widget.id);
    const parent = project.widgets.find((item) => item.id === widget.parentId);
    if (mode === 'move' && parent?.layout.mode && parent.layout.mode !== 'absolute') {
      event.currentTarget.focus();
      return;
    }
    gesture.current = {
      id: widget.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      layout: { ...widget.layout },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
  };
  const moveGesture = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const dx = (event.clientX - current.startX) / zoom,
      dy = (event.clientY - current.startY) / zoom;
    const layout =
      current.mode === 'move'
        ? {
            ...current.layout,
            x: Math.max(0, quantize(current.layout.x + dx)),
            y: Math.max(0, quantize(current.layout.y + dy)),
          }
        : {
            ...current.layout,
            width: Math.max(24, quantize(current.layout.width + dx)),
            height: Math.max(20, quantize(current.layout.height + dy)),
          };
    onUpdate(current.id, { layout });
  };
  const finishGesture = () => {
    gesture.current = null;
  };
  const changeZoom = (delta: number) =>
    setZoom((value) => Math.min(2, Math.max(0.1, Math.round((value + delta) * 100) / 100)));
  const themeVariables = Object.fromEntries(
    Object.entries(project.theme.tokens).map(([key, value]) => [
      `--qg-${key.replace('color.', '')}`,
      value,
    ]),
  );
  const initialValues: Record<string, RuntimeValue> = {};
  for (const variable of project.variables) {
    const initial: RuntimeValue = { value: variable.initial, quality: 'good', timestamp: 0 };
    initialValues[variable.id] = initial;
    initialValues[variable.name] = initial;
  }
  const renderTree = (parentId?: string): ReactNode => {
    const parent = project.widgets.find((widget) => widget.id === parentId),
      autoLayout = !!parent?.layout.mode && parent.layout.mode !== 'absolute';
    return project.widgets
      .filter((widget) => widget.parentId === parentId)
      .map((widget) => (
        <div
          key={widget.id}
          tabIndex={0}
          role="button"
          aria-label={`${zh ? '选择' : 'Select'} ${widget.name}`}
          className={`qg-design-widget ${selectedId === widget.id ? 'is-selected' : ''}`}
          style={{
            position: autoLayout ? 'relative' : 'absolute',
            left: autoLayout ? undefined : widget.layout.x,
            top: autoLayout ? undefined : widget.layout.y,
            width: widget.layout.width,
            height: widget.layout.height,
            flexShrink: 0,
          }}
          onPointerDown={(event) => startGesture(event, widget, 'move')}
          onPointerMove={moveGesture}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onSelect(widget.id);
              return;
            }
            const movement: Record<string, [number, number]> = {
              ArrowLeft: [-1, 0],
              ArrowRight: [1, 0],
              ArrowUp: [0, -1],
              ArrowDown: [0, 1],
            };
            if (!movement[event.key]) return;
            event.preventDefault();
            event.stopPropagation();
            onSelect(widget.id);
            if (autoLayout) return;
            const [dx, dy] = movement[event.key],
              step = event.shiftKey ? 10 : 1;
            onUpdate(widget.id, {
              layout: {
                ...widget.layout,
                x: Math.max(0, widget.layout.x + dx * step),
                y: Math.max(0, widget.layout.y + dy * step),
              },
            });
          }}
        >
          <div className="qg-design-widget-content">
            {renderWidget ? (
              renderWidget(widget)
            ) : (
              <WidgetView
                widget={widget}
                project={project}
                values={initialValues}
                interactive={false}
              />
            )}
          </div>
          {project.widgets.some((child) => child.parentId === widget.id) && (
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
                gridTemplateColumns: `repeat(${widget.layout.columns ?? 2}, 1fr)`,
                gap: widget.layout.gap,
              }}
            >
              {renderTree(widget.id)}
            </div>
          )}
          {selectedId === widget.id && (
            <>
              <span className="qg-selection-label" style={{ transform: `scale(${1 / zoom})` }}>
                {widget.name}
                {autoLayout ? ' · AUTO' : ''}
              </span>
              <span className="qg-selection-point top-left" />
              <span className="qg-selection-point top-right" />
              <span className="qg-selection-point bottom-left" />
              <div
                className="qg-resize-handle"
                role="slider"
                aria-label={zh ? '调整大小' : 'Resize'}
                aria-valuetext={`${widget.layout.width} × ${widget.layout.height}`}
                onPointerDown={(event) => startGesture(event, widget, 'resize')}
                onPointerMove={moveGesture}
                onPointerUp={finishGesture}
                onPointerCancel={finishGesture}
              />
            </>
          )}
        </div>
      ));
  };
  return (
    <div className="qg-canvas-editor">
      <div className="qg-canvas-toolbar">
        <div className="qg-toolbar-cluster">
          <span className="qg-canvas-mode">
            <MousePointer2 size={14} />
            {zh ? '选择' : 'Select'}
          </span>
          <span className="qg-toolbar-divider" />
          <Monitor size={14} />
          <span>
            {width} × {height}
          </span>
        </div>
        <div className="qg-toolbar-cluster">
          <button
            className={grid ? 'qg-icon-button active' : 'qg-icon-button'}
            onClick={() => setGrid(!grid)}
            title={zh ? '网格' : 'Grid'}
            aria-label={zh ? '切换网格' : 'Toggle grid'}
            aria-pressed={grid}
          >
            <Grid3X3 size={15} />
          </button>
          <button
            className={snap ? 'qg-icon-button active' : 'qg-icon-button'}
            onClick={() => setSnap(!snap)}
            title={zh ? '吸附网格（8px）' : 'Snap to grid (8px)'}
            aria-label={zh ? '切换吸附' : 'Toggle snap'}
            aria-pressed={snap}
          >
            <Magnet size={15} />
          </button>
          <span className="qg-toolbar-divider" />
          <button
            className="qg-icon-button"
            onClick={() => changeZoom(-0.1)}
            aria-label={zh ? '缩小' : 'Zoom out'}
          >
            <Minus size={14} />
          </button>
          <button
            className="qg-zoom-value"
            onClick={() => setZoom(1)}
            title={zh ? '重置为100%' : 'Reset to 100%'}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="qg-icon-button"
            onClick={() => changeZoom(0.1)}
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
      <div
        className={`qg-canvas-viewport ${grid ? 'show-grid' : ''}`}
        ref={viewportRef}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onSelect(null);
        }}
      >
        <div className="qg-artboard-area" style={{ width: width * zoom, height: height * zoom }}>
          <div className="qg-artboard-caption">
            <span>{project.window.title || project.name}</span>
            <span>{zh ? '主窗口' : 'MAIN WINDOW'}</span>
          </div>
          <div className="qg-artboard-ruler" aria-hidden="true">
            {Array.from({ length: Math.ceil(width / 160) }, (_, index) => (
              <span key={index} style={{ left: index * 160 * zoom }}>
                {index * 160}
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
                transform: `scale(${zoom})`,
                background: project.window.background,
                borderRadius: project.window.contentRadius,
                color: 'var(--qg-text)',
              } as CSSProperties
            }
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) onSelect(null);
            }}
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
              const bounds = event.currentTarget.getBoundingClientRect();
              onAdd(
                type as WidgetType,
                Math.max(0, quantize((event.clientX - bounds.left) / zoom)),
                Math.max(0, quantize((event.clientY - bounds.top) / zoom)),
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
                    ? '从左侧拖入组件，或点击组件添加'
                    : 'Drag a component from the library to get started'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="qg-canvas-status">
        <span>
          <span className="qg-status-dot" />
          {zh ? '设计画布' : 'Design canvas'}
        </span>
        <span>
          {selected
            ? `${selected.name} · ${selected.layout.width} × ${selected.layout.height}`
            : `${project.widgets.length} ${zh ? '个组件' : 'components'}`}
        </span>
        <span>{zh ? '方向键微调 · Shift 加速' : 'Arrow keys to nudge · Shift for 10px'}</span>
      </div>
    </div>
  );
}

export default CanvasEditor;
