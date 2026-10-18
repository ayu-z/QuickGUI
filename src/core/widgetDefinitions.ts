import type {
  Binding,
  ComponentModule,
  Json,
  Project,
  Widget,
  WidgetStyle,
  WidgetType,
} from './types';

export type JsonPath = (string | number)[];
export type PropertyEditor =
  | 'text'
  | 'textarea'
  | 'number'
  | 'toggle'
  | 'select'
  | 'color'
  | 'asset'
  | 'options'
  | 'series'
  | 'columns'
  | 'json';
export interface PropertyDefinition {
  key: string;
  label: { zh: string; en: string };
  group: 'content' | 'behavior' | 'data' | 'appearance';
  type: 'string' | 'number' | 'boolean' | 'json';
  editor: PropertyEditor;
  initialValue: Json;
  fallbackValue: Json;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  enum?: (string | number)[];
  reference?: 'asset' | 'variable' | 'module';
  binding?: { modes: Binding['mode'][]; variableTypes: string[]; writeEvent?: string };
  target?: string;
  stateful?: boolean;
}
export interface EventDefinition {
  name: string;
  payload: 'null' | 'string' | 'number' | 'boolean' | 'json';
  description: string;
}
export interface WidgetDefinition {
  type: WidgetType;
  version: 1 | 2;
  properties: PropertyDefinition[];
  styles: PropertyDefinition[];
  events: EventDefinition[];
  states: readonly string[];
}
export interface PropertyIssue {
  path: string;
  message: string;
}
export function resolveWidgetResourceScope(widget: Widget, project: Project) {
  const module = project.modules.find((entry) => entry.id === widget.moduleId);
  const owner = project.modules.find((entry) => entry.widgets.includes(widget));
  let scopeId = widget.resourceScopeId ?? module?.resourceScopeId;
  const visited = new Set<string>();
  let parentId = widget.parentId;
  while (!scopeId && parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = (owner?.widgets ?? project.widgets).find((item) => item.id === parentId);
    scopeId = parent?.resourceScopeId;
    parentId = parent?.parentId;
  }
  return (
    project.resourceScopes?.find((scope) => scope.id === (scopeId ?? owner?.resourceScopeId)) ??
    module?.embeddedResourceScope ??
    owner?.embeddedResourceScope
  );
}
export const WIDGET_STATES = ['hover', 'pressed', 'focus', 'disabled'] as const;
const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
export function isSafePath(path: readonly (string | number)[]): boolean {
  return (
    Array.isArray(path) &&
    path.length <= 32 &&
    path.every((part) =>
      typeof part === 'number'
        ? Number.isSafeInteger(part) && part >= 0
        : typeof part === 'string' && !blockedKeys.has(part),
    )
  );
}
/** Simple property names remain compatible; nested properties use RFC 6901 pointers. */
export function propertyPath(key: string): JsonPath {
  const parts = key.startsWith('/')
    ? key
        .slice(1)
        .split('/')
        .map((part) => {
          if (/~(?![01])/u.test(part)) throw new Error('Invalid JSON pointer escape');
          return part.replace(/~1/g, '/').replace(/~0/g, '~');
        })
    : [key];
  if (!key || !isSafePath(parts)) throw new Error('Invalid property path');
  return parts;
}
export function getJsonPath(
  value: unknown,
  path: readonly (string | number)[] = [],
): Json | undefined {
  if (!isSafePath(path)) return undefined;
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part))
      return undefined;
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(String(part))) return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current as Json | undefined;
}
export function setJsonPath<T extends Json>(
  value: T,
  path: readonly (string | number)[],
  next: Json,
): T {
  if (!isSafePath(path)) throw new Error('Invalid JSON path');
  if (!path.length) return structuredClone(next) as T;
  const copy = structuredClone(value);
  let current: Json = copy;
  path.forEach((part, index) => {
    if (current === null || typeof current !== 'object')
      throw new Error('JSON path does not exist');
    if (
      Array.isArray(current) &&
      (!/^(0|[1-9]\d*)$/.test(String(part)) || Number(part) >= current.length)
    )
      throw new Error('Array path does not exist');
    if (index === path.length - 1)
      (current as Record<string | number, Json>)[part] = structuredClone(next);
    else {
      if (!Object.hasOwn(current, part)) throw new Error('JSON path does not exist');
      current = (current as Record<string | number, Json>)[part];
    }
  });
  return copy;
}
export function setProperty(
  props: Record<string, Json>,
  key: string,
  value: Json,
): Record<string, Json> {
  return setJsonPath(props, propertyPath(key), value);
}
export function remapArrayBindings(
  bindings: Widget['bindings'],
  key: string,
  before: Json[],
  after: Json[],
): Widget['bindings'] {
  const ids = (items: Json[]) =>
    items.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item) ? item.id : undefined,
    );
  const previous = ids(before),
    next = ids(after),
    result: Widget['bindings'] = {};
  for (const [property, binding] of Object.entries(bindings)) {
    const path = propertyPath(property);
    if (path[0] !== key || path.length < 2) {
      result[property] = binding;
      continue;
    }
    const oldIndex = Number(path[1]),
      id = previous[oldIndex];
    const index = id === undefined ? -1 : next.indexOf(id);
    if (index >= 0)
      result[
        '/' +
          [key, index, ...path.slice(2)]
            .map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1'))
            .join('/')
      ] = binding;
  }
  return result;
}

