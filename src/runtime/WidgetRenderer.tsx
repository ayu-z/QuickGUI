import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { Json, Project, RuntimeValue, Widget, WidgetStyle } from '../core/types';
import { assetUrl } from '../core/project';
import { CustomComponent } from './CustomComponent';
import { ChartWidget, TableWidget } from './DataWidgets';
import {
  getJsonPath,
  getWidgetDefinition,
  getBindableProperties,
  propertyPath,
  resolvedWidgetProps,
  setProperty,
  validatePropertyValue,
} from '../core/widgetDefinitions';
import './runtime.css';

export interface WidgetViewProps {
  widget: Widget;
  project: Project;
  values?: Record<string, RuntimeValue>;
  onEvent?: (widget: Widget, event: string, payload: Json) => void;
  interactive?: boolean;
  depth?: number;
  children?: ReactNode;
  previewState?: string;
  inheritedDisabled?: boolean;
  runtimeLocale?: string;
}
const RenderContext = createContext<{ disabled: boolean; scopeId?: string }>({ disabled: false });
const canonicalAssets = new WeakMap<Project, Project['assets']>();
export function widgetResourceScope(
  widget: Widget,
  project: Project,
  inherited?: string,
): string | undefined {
  const own =
    widget.resourceScopeId ??
    project.modules.find((module) => module.id === widget.moduleId)?.resourceScopeId;
  if (own || inherited) return own ?? inherited;
  const visited = new Set<string>();
  let parentId = widget.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = project.widgets.find((item) => item.id === parentId);
    if (!parent) break;
    if (parent.resourceScopeId) return parent.resourceScopeId;
    parentId = parent.parentId;
  }
  return undefined;
}
export function scopedProject(
  project: Project,
  scopeId: string | undefined,
  values: Record<string, RuntimeValue> = {},
): Project {
  const scope = project.resourceScopes?.find((entry) => entry.id === scopeId);
  if (!scope) return project;
  const assets = canonicalAssets.get(project) ?? project.assets;
  const aliases = Object.entries(scope.assetAliases ?? {}).flatMap(([id, target]) => {
    const asset = assets.find((entry) => entry.id === target);
    return asset ? [{ ...asset, id }] : [];
  });
  const result = {
    ...project,
    theme: scope.theme,
    translations: scope.translations,
    locale: scope.locale,
    assets: [...(scope.assets ?? []), ...aliases, ...assets],
  };
  canonicalAssets.set(result, assets);
  return result;
}
export function WidgetView(props: WidgetViewProps) {
  const inherited = useContext(RenderContext),
    module = props.project.modules.find((entry) => entry.id === props.widget.moduleId);
  let scopeId = widgetResourceScope(props.widget, props.project, inherited.scopeId);
  let sourceProject = props.project;
  if (
    !sourceProject.resourceScopes?.some((scope) => scope.id === scopeId) &&
    module?.embeddedResourceScope
  ) {
    scopeId = module.embeddedResourceScope.id;
    sourceProject = {
      ...sourceProject,
      resourceScopes: [
        ...(sourceProject.resourceScopes ?? []).filter((scope) => scope.id !== scopeId),
        module.embeddedResourceScope,
      ],
    };
    canonicalAssets.set(sourceProject, canonicalAssets.get(props.project) ?? props.project.assets);
  }
  const project = scopedProject(sourceProject, scopeId, props.values);
  const scope = sourceProject.resourceScopes?.find((entry) => entry.id === scopeId);
  const dynamicLocale = scope?.localeVariableId
    ? props.values?.[scope.localeVariableId]?.value
    : undefined;
  const runtimeLocale = scope
    ? typeof dynamicLocale === 'string'
      ? dynamicLocale
      : scope.locale
    : props.runtimeLocale;
  const next = {
    ...props,
    project,
    runtimeLocale,
    inheritedDisabled: inherited.disabled || props.inheritedDisabled,
  };
  return (
    <RenderContext.Provider value={{ ...inherited, scopeId }}>
      <ModernWidgetView {...next} />
    </RenderContext.Provider>
  );
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
  diagnostics?: string[],
  module?: Project['modules'][number],
): Record<string, Json> {
  let props = resolvedWidgetProps(widget, module);
  const properties = getBindableProperties(widget, module);
  for (const [key, binding] of Object.entries(widget.bindings)) {
    const value = values[binding.variable];
    if (value) {
      {
        const leaf = getJsonPath(value.value, binding.path ?? []);
        const definition = properties.find(
          (entry) => entry.key === key || entry.key === key.replace(/^\//, ''),
        );
        const invalid =
          leaf === undefined
            ? 'JSON path does not exist'
            : definition
              ? validatePropertyValue(definition, leaf)
              : undefined;
        if (
          invalid ||
          (['rows', 'options'].includes(key.replace(/^\//, '')) && !Array.isArray(leaf))
        )
          diagnostics?.push(`${key}: ${invalid ?? 'Expected an array'}`);
        else if (leaf !== undefined) {
          try {
            props = setProperty(props, key, leaf);
          } catch (error) {
            diagnostics?.push(`${key}: ${String(error)}`);
          }
        }
      }
    }
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

function ModernWidgetView({
  widget,
  project,
  values = {},
  onEvent,
  interactive = false,
  depth = 0,
  children,
  previewState,
  inheritedDisabled = false,
  runtimeLocale: localeOverride,
}: WidgetViewProps) {
  const context = useContext(RenderContext);
  const [hover, setHover] = useState(false),
    [pressed, setPressed] = useState(false),
    [focused, setFocused] = useState(false);
  const module = project.modules.find((entry) => entry.id === widget.moduleId);
  const bindingDiagnostics: string[] = [];
  let p = boundProps(widget, values, bindingDiagnostics, module);
  const once = useRef<Record<string, Json>>({});
  const currentOnce = new Set<string>();
  for (const [property, binding] of Object.entries(widget.bindings)) {
    if (binding.mode !== 'once') continue;
    let target = property;
    try {
      const path = propertyPath(property, p);
      if (path[0] === 'series' && path.length >= 3) {
        const id = getJsonPath(p, ['series', path[1], 'id']);
        if (typeof id === 'string') target = JSON.stringify(['series', id, ...path.slice(2)]);
      }
    } catch {
      /* invalid target remains diagnosable */
    }
    const key = JSON.stringify([project.id, widget.id, target, binding.variable, binding.path]);
    currentOnce.add(key);
    const value = getJsonPath(values[binding.variable]?.value, binding.path ?? []);
    if (
      !Object.hasOwn(once.current, key) &&
      value !== undefined &&
      !bindingDiagnostics.some((message) => message.startsWith(`${property}:`))
    )
      once.current[key] = structuredClone(value);
    if (Object.hasOwn(once.current, key)) {
      try {
        p = setProperty(p, property, once.current[key]);
      } catch {
        /* validated elsewhere */
      }
    }
  }
  for (const key of Object.keys(once.current)) if (!currentOnce.has(key)) delete once.current[key];
  const locale =
    localeOverride ??
    (typeof values.locale?.value === 'string' ? values.locale.value : project.locale);
  const translate = (value: Json | undefined): Json | undefined =>
    typeof value === 'string' && value.startsWith('@')
      ? (project.translations?.[locale]?.[value.slice(1)] ??
        project.translations?.[project.locale]?.[value.slice(1)] ??
        value.slice(1))
      : value;
  for (const key of ['text', 'placeholder', 'alt', 'title', 'onText', 'offText', 'emptyText'])
    if (p[key] !== undefined) p[key] = translate(p[key])!;
  const disabled = p.enabled === false || inheritedDisabled;
  const activeStates = {
    hover: hover || previewState === 'hover',
    pressed: pressed || previewState === 'pressed',
    focus: focused || previewState === 'focus',
    disabled: disabled || previewState === 'disabled',
  };
  const stateStyle = Object.entries(activeStates).reduce<WidgetStyle>(
    (style, [key, active]) => (active ? { ...style, ...widget.states[key] } : style),
    {},
  );
  const style = resolveStyle({ ...widget.style, ...stateStyle }, project);
  const themeVars = Object.fromEntries(
    Object.entries(project.theme.tokens).map(([key, value]) => [
      `--qg-${key.replace('color.', '')}`,
      value,
    ]),
  );
  const color = (key: string, fallback: string) => {
    const value = String(p[key] ?? fallback);
    return value.startsWith('$') ? (project.theme.tokens[value.slice(1)] ?? fallback) : value;
  };
  const [localValue, setLocalValue] = useState<Json | undefined>();
  useEffect(() => setLocalValue(undefined), [p.value, widget.id, project.id]);
  const value = localValue ?? p.value ?? 0,
    min = typeof p.min === 'number' ? p.min : 0,
    max = typeof p.max === 'number' ? p.max : 100;
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const precision =
    typeof p.precision === 'number' ? Math.max(0, Math.min(12, Math.floor(p.precision))) : 2;
  const formatted = number.toLocaleString(locale, { maximumFractionDigits: precision });
  const unit = String(p.unit ?? ''),
    fraction = Math.max(0, Math.min(1, (number - min) / Math.max(Number.EPSILON, max - min)));
  const emit = (event: string, payload: Json = null) => {
    if (
      interactive &&
      !disabled &&
      getWidgetDefinition(widget.type, 2, module).events.some((entry) => entry.name === event)
    )
      onEvent?.(widget, event, payload);
  };
  const change = (next: Json) => {
    if (p.readOnly === true || disabled || !interactive) return;
    setLocalValue(next);
    emit('change', next);
  };
  const common = { disabled: disabled || !interactive, tabIndex: interactive ? 0 : -1 };
  const inputEvents = {
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (
        event.key === 'Enter' &&
        (!p.multiline || event.ctrlKey || event.metaKey) &&
        ['enter', 'both'].includes(String(p.submitOn))
      ) {
        event.preventDefault();
        emit('submit', event.currentTarget.value);
      }
    },
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (['blur', 'both'].includes(String(p.submitOn))) emit('submit', event.currentTarget.value);
    },
  };
  let content: ReactNode;
  switch (widget.type) {
    case 'panel':
      content = (
        <div
          className="qg-panel-content"
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            display:
              widget.layout.mode === 'flex'
                ? 'flex'
                : widget.layout.mode === 'grid'
                  ? 'grid'
                  : 'block',
            flexDirection: widget.layout.direction,
            gridTemplateColumns: `repeat(${widget.layout.columns ?? 2}, minmax(0, 1fr))`,
            gap: style.gap ?? widget.layout.gap ?? 0,
            rowGap: style.rowGap,
            columnGap: style.columnGap,
            flexWrap: style.flexWrap,
            alignItems: style.alignItems,
            justifyContent: style.justifyContent,
          }}
        >
          {children}
        </div>
      );
      break;
    case 'text':
      content = (
        <span
          className="qg-modern-text"
          style={{
            display: 'flex',
            width: '100%',
            height: '100%',
            alignItems:
              p.verticalAlign === 'start'
                ? 'flex-start'
                : p.verticalAlign === 'end'
                  ? 'flex-end'
                  : 'center',
            justifyContent:
              style.textAlign === 'center'
                ? 'center'
                : style.textAlign === 'right'
                  ? 'flex-end'
                  : 'flex-start',
            userSelect: p.selectable ? 'text' : 'none',
          }}
        >
          <span
            style={{
              minWidth: 0,
              whiteSpace: style.whiteSpace ?? (p.wrap ? 'pre-wrap' : 'pre'),
              textOverflow: style.textOverflow ?? (p.overflow === 'ellipsis' ? 'ellipsis' : 'clip'),
              overflow: 'hidden',
            }}
          >
            {printable(p.text)}
            {unit && <small> {unit}</small>}
          </span>
        </span>
      );
      break;
    case 'button': {
      const icon = assetUrl(project, String(p.iconAssetId ?? ''));
      content = (
        <button
          className="qg-modern-button"
          {...common}
          onClick={() => emit('click')}
          style={{
            flexDirection: p.iconPosition === 'right' ? 'row-reverse' : 'row',
            justifyContent:
              style.textAlign === 'left'
                ? 'flex-start'
                : style.textAlign === 'right'
                  ? 'flex-end'
                  : 'center',
          }}
        >
          {icon && <img src={icon} alt="" width={Number(p.iconSize)} height={Number(p.iconSize)} />}
          {printable(p.text)}
        </button>
      );
      break;
    }
    case 'input': {
      const shared = {
        ...common,
        value: typeof value === 'string' ? value : printable(value),
        placeholder: String(p.placeholder ?? ''),
        readOnly: p.readOnly === true,
        maxLength: Number(p.maxLength) > 0 ? Number(p.maxLength) : undefined,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          change(event.target.value),
        ...inputEvents,
      };
      content = p.multiline ? (
        <textarea className="qg-modern-input" {...shared} rows={Number(p.rows) || 3} />
      ) : (
        <input className="qg-modern-input" {...shared} type={String(p.inputType ?? 'text')} />
      );
      break;
    }
    case 'number':
      content = (
        <div className="qg-modern-number">
          <input
            className="qg-modern-input"
            {...common}
            type="number"
            value={focused ? number : number.toFixed(precision)}
            min={min}
            max={max}
            step={Number(p.step) || 1}
            placeholder={String(p.placeholder ?? '')}
            readOnly={p.readOnly === true}
            onChange={(event) => {
              if (event.target.value.trim()) {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= min && next <= max) change(next);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') emit('submit', number);
            }}
            onBlur={() => emit('submit', number)}
          />
          {unit && <span>{unit}</span>}
        </div>
      );
      break;
    case 'switch':
      content = (
        <label className="qg-modern-switch">
          <span>{printable(p.text)}</span>
          <input
            type="checkbox"
            {...common}
            checked={value === true}
            onChange={(event) => change(event.target.checked)}
          />
          <span
            className={`qg-switch-track ${value === true ? 'on' : ''}`}
            style={{
              background:
                value === true
                  ? color('onColor', 'var(--qg-primary)')
                  : color('offColor', 'var(--qg-border)'),
            }}
          >
            <i />
          </span>
          {(value === true ? p.onText : p.offText) ? (
            <span>{String(value === true ? p.onText : p.offText)}</span>
          ) : null}
        </label>
      );
      break;
    case 'slider':
      content = (
        <div className={`qg-modern-slider ${p.orientation === 'vertical' ? 'vertical' : ''}`}>
          <input
            type="range"
            {...common}
            min={min}
            max={max}
            step={Number(p.step) || 1}
            value={number}
            style={{ accentColor: color('fillColor', 'var(--qg-primary)') }}
            onChange={(event) => change(Number(event.target.value))}
          />
          {p.showValue !== false && (
            <output>
              {formatted}
              {unit}
            </output>
          )}
        </div>
      );
      break;
    case 'progress':
      content = (
        <div
          className={`qg-modern-progress ${p.orientation === 'vertical' ? 'vertical' : ''}`}
          role="progressbar"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={number}
          style={{ background: color('trackColor', 'var(--qg-border)') }}
        >
          <div
            style={{
              width: p.orientation === 'vertical' ? '100%' : `${fraction * 100}%`,
              height: p.orientation === 'vertical' ? `${fraction * 100}%` : '100%',
              background: color('fillColor', 'var(--qg-primary)'),
            }}
          />
          {p.showValue === true && (
            <span>
              {formatted}
              {unit}
            </span>
          )}
        </div>
      );
      break;
    case 'gauge': {
      const start = Number(p.startAngle ?? 180),
        sweep = Number(p.sweepAngle ?? 180);
      const point = (angle: number) => [
        90 + Math.cos((angle * Math.PI) / 180) * 70,
        90 - Math.sin((angle * Math.PI) / 180) * 70,
      ];
      const a = point(start),
        b = point(start - sweep);
      const arc = `M${a[0]} ${a[1]} A70 70 0 ${sweep > 180 ? 1 : 0} 1 ${b[0]} ${b[1]}`;
      content = (
        <svg className="qg-modern-gauge" viewBox="0 0 180 180" aria-label={`${formatted} ${unit}`}>
          <path
            d={arc}
            fill="none"
            stroke={color('trackColor', 'var(--qg-border)')}
            strokeWidth={Number(p.strokeWidth)}
            strokeLinecap="round"
          />
          <path
            d={arc}
            pathLength="100"
            fill="none"
            stroke={color('fillColor', 'var(--qg-primary)')}
            strokeWidth={Number(p.strokeWidth)}
            strokeLinecap="round"
            strokeDasharray={`${fraction * 100} 100`}
          />
          {p.showValue !== false && (
            <text
              x="90"
              y="90"
              dominantBaseline="middle"
              textAnchor="middle"
              fill="currentColor"
              style={{ font: 'inherit' }}
            >
              {formatted}
            </text>
          )}
          <text
            x="90"
            y="116"
            textAnchor="middle"
            fill="currentColor"
            style={{ fontSize: '0.5em' }}
          >
            {unit}
          </text>
        </svg>
      );
      break;
    }
    case 'chart':
      content = (
        <ChartWidget
          props={p}
          project={{ ...project, locale: locale as Project['locale'] }}
          interactive={interactive}
        />
      );
      break;
    case 'image': {
      const src = assetUrl(project, String(p.assetId ?? ''));
      content = src ? (
        <img
          src={src}
          alt={String(p.alt ?? widget.name)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: p.fit as CSSProperties['objectFit'],
            objectPosition: String(p.objectPosition ?? 'center'),
            display: 'block',
          }}
        />
      ) : (
        <div className="qg-image-placeholder">
          {project.locale === 'zh-CN' ? '选择图片资源' : 'Select an image'}
        </div>
      );
      break;
    }
    case 'select': {
      const options = (Array.isArray(p.options) ? p.options : []).map((option) =>
        p.legacyOptions === true
          ? { label: printable(option), value: printable(option), disabled: false }
          : option && typeof option === 'object' && !Array.isArray(option)
            ? {
                label: translate(option.label),
                value: option.value,
                disabled: option.disabled === true,
              }
            : { label: option, value: option, disabled: false },
      );
      const selected = options.findIndex(
        (option) =>
          JSON.stringify(option.value) ===
          JSON.stringify(p.legacyValueFormat === true ? printable(value) : value),
      );
      content = (
        <select
          className="qg-modern-input"
          {...common}
          value={selected < 0 ? '' : String(selected)}
          onChange={(event) => {
            const option = options[Number(event.target.value)];
            if (option) change(option.value);
          }}
        >
          <option value="" disabled>
            {String(p.placeholder ?? '')}
          </option>
          {options.map((option, index) => (
            <option key={index} value={index} disabled={option.disabled}>
              {printable(option.label)}
            </option>
          ))}
        </select>
      );
      break;
    }
    case 'table':
      content = (
        <TableWidget
          props={p}
          locale={locale}
          interactive={interactive && !disabled}
          onEvent={emit}
        />
      );
      break;
    case 'module': {
      if (!module || depth > 8) {
        content = <span className="qg-error">Module unavailable</span>;
        break;
      }
      if (module.implementation?.kind === 'react')
        content = (
          <CustomComponent
            module={module}
            props={p}
            project={project}
            locale={locale}
            interactive={interactive && !disabled}
            width={widget.layout.width}
            height={widget.layout.height}
            onEmit={emit}
          />
        );
      else {
        const widgets = module.widgets.map((child) => {
          let props = { ...child.props };
          for (const [key, exposed] of Object.entries(module.exposedProps))
            if (exposed.widgetId === child.id) {
              try {
                props = setProperty(
                  props,
                  exposed.property,
                  Object.hasOwn(p, key) ? p[key] : exposed.default,
                );
              } catch {
                /* invalid exposed targets are rejected by the editor */
              }
            }
          return { ...child, props };
        });
        content = (
          <div
            style={{
              position: 'relative',
              width: module.width,
              height: module.height,
              transformOrigin: 'top left',
              transform: `scale(${widget.layout.width / module.width},${widget.layout.height / module.height})`,
            }}
          >
            <WidgetTree
              widgets={widgets}
              project={project}
              values={values}
              onEvent={onEvent}
              interactive={interactive}
              depth={depth + 1}
            />
          </div>
        );
      }
      break;
    }
  }
  if (p.visible === false) return null;
  const qualities = Object.values(widget.bindings)
    .map((binding) => values[binding.variable]?.quality)
    .filter(Boolean);
  return (
    <RenderContext.Provider value={{ ...context, disabled }}>
      <div
        className={`qg-widget qg-modern qg-type-${widget.type} ${activeStates.disabled ? 'qg-disabled' : ''}`}
        data-widget={widget.id}
        data-definition-version="2"
        title={String(p.title ?? '')}
        style={{
          ...themeVars,
          colorScheme: project.theme.mode === 'system' ? undefined : project.theme.mode,
          ...style,
          ...(widget.type === 'panel' ? { overflow: p.overflow as CSSProperties['overflow'] } : {}),
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => {
          setHover(false);
          setPressed(false);
        }}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onFocus={(event) => {
          setFocused(true);
          if (!event.currentTarget.contains(event.relatedTarget)) emit('focus');
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocused(false);
            emit('blur');
          }
        }}
      >
        {content}
        {widget.type !== 'panel' && children}
        {qualities.some((quality) => quality !== 'good') && (
          <span className="qg-quality" title={qualities.join(', ')}>
            !
          </span>
        )}
        {!!bindingDiagnostics.length && (
          <span className="qg-binding-error" role="status" title={bindingDiagnostics.join('\n')}>
            {bindingDiagnostics.join('; ')}
          </span>
        )}
      </div>
    </RenderContext.Provider>
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
              >
                {widgets.some((w) => w.parentId === widget.id) && (
                  <WidgetTree
                    widgets={widgets}
                    project={project}
                    values={values}
                    onEvent={onEvent}
                    interactive={interactive}
                    depth={depth}
                    parentId={widget.id}
                  />
                )}
              </WidgetView>
            </div>
          );
        })}
    </>
  );
}

export function runtimeValueAliases(
  project: Project,
  values: Record<string, RuntimeValue> = {},
): Record<string, RuntimeValue> {
  const aliases = Object.fromEntries(
    project.variables.flatMap((variable) =>
      values[variable.id] ? [[variable.name, values[variable.id]]] : [],
    ),
  );
  return { ...aliases, ...values };
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
          colorScheme: project.theme.mode === 'system' ? undefined : project.theme.mode,
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
        values={runtimeValueAliases(project, values)}
        onEvent={onEvent}
        interactive={interactive}
      />
    </div>
  );
}
