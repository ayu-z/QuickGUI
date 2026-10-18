import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Json, Project, RuntimeValue, Widget, WidgetStyle } from '../core/types';
import { assetUrl } from '../core/project';
import { CustomComponent } from './CustomComponent';
import './runtime.css';

export interface WidgetViewProps {
  widget: Widget;
  project: Project;
  values?: Record<string, RuntimeValue>;
  onEvent?: (widget: Widget, event: string, payload: Json) => void;
  interactive?: boolean;
  depth?: number;
}
export function resolveStyle(style: WidgetStyle, project: Project): CSSProperties {
  return Object.fromEntries(
    Object.entries(style).map(([key, value]) => [
      key,
      typeof value === 'string' && value.startsWith('$')
        ? (project.theme.tokens[value.slice(1)] ?? value)
        : value,
    ]),
  ) as CSSProperties;
}
export function boundProps(
  widget: Widget,
  values: Record<string, RuntimeValue> = {},
): Record<string, Json> {
  const props = { ...widget.props };
  for (const [key, binding] of Object.entries(widget.bindings)) {
    const value = values[binding.variable];
    if (value) props[key] = value.value;
  }
  return props;
}
const printable = (value: Json | undefined) =>
  typeof value === 'number'
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)
    : typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value);

export function WidgetView({
  widget,
  project,
  values = {},
  onEvent,
  interactive = false,
  depth = 0,
}: WidgetViewProps) {
  const [hover, setHover] = useState(false),
    [pressed, setPressed] = useState(false),
    [focused, setFocused] = useState(false);
  const p = boundProps(widget, values);
  const runtimeLocale =
    typeof values.locale?.value === 'string' ? values.locale.value : project.locale;
  for (const key of ['text', 'placeholder', 'alt']) {
    const raw = p[key];
    if (typeof raw === 'string' && raw.startsWith('@')) {
      const translation = raw.slice(1);
      p[key] =
        project.translations?.[runtimeLocale]?.[translation] ??
        project.translations?.[project.locale]?.[translation] ??
        translation;
    }
  }
  const once = useRef<Record<string, Json>>({});
  for (const [property, binding] of Object.entries(widget.bindings)) {
    if (binding.mode !== 'once') continue;
    const key = `${widget.id}:${property}:${binding.variable}`;
    if (!(key in once.current) && values[binding.variable])
      once.current[key] = values[binding.variable].value;
    if (key in once.current) p[property] = once.current[key];
  }
  const disabled = p.enabled === false;
  const states = {
    ...(hover ? widget.states.hover : {}),
    ...(pressed ? widget.states.pressed : {}),
    ...(focused ? widget.states.focus : {}),
    ...(disabled ? widget.states.disabled : {}),
  };
  const style = resolveStyle({ ...widget.style, ...states }, project);
  const value = p.value ?? 0,
    min = Number(p.min ?? 0),
    max = Number(p.max ?? 100);
  const fraction = Math.max(0, Math.min(1, (Number(value) - min) / (max - min || 1)));
  const emit = (event: string, payload: Json = null) => {
    if (interactive && !disabled) onEvent?.(widget, event, payload);
  };
  const common = { disabled: disabled || !interactive, tabIndex: interactive ? 0 : -1 };
  const unit = String(p.unit ?? '');
  let content;
  switch (widget.type) {
    case 'panel':
      content = <div className="qg-panel" />;
      break;
    case 'text':
      content = (
        <span className="qg-text">
          {printable(p.text)}
          {unit && <small> {unit}</small>}
        </span>
      );
      break;
    case 'button':
      content = (
        <button className="qg-button" {...common} onClick={() => emit('click')}>
          {printable(p.text)}
        </button>
      );
      break;
    case 'input':
      content = (
        <input
          className="qg-input"
          {...common}
          value={printable(p.value)}
          placeholder={String(p.placeholder ?? '')}
          onChange={(e) => emit('change', e.target.value)}
          onBlur={() => emit('submit', p.value ?? '')}
        />
      );
      break;
    case 'number':
      content = (
        <input
          className="qg-input"
          type="number"
          {...common}
          value={Number(value)}
          min={p.min === undefined ? undefined : min}
          max={p.max === undefined ? undefined : max}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) emit('change', n);
          }}
        />
      );
      break;
    case 'switch':
      content = (
        <label className="qg-switch">
          <span>{printable(p.text)}</span>
          <input
            type="checkbox"
            {...common}
            checked={Boolean(value)}
            onChange={(e) => emit('change', e.target.checked)}
          />
          <span className={`qg-switch-track ${value ? 'on' : ''}`} aria-hidden="true">
            <i />
          </span>
        </label>
      );
      break;
    case 'slider':
      content = (
        <div className="qg-slider">
          <input
            type="range"
            {...common}
            min={min}
            max={max}
            value={Number(value)}
            onChange={(e) => emit('change', Number(e.target.value))}
          />
          <span>
            {printable(value)}
            {unit}
          </span>
        </div>
      );
      break;
    case 'progress':
      content = (
        <div className="qg-progress">
          <div style={{ width: `${fraction * 100}%` }} />
        </div>
      );
      break;
    case 'gauge': {
      const angle = Math.PI * (1 - fraction),
        x = 90 + Math.cos(angle) * 70,
        y = 85 - Math.sin(angle) * 70;
      content = (
        <div className="qg-gauge">
          <svg viewBox="0 0 180 108" aria-label={`${printable(value)} ${unit}`}>
            <path
              d="M20 85 A70 70 0 0 1 160 85"
              fill="none"
              stroke="var(--qg-border)"
              strokeWidth="8"
              strokeLinecap="round"
            />
            <path
              d="M20 85 A70 70 0 0 1 160 85"
              pathLength="100"
              fill="none"
              stroke="var(--qg-primary)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${fraction * 100} 100`}
            />
            <circle cx={x} cy={y} r="5" fill="var(--qg-primary)" />
            <text
              x="90"
              y="73"
              textAnchor="middle"
              fill="currentColor"
              fontSize="29"
              fontWeight="600"
            >
              {printable(value)}
            </text>
            <text x="90" y="95" textAnchor="middle" fill="var(--qg-muted)" fontSize="11">
              {unit}
            </text>
          </svg>
        </div>
      );
      break;
    }
    case 'chart':
      content = <TrendChart value={Number(value)} min={min} max={max} />;
      break;
    case 'image': {
      const src = assetUrl(project, String(p.assetId ?? ''));
      content = src ? (
        <img
          src={src}
          alt={String(p.alt ?? widget.name)}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ) : (
        <div className="qg-image-placeholder">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="m3 17 6-6 5 5 3-3 4 4" />
            <circle cx="16" cy="8" r="2" />
          </svg>
          <span>{project.locale === 'zh-CN' ? '选择图片资源' : 'Select an image'}</span>
        </div>
      );
      break;
    }
    case 'select':
      content = (
        <select
          className="qg-input"
          {...common}
          value={printable(p.value)}
          onChange={(e) => emit('change', e.target.value)}
        >
          {(Array.isArray(p.options) ? p.options : []).map((item, i) => (
            <option key={i} value={printable(item)}>
              {printable(item)}
            </option>
          ))}
        </select>
      );
      break;
    case 'table':
      content = (
        <div className="qg-table-scroll">
          <table className="qg-table">
            <tbody>
              {(Array.isArray(p.rows) ? p.rows : []).map((row, i) => (
                <tr key={i}>
                  {(Array.isArray(row) ? row : [row]).map((cell, j) =>
                    i === 0 ? (
                      <th key={j}>{printable(cell)}</th>
                    ) : (
                      <td key={j}>{printable(cell)}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      break;
    case 'module': {
      const module = project.modules.find((m) => m.id === widget.moduleId);
      if (!module || depth > 8) {
        content = <span className="qg-error">Module unavailable</span>;
        break;
      }
      if (module.implementation?.kind === 'react') {
        const defaults = Object.fromEntries(
          Object.entries(module.exposedProps).map(([key, exposed]) => [key, exposed.default]),
        );
        content = (
          <CustomComponent
            module={module}
            props={{ ...defaults, ...p }}
            project={project}
            locale={runtimeLocale}
            interactive={interactive && !disabled}
            width={widget.layout.width}
            height={widget.layout.height}
            onEmit={emit}
          />
        );
        break;
      }
      const children = module.widgets.map((child) => {
        const props = { ...child.props };
        for (const [key, exposed] of Object.entries(module.exposedProps))
          if (exposed.widgetId === child.id) props[exposed.property] = p[key] ?? exposed.default;
        return { ...child, props };
      });
      content = (
        <div
          style={{
            position: 'relative',
            width: module.width,
            height: module.height,
            transformOrigin: 'top left',
            transform: `scale(${widget.layout.width / module.width}, ${widget.layout.height / module.height})`,
          }}
        >
          <WidgetTree
            widgets={children}
            project={project}
            values={values}
            onEvent={onEvent}
            interactive={interactive}
            depth={depth + 1}
          />
        </div>
      );
      break;
    }
  }
  if (p.visible === false) return null;
  const qualities = Object.values(widget.bindings)
    .map((b) => values[b.variable]?.quality)
    .filter(Boolean);
  return (
    <div
      className={`qg-widget qg-type-${widget.type} ${disabled ? 'qg-disabled' : ''}`}
      style={style}
      data-widget={widget.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {content}
      {qualities.some((q) => q !== 'good') && (
        <span className="qg-quality" title={qualities.join(', ')}>
          !
        </span>
      )}
    </div>
  );
}

function TrendChart({ value, min, max }: { value: number; min: number; max: number }) {
  const [samples, setSamples] = useState<number[]>([value]);
  useEffect(() => {
    setSamples((previous) => [...previous.slice(-59), value]);
  }, [value]);
  const points = samples.length === 1 ? [samples[0], samples[0]] : samples;
  const plot = points
    .map(
      (n, i) =>
        `${(i / (points.length - 1)) * 480},${125 - Math.max(0, Math.min(1, (n - min) / (max - min || 1))) * 115}`,
    )
    .join(' ');
  return (
    <div className="qg-chart">
      <svg viewBox="0 0 520 160" preserveAspectRatio="none">
        <defs>
          <linearGradient id="qg-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--qg-primary)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--qg-primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g transform="translate(32,4)">
          {[10, 48, 86, 125].map((y, i) => (
            <g key={y}>
              <line x1="0" y1={y} x2="480" y2={y} stroke="var(--qg-border)" strokeDasharray="3 5" />
              <text x="-8" y={y + 4} textAnchor="end" fill="var(--qg-muted)" fontSize="9">
                {Math.round(max - ((max - min) * i) / 3)}
              </text>
            </g>
          ))}
          <polygon points={`0,125 ${plot} 480,125`} fill="url(#qg-chart-fill)" />
          <polyline
            points={plot}
            fill="none"
            stroke="var(--qg-primary)"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
          <text x="0" y="150" fill="var(--qg-muted)" fontSize="9">
            {samples.length} samples
          </text>
          <text x="480" y="150" textAnchor="end" fill="var(--qg-muted)" fontSize="9">
            LIVE
          </text>
        </g>
      </svg>
    </div>
  );
}

export function WidgetTree({
  widgets,
  project,
  values,
  onEvent,
  interactive,
  depth = 0,
  parentId,
}: Omit<WidgetViewProps, 'widget'> & { widgets: Widget[]; parentId?: string }) {
  const parent = widgets.find((w) => w.id === parentId);
  const mode = parent?.layout.mode ?? 'absolute';
  return (
    <>
      {widgets
        .filter((w) => w.parentId === parentId)
        .map((widget) => {
          const layout: CSSProperties =
            mode === 'absolute'
              ? {
                  position: 'absolute',
                  left: widget.layout.x,
                  top: widget.layout.y,
                  width: widget.layout.width,
                  height: widget.layout.height,
                }
              : {
                  position: 'relative',
                  width: widget.layout.width,
                  height: widget.layout.height,
                  flexShrink: 0,
                };
          return (
            <div key={widget.id} style={layout}>
              <WidgetView
                widget={widget}
                project={project}
                values={values}
                onEvent={onEvent}
                interactive={interactive}
                depth={depth}
              />
              {widgets.some((w) => w.parentId === widget.id) && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display:
                      widget.layout.mode === 'flex'
                        ? 'flex'
                        : widget.layout.mode === 'grid'
                          ? 'grid'
                          : 'block',
                    flexDirection: widget.layout.direction,
                    gridTemplateColumns: `repeat(${widget.layout.columns ?? 2}, 1fr)`,
                    gap: widget.layout.gap,
                    pointerEvents: 'none',
                  }}
                >
                  <WidgetTree
                    widgets={widgets}
                    project={project}
                    values={values}
                    onEvent={onEvent}
                    interactive={interactive}
                    depth={depth}
                    parentId={widget.id}
                  />
                </div>
              )}
            </div>
          );
        })}
    </>
  );
}

export function Scene({
  project,
  values,
  onEvent,
  interactive = true,
}: Omit<WidgetViewProps, 'widget'>) {
  const variables = Object.fromEntries(
    Object.entries(project.theme.tokens).map(([key, value]) => [
      `--qg-${key.replace('color.', '')}`,
      value,
    ]),
  );
  return (
    <div
      className="qg-scene"
      style={
        {
          ...variables,
          width: project.window.width,
          height: project.window.height,
          background: project.window.background,
          borderRadius: project.window.contentRadius,
          overflow: 'hidden',
        } as CSSProperties
      }
    >
      <WidgetTree
        widgets={project.widgets}
        project={project}
        values={values}
        onEvent={onEvent}
        interactive={interactive}
      />
    </div>
  );
}