const p = (
  key: string,
  zh: string,
  en: string,
  value: Json,
  extra: Partial<PropertyDefinition> = {},
): PropertyDefinition => ({
  key,
  label: { zh, en },
  group: 'content',
  type:
    typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'boolean'
        : typeof value === 'string'
          ? 'string'
          : 'json',
  editor:
    typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'toggle'
        : typeof value === 'string'
          ? 'text'
          : 'json',
  initialValue: value,
  fallbackValue: value,
  ...extra,
});
const bind = (type: string, twoWay = false): PropertyDefinition['binding'] => ({
  modes: twoWay ? ['oneWay', 'twoWay', 'once'] : ['oneWay', 'once'],
  variableTypes: [type, 'json'],
  ...(twoWay ? { writeEvent: 'change' } : {}),
});
const n = (
  key: string,
  zh: string,
  en: string,
  value: number,
  min?: number,
  max?: number,
  extra: Partial<PropertyDefinition> = {},
) => p(key, zh, en, value, { min, max, step: 1, ...extra });
const choice = (
  key: string,
  zh: string,
  en: string,
  value: string,
  values: string[],
  extra: Partial<PropertyDefinition> = {},
) => p(key, zh, en, value, { editor: 'select', enum: values, ...extra });
const color = (key: string, zh: string, en: string, value: string) =>
  p(key, zh, en, value, { editor: 'color', group: 'appearance' });
const text = () =>
  p('text', '文本', 'Text', '文本', {
    editor: 'textarea',
    fallbackValue: '',
    type: 'json',
    binding: { modes: ['oneWay', 'once'], variableTypes: ['string', 'number', 'boolean', 'json'] },
  });
const value = (kind: string, initial: Json = '', twoWay = true) =>
  p('value', '数值 / 内容', 'Value', initial, {
    fallbackValue: kind === 'number' ? 0 : initial,
    group: 'data',
    binding: bind(kind, twoWay),
  });
const range = () => [
  n('min', '最小值', 'Minimum', 0, undefined, undefined, {
    group: 'data',
    binding: bind('number'),
  }),
  n('max', '最大值', 'Maximum', 100, undefined, undefined, {
    group: 'data',
    binding: bind('number'),
  }),
];
const unit = () => p('unit', '单位', 'Unit', '');
const precision = () => n('precision', '小数位', 'Decimal places', 2, 0, 12, { integer: true });
const focusEvents: EventDefinition[] = [
  { name: 'focus', payload: 'null', description: '获得焦点 / Focused' },
  { name: 'blur', payload: 'null', description: '失去焦点 / Blurred' },
];
const change = (payload: EventDefinition['payload']): EventDefinition[] => [
  { name: 'change', payload, description: '值改变 / Value changed' },
  ...focusEvents,
];
const common = [
  p('enabled', '启用', 'Enabled', true, { group: 'behavior', binding: bind('boolean') }),
  p('visible', '可见', 'Visible', true, { group: 'behavior', binding: bind('boolean') }),
  p('title', '提示文字', 'Tooltip', '', { group: 'behavior', binding: bind('string') }),
];
export const STYLE_DEFINITIONS: PropertyDefinition[] = [
  color('color', '文字颜色', 'Text color', '$color.text'),
  color('background', '背景颜色', 'Background', 'transparent'),
  n('fontSize', '字号', 'Font size', 14, 1, 500),
  n('fontWeight', '字重', 'Font weight', 400, 100, 900, { step: 100 }),
  p('fontFamily', '字体', 'Font family', 'inherit'),
  choice('fontStyle', '字体样式', 'Font style', 'normal', ['normal', 'italic', 'oblique']),
  choice('textDecoration', '文字装饰', 'Text decoration', 'none', [
    'none',
    'underline',
    'line-through',
  ]),
  choice('textAlign', '文本对齐', 'Text align', 'left', ['left', 'center', 'right']),
  n('borderRadius', '圆角', 'Radius', 8, 0, 1000),
  n('borderWidth', '边框宽度', 'Border width', 0, 0, 100),
  color('borderColor', '边框颜色', 'Border color', '$color.border'),
  choice('borderStyle', '边框样式', 'Border style', 'solid', [
    'none',
    'solid',
    'dashed',
    'dotted',
    'double',
  ]),
  n('padding', '内边距', 'Padding', 0, 0, 1000),
  ...(['Top', 'Right', 'Bottom', 'Left'] as const).map((side, index) =>
    n(
      `padding${side}`,
      ['上内边距', '右内边距', '下内边距', '左内边距'][index],
      `Padding ${side.toLowerCase()}`,
      0,
      0,
      1000,
    ),
  ),
  ...(['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const).map((corner, index) =>
    n(
      `border${corner}Radius`,
      ['左上圆角', '右上圆角', '右下圆角', '左下圆角'][index],
      `Radius ${corner}`,
      8,
      0,
      1000,
    ),
  ),
  n('opacity', '不透明度', 'Opacity', 1, 0, 1, { step: 0.05 }),
  p('boxShadow', '阴影', 'Shadow', 'none'),
  n('lineHeight', '行高', 'Line height', 1.4, 0.5, 10, { step: 0.1 }),
  n('letterSpacing', '字间距', 'Letter spacing', 0, -20, 100, { step: 0.1 }),
].map((entry) => ({ ...entry, group: 'appearance', stateful: true, target: 'surface' }));
const containerStyle = [
  choice('alignItems', '交叉轴对齐', 'Align items', 'stretch', [
    'stretch',
    'flex-start',
    'center',
    'flex-end',
  ]),
  choice('justifyContent', '主轴对齐', 'Justify content', 'flex-start', [
    'flex-start',
    'center',
    'flex-end',
    'space-between',
    'space-around',
    'space-evenly',
  ]),
].map((entry) => ({ ...entry, group: 'appearance' as const, stateful: true, target: 'children' }));
function initialWidgetStyle(type: WidgetType): WidgetStyle {
  const style: WidgetStyle = { color: '$color.text', fontSize: 14, borderRadius: 8 };
  if (type === 'button')
    Object.assign(style, { background: '$color.primary', color: '#ffffff', fontWeight: 600 });
  if (type === 'panel')
    Object.assign(style, {
      background: '$color.surface',
      borderWidth: 1,
      borderColor: '$color.border',
      borderStyle: 'solid',
      borderRadius: 12,
    });
  if (type === 'gauge') style.fontSize = 29;
  if (['input', 'number', 'select'].includes(type))
    Object.assign(style, {
      background: '$color.surface',
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: '$color.border',
      padding: 8,
    });
  return style;
}
const definitions: Record<
  WidgetType,
  { properties: PropertyDefinition[]; events?: EventDefinition[] }
> = {
  panel: {
    properties: [choice('overflow', '溢出', 'Overflow', 'hidden', ['hidden', 'auto', 'visible'])],
  },
  text: {
    properties: [
      text(),
      unit(),
      p('wrap', '自动换行', 'Wrap', true),
      choice('overflow', '文本溢出', 'Text overflow', 'clip', ['clip', 'ellipsis']),
      choice('verticalAlign', '垂直对齐', 'Vertical align', 'center', ['start', 'center', 'end']),
      p('selectable', '允许选择文字', 'Selectable', false),
    ],
  },
  button: {
    properties: [
      { ...text(), initialValue: '按钮' },
      p('iconAssetId', '图标资源', 'Icon asset', '', {
        editor: 'asset',
        reference: 'asset',
        binding: bind('string'),
      }),
      choice('iconPosition', '图标位置', 'Icon position', 'left', ['left', 'right']),
      n('iconSize', '图标大小', 'Icon size', 16, 8, 256),
    ],
    events: [{ name: 'click', payload: 'null', description: '点击 / Clicked' }, ...focusEvents],
  },
  input: {
    properties: [
      value('string'),
      p('placeholder', '占位文字', 'Placeholder', '输入内容', {
        fallbackValue: '',
        binding: bind('string'),
      }),
      choice('inputType', '输入类型', 'Input type', 'text', [
        'text',
        'password',
        'email',
        'search',
        'tel',
        'url',
      ]),
      p('multiline', '多行输入', 'Multiline', false),
      p('readOnly', '只读', 'Read only', false),
      n('maxLength', '最大长度（0不限）', 'Maximum length (0 unlimited)', 0, 0, 1000000, {
        integer: true,
      }),
      choice('submitOn', '提交时机', 'Submit on', 'enter', ['enter', 'blur', 'both'], {
        fallbackValue: 'blur',
      }),
    ],
    events: [
      ...change('string'),
      {
        name: 'submit',
        payload: 'string',
        description: '按配置提交 / Committed according to submitOn',
      },
    ],
  },
  number: {
    properties: [
      value('number', 42),
      ...range(),
      n('step', '步长', 'Step', 1, 0.000000001, 1e12, { binding: bind('number') }),
      precision(),
      unit(),
      p('readOnly', '只读', 'Read only', false),
    ],
    events: [
      ...change('number'),
      { name: 'submit', payload: 'number', description: 'Enter 或失焦提交 / Enter or blur' },
    ],
  },
  switch: {
    properties: [
      { ...text(), initialValue: '开关' },
      value('boolean', false),
      p('onText', '开启文字', 'On text', ''),
      p('offText', '关闭文字', 'Off text', ''),
      color('onColor', '开启颜色', 'On color', '$color.primary'),
      color('offColor', '关闭颜色', 'Off color', '$color.border'),
    ],
    events: change('boolean'),
  },
  slider: {
    properties: [
      value('number', 42),
      ...range(),
      n('step', '步长', 'Step', 1, 0.000000001, 1e12, { binding: bind('number') }),
      precision(),
      unit(),
      p('showValue', '显示数值', 'Show value', true),
      choice('orientation', '方向', 'Orientation', 'horizontal', ['horizontal', 'vertical']),
      color('fillColor', '滑块颜色', 'Accent color', '$color.primary'),
    ],
    events: change('number'),
  },
  progress: {
    properties: [
      value('number', 42, false),
      ...range(),
      unit(),
      precision(),
      p('showValue', '显示数值', 'Show value', false),
      choice('orientation', '方向', 'Orientation', 'horizontal', ['horizontal', 'vertical']),
      color('fillColor', '填充颜色', 'Fill color', '$color.primary'),
      color('trackColor', '轨道颜色', 'Track color', '$color.border'),
    ],
  },
  gauge: {
    properties: [
      value('number', 42, false),
      ...range(),
      { ...unit(), initialValue: '°C' },
      precision(),
      p('showValue', '显示数值', 'Show value', true),
      n('startAngle', '起始角度', 'Start angle', 180, -360, 360),
      n('sweepAngle', '扫过角度', 'Sweep angle', 180, 1, 359),
      n('strokeWidth', '弧线宽度', 'Stroke width', 8, 1, 40),
      color('fillColor', '弧线颜色', 'Arc color', '$color.primary'),
      color('trackColor', '轨道颜色', 'Track color', '$color.border'),
    ],
  },
  chart: {
    properties: [
      choice('mode', '数据模式', 'Data mode', 'realtime', ['realtime', 'history']),
      p(
        'series',
        '曲线',
        'Series',
        [{ id: 'series_1', name: '曲线 1', value: 42, color: '$color.primary', visible: true }],
        { editor: 'series', group: 'data' },
      ),
      ...range(),
      n('sampleInterval', '采样间隔 (ms)', 'Sample interval (ms)', 250, 50, 60000, {
        integer: true,
      }),
      n('maxPoints', '最多采样点', 'Maximum points', 600, 2, 10000, { integer: true }),
      p('showLegend', '图例', 'Legend', true),
      p('showGrid', '网格线', 'Grid', true),
      n('lineWidth', '线宽', 'Line width', 2, 0.5, 20, { step: 0.5 }),
      n('historyDuration', '历史范围 (秒)', 'History range (seconds)', 3600, 1, 2592000, {
        integer: true,
      }),
      n(
        'historyFrom',
        '起始时间戳（0为相对范围）',
        'Start timestamp (0 relative)',
        0,
        0,
        8640000000000000,
        { integer: true },
      ),
      n('historyTo', '结束时间戳（0为现在）', 'End timestamp (0 now)', 0, 0, 8640000000000000, {
        integer: true,
      }),
      choice('historyAggregation', '历史聚合', 'History aggregation', 'avg', [
        'raw',
        'avg',
        'min',
        'max',
        'last',
      ]),
      unit(),
    ],
  },
  image: {
    properties: [
      p('assetId', '图片资源', 'Image asset', '', {
        editor: 'asset',
        reference: 'asset',
        binding: bind('string'),
      }),
      p('alt', '替代文字', 'Alternative text', '', { binding: bind('string') }),
      choice('fit', '缩放方式', 'Fit', 'contain', [
        'contain',
        'cover',
        'fill',
        'none',
        'scale-down',
      ]),
      p('objectPosition', '图片位置', 'Image position', 'center'),
    ],
  },
  select: {
    properties: [
      {
        ...value('string', '自动'),
        type: 'json',
        binding: {
          modes: ['oneWay', 'twoWay', 'once'],
          variableTypes: ['string', 'number', 'boolean', 'json'],
          writeEvent: 'change',
        },
      },
      p(
        'options',
        '选项',
        'Options',
        [
          { id: 'option_1', label: '自动', value: '自动', disabled: false },
          { id: 'option_2', label: '手动', value: '手动', disabled: false },
        ],
        { editor: 'options', binding: bind('json') },
      ),
      p('placeholder', '占位文字', 'Placeholder', ''),
    ],
    events: change('json'),
  },
  table: {
    properties: [
      p(
        'rows',
        '数据行',
        'Rows',
        [
          { device: '泵 A', value: 42 },
          { device: '泵 B', value: 0 },
        ],
        { editor: 'json', group: 'data', binding: bind('json') },
      ),
      p(
        'columns',
        '列',
        'Columns',
        [
          { id: 'device', title: '设备', path: ['device'], align: 'left' },
          { id: 'value', title: '数值', path: ['value'], align: 'right' },
        ],
        { editor: 'columns', group: 'data' },
      ),
      p('headerVisible', '显示表头', 'Show header', true),
      p('sortable', '允许排序', 'Sortable', true),
      p('striped', '隔行背景', 'Striped', true),
      n('pageSize', '每页行数', 'Page size', 20, 1, 1000, { integer: true }),
      n('rowHeight', '行高', 'Row height', 36, 16, 200, { integer: true }),
      p('emptyText', '空数据提示', 'Empty message', '暂无数据'),
    ],
    events: [
      {
        name: 'rowClick',
        payload: 'json',
        description: '{row,index}：原始数据行及其索引 / Original row and index',
      },
    ],
  },
  module: { properties: [] },
};

export function getWidgetDefinition(
  type: WidgetType,
  version: 1 | 2 = 2,
  module?: ComponentModule,
): WidgetDefinition {
  const base = definitions[type];
  const supplied = (
    module as
      | (ComponentModule & {
          propertyDefinitions?: PropertyDefinition[] | Record<string, Partial<PropertyDefinition>>;
        })
      | undefined
  )?.propertyDefinitions;
  const moduleProperties =
    type === 'module' && module
      ? Object.entries(module.exposedProps).map(([key, exposed]) => {
          const configured = Array.isArray(supplied)
            ? supplied.find((entry) => entry.key === key)
            : supplied?.[key];
          return p(key, key, key, exposed.default, {
            binding: bind(typeof exposed.default === 'object' ? 'json' : typeof exposed.default),
            ...configured,
            key,
          });
        })
      : [];
  return {
    type,
    version,
    properties: [
      ...common.filter((entry) => !moduleProperties.some((item) => item.key === entry.key)),
      ...base.properties,
      ...moduleProperties,
    ],
    styles: (type === 'panel' ? [...STYLE_DEFINITIONS, ...containerStyle] : STYLE_DEFINITIONS).map(
      (entry) => ({
        ...entry,
        initialValue: initialWidgetStyle(type)[entry.key] ?? entry.initialValue,
      }),
    ),
    events:
      type === 'module'
        ? (module?.implementation?.events ?? []).map((name) => ({
            name,
            payload: 'json',
            description: name,
          }))
        : (base.events ?? []),
    states: WIDGET_STATES,
  };
}
export function createWidgetDefaults(
  type: WidgetType,
  version: 1 | 2 = 2,
): Pick<Widget, 'props' | 'style' | 'states'> {
  const definition = getWidgetDefinition(type, version);
  const props = Object.fromEntries(
    definition.properties.map((entry) => [entry.key, structuredClone(entry.initialValue)]),
  );
  return { props, style: initialWidgetStyle(type), states: {} };
}
export function resolvedWidgetProps(
  widget: Widget,
  module?: ComponentModule,
): Record<string, Json> {
  const props = Object.fromEntries(
    getWidgetDefinition(widget.type, 2, module).properties.map((entry) => [
      entry.key,
      structuredClone(entry.fallbackValue),
    ]),
  );
  return { ...props, ...widget.props };
}
export function getBindableProperties(
  widget: Widget,
  module?: ComponentModule,
): PropertyDefinition[] {
  const definition = getWidgetDefinition(widget.type, 2, module);
  const result = definition.properties.filter((entry) => !!entry.binding);
  const series = resolvedWidgetProps(widget, module).series;
  if (widget.type === 'chart' && Array.isArray(series))
    series.forEach((series, index) => {
      const name =
        series && typeof series === 'object' && !Array.isArray(series)
          ? String(series.name ?? index + 1)
          : String(index + 1);
      result.push(
        p(`/series/${index}/value`, `${name} · 数值`, `${name} · value`, 0, {
          binding: bind('number'),
        }),
      );
    });
  return result;
}
export function validatePropertyValue(
  definition: PropertyDefinition,
  value: Json,
): string | undefined {
  if (definition.type !== 'json' && typeof value !== definition.type)
    return `Expected ${definition.type}`;
  if (
    definition.editor === 'color' &&
    typeof value === 'string' &&
    /url\s*\(|expression\s*\(|@import|javascript:/i.test(value)
  )
    return 'Color values cannot load external resources';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'A finite number is required';
    if (definition.integer && !Number.isInteger(value)) return 'An integer is required';
    if (definition.min !== undefined && value < definition.min) return `Minimum: ${definition.min}`;
    if (definition.max !== undefined && value > definition.max) return `Maximum: ${definition.max}`;
  }
  if (definition.enum && !definition.enum.includes(value as string | number))
    return 'Choose a supported value';
  return undefined;
}
/** Pick a compatible JSON leaf when creating a binding, without exposing an invalid intermediate binding. */
export function inferBindingPath(
  value: Json,
  definition: PropertyDefinition,
): JsonPath | undefined {
  const queue: { value: Json; path: JsonPath }[] = [{ value, path: [] }];
  let visited = 0;
  while (queue.length && visited++ < 10000) {
    const candidate = queue.shift()!;
    if (!validatePropertyValue(definition, candidate.value)) return candidate.path;
    if (
      candidate.path.length >= 32 ||
      candidate.value === null ||
      typeof candidate.value !== 'object'
    )
      continue;
    for (const [key, value] of Object.entries(candidate.value)) {
      const part = Array.isArray(candidate.value) ? Number(key) : key;
      const path = [...candidate.path, part];
      if (isSafePath(path)) queue.push({ value, path });
    }
  }
  return undefined;
}
export function validatePropertyPatch(
  widget: Widget,
  patch: Partial<Widget>,
  project?: Project,
): PropertyIssue[] {
  if (
    (widget as Widget & { definitionVersion?: number }).definitionVersion !== 2 &&
    (patch as Partial<Widget> & { definitionVersion?: number }).definitionVersion !== 2
  )
    return [];
  const next = { ...widget, ...patch },
    module = project?.modules.find((entry) => entry.id === next.moduleId);
  const definition = getWidgetDefinition(next.type, 2, module),
    issues: PropertyIssue[] = [];
  const resources = project
    ? (resolveWidgetResourceScope(next, project) ?? resolveWidgetResourceScope(widget, project))
    : undefined;
  const issue = (path: string, message: string) => issues.push({ path, message });
  for (const entry of definition.properties) {
    const value = next.props[entry.key];
    if (value === undefined) continue;
    const error = validatePropertyValue(entry, value);
    if (error) issue(`props.${entry.key}`, error);
    if (
      entry.reference === 'asset' &&
      value &&
      project &&
      !resources?.assets?.some((asset) => asset.id === value) &&
      !project.assets.some(
        (asset) => asset.id === (resources?.assetAliases?.[String(value)] ?? value),
      )
    )
      issue(`props.${entry.key}`, 'Image asset does not exist');
  }
  const props = resolvedWidgetProps(next, module);
  if (
    definition.properties.some((entry) => entry.key === 'min') &&
    typeof props.min === 'number' &&
    typeof props.max === 'number' &&
    props.min >= props.max
  )
    issue('props.max', 'Maximum must exceed minimum');
  for (const [state, styles] of Object.entries({ default: next.style, ...next.states })) {
    if (state !== 'default' && !WIDGET_STATES.includes(state as (typeof WIDGET_STATES)[number]))
      continue; // unknown legacy extensions are retained
    for (const [key, value] of Object.entries(styles)) {
      if (
        typeof value === 'string' &&
        /url\s*\(|expression\s*\(|@import|javascript:/i.test(value)
      ) {
        issue(
          `${state === 'default' ? 'style' : `states.${state}`}.${key}`,
          'External CSS resources are not allowed',
        );
        continue;
      }
      const entry = definition.styles.find((property) => property.key === key);
      if (!entry) continue;
      // Existing CSS lengths/tokens remain valid; numerical editors only create bounded numbers.
      const error =
        typeof value === 'string' && entry.type === 'number'
          ? undefined
          : validatePropertyValue(entry, value);
      if (error) issue(`${state === 'default' ? 'style' : `states.${state}`}.${key}`, error);
    }
  }
  const array = (key: string, max: number) => {
    const values = props[key];
    if (!Array.isArray(values)) {
      issue(`props.${key}`, 'Expected an array');
      return [];
    }
    if (values.length > max) issue(`props.${key}`, `At most ${max} items`);
    return values;
  };
  if (next.type === 'chart' || next.type === 'table' || next.type === 'select') {
    const key = next.type === 'chart' ? 'series' : next.type === 'table' ? 'columns' : 'options';
    const items = array(key, key === 'series' ? 16 : 1000),
      ids = new Set<string>(),
      optionValues = new Set<string>();
    items.forEach((item, index) => {
      if (key === 'options' && ['string', 'number', 'boolean'].includes(typeof item)) {
        const value = JSON.stringify(item);
        if (optionValues.has(value)) issue(`props.${key}.${index}`, 'Option values must be unique');
        optionValues.add(value);
        return;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        issue(`props.${key}.${index}`, 'Expected an object');
        return;
      }
      if (typeof item.id !== 'string' || !item.id || ids.has(item.id))
        issue(`props.${key}.${index}.id`, 'A unique stable ID is required');
      else ids.add(item.id);
      if (key === 'series') {
        if (typeof item.name !== 'string' || typeof item.color !== 'string')
          issue(`props.${key}.${index}`, 'Series name and color must be strings');
        if (typeof item.value !== 'number' || !Number.isFinite(item.value))
          issue(`props.${key}.${index}.value`, 'A finite number is required');
        if (item.visible !== undefined && typeof item.visible !== 'boolean')
          issue(`props.${key}.${index}.visible`, 'Expected boolean');
        if (
          item.variableId !== undefined &&
          (typeof item.variableId !== 'string' ||
            (project &&
              !project.variables.some((v) => v.id === item.variableId && v.type === 'number')))
        )
          issue(
            `props.${key}.${index}.variableId`,
            'History requires an existing numeric variable',
          );
      }
      if (key === 'columns' && (!Array.isArray(item.path) || !isSafePath(item.path as JsonPath)))
        issue(`props.${key}.${index}.path`, 'Expected a safe JSON path array');
      if (key === 'columns') {
        if (typeof item.title !== 'string')
          issue(`props.${key}.${index}.title`, 'Column title must be a string');
        if (
          item.width !== undefined &&
          (typeof item.width !== 'number' ||
            !Number.isFinite(item.width) ||
            item.width < 0 ||
            item.width > 10000)
        )
          issue(`props.${key}.${index}.width`, 'Column width must be between 0 and 10000');
        if (item.align !== undefined && !['left', 'center', 'right'].includes(String(item.align)))
          issue(`props.${key}.${index}.align`, 'Unsupported column alignment');
        if (item.format !== undefined && !['text', 'number', 'json'].includes(String(item.format)))
          issue(`props.${key}.${index}.format`, 'Unsupported column format');
      }
      if (key === 'options') {
        if (typeof item.label !== 'string')
          issue(`props.${key}.${index}.label`, 'Option label must be a string');
        if (item.disabled !== undefined && typeof item.disabled !== 'boolean')
          issue(`props.${key}.${index}.disabled`, 'Expected boolean');
        if (!['string', 'number', 'boolean'].includes(typeof item.value))
          issue(
            `props.${key}.${index}.value`,
            'Option values must be strings, numbers or booleans',
          );
        const value = JSON.stringify(item.value);
        if (optionValues.has(value))
          issue(`props.${key}.${index}.value`, 'Option values must be unique');
        optionValues.add(value);
      }
    });
    if (next.type === 'table') array('rows', 100000);
  }
  const bindable = getBindableProperties(next, module);
  const targets = new Set<string>();
  for (const [key, binding] of Object.entries(next.bindings)) {
    try {
      const target = JSON.stringify(propertyPath(key));
      if (targets.has(target)) issue(`bindings.${key}`, 'A property can only have one binding');
      targets.add(target);
    } catch {
      issue(`bindings.${key}`, 'Invalid property path');
    }
    const entry = bindable.find((item) => item.key === key || item.key === key.replace(/^\//, ''));
    if (!entry) {
      issue(`bindings.${key}`, 'Property does not support binding');
      continue;
    }
    if (!entry.binding!.modes.includes(binding.mode))
      issue(`bindings.${key}.mode`, 'Binding mode is not supported');
    const path = (binding as Binding & { path?: JsonPath }).path;
    if (path !== undefined && !isSafePath(path)) issue(`bindings.${key}.path`, 'Invalid JSON path');
    const variable = project?.variables.find(
      (v) => v.id === binding.variable || v.name === binding.variable,
    );
    if (project && !variable) issue(`bindings.${key}.variable`, 'Variable does not exist');
    if (variable && !entry.binding!.variableTypes.includes(variable.type))
      issue(`bindings.${key}.variable`, 'Variable type is incompatible');
    if (variable && path?.length && (variable.type as string) !== 'json')
      issue(`bindings.${key}.path`, 'Paths require a JSON variable');
    if (variable && binding.mode === 'twoWay' && variable.readOnly)
      issue(`bindings.${key}`, 'Cannot write a read-only variable');
    if (variable && variable.type === 'json') {
      const leaf = getJsonPath(variable.initial, path ?? []);
      if (leaf === undefined || validatePropertyValue(entry, leaf))
        issue(`bindings.${key}.path`, 'Path must resolve to a compatible value');
    }
  }
  return issues;
}
