import type { Json, Project, Widget } from './types';
import { createWidgetDefaults, propertyPath } from './widgetDefinitions';

/** Explicitly upgrade an isolated copy; existing v4 documents are never downgraded. */
export function upgradeProject(project: Project, minimumVersion: 3 | 4 = 3): Project {
  if (minimumVersion !== 3 && minimumVersion !== 4)
    throw new Error(`Unsupported upgrade target: ${minimumVersion}`);
  if (![1, 2, 3, 4].includes(project.schemaVersion))
    throw new Error(`Unsupported project schemaVersion: ${project.schemaVersion}`);
  const next = structuredClone(project);
  next.schemaVersion = Math.max(next.schemaVersion, minimumVersion) as 3 | 4;
  next.windows ??= [];
  for (const widget of [
    ...next.widgets,
    ...next.windows.flatMap((window) => window.widgets),
    ...next.modules.flatMap((module) => module.widgets),
  ])
    widget.definitionVersion ??= 1;
  return next;
}

/** Match the legacy renderer, including its numeric formatting and JSON option labels. */
const legacyPrintable = (value: Json | undefined): string =>
  typeof value === 'number'
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)
    : typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value);
const legacyNumber = (value: Json | undefined, fallback: number): number => {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) throw new Error('Cannot upgrade a non-finite numeric widget value');
  return number;
};
export function upgradeWidget(widget: Widget, project?: Project): Widget {
  const next = structuredClone(widget);
  if (next.definitionVersion === 2) return next;
  const original = widget.props;
  const derived = (key: string, value: Json) => {
    if (Object.hasOwn(original, key) && JSON.stringify(original[key]) !== JSON.stringify(value))
      throw new Error(
        `Legacy extension props.${key} conflicts with the upgrade; review it before upgrading`,
      );
    next.props[key] = value;
  };
  const hasBinding = (property: string) =>
    Object.keys(next.bindings).some((key) => {
      const path = propertyPath(key);
      return path.length === 1 && path[0] === property;
    });
  next.definitionVersion = 2;
  // Bindings authored with names must continue to read the ID-keyed runtime snapshot.
  if (project)
    for (const binding of Object.values(next.bindings)) {
      const variable =
        project.variables.find((entry) => entry.id === binding.variable) ??
        project.variables.find((entry) => entry.name === binding.variable);
      if (variable) binding.variable = variable.id;
    }
  if (['number', 'slider', 'progress', 'gauge'].includes(next.type)) {
    next.props.value = legacyNumber(original.value, 0);
    next.props.min = legacyNumber(original.min, next.type === 'number' ? -Number.MAX_VALUE : 0);
    next.props.max = legacyNumber(original.max, next.type === 'number' ? Number.MAX_VALUE : 100);
    next.props.precision ??= 3;
  }
  if (next.type === 'chart') {
    next.props.min = legacyNumber(original.min, 0);
    next.props.max = legacyNumber(original.max, 100);
    derived('series', [
      {
        id: 'series_1',
        name: widget.name || 'Series 1',
        value: legacyNumber(original.value, 0),
        color: '$color.primary',
        visible: true,
      },
    ]);
    derived('mode', 'realtime');
    next.props.sampleInterval ??= 250;
    next.props.maxPoints ??= 600;
    for (const [key, binding] of Object.entries(next.bindings)) {
      const path = propertyPath(key);
      if (path.length === 1 && path[0] === 'value') {
        delete next.bindings[key];
        next.bindings['/series/0/value'] = binding;
      }
    }
  }
  if (next.type === 'table') {
    const rows = Array.isArray(original.rows)
      ? original.rows.map((row) => (Array.isArray(row) ? row : [row]))
      : [];
    const header = rows[0] ?? [];
    const count = rows.reduce((max, row) => Math.max(max, row.length), 0);
    derived(
      'columns',
      Array.from({ length: count }, (_, index) => ({
        id: `column_${index + 1}`,
        title: legacyPrintable(header[index]),
        path: [index],
        align: 'left',
        format: 'text',
      })),
    );
    const dynamic = hasBinding('rows');
    next.props.rows = dynamic ? rows : rows.slice(1);
    derived('headerFromFirstRow', dynamic);
    derived('headerVisible', true);
    next.props.sortable ??= false;
    if (next.style.fontSize === 14 || next.style.fontSize === undefined) next.style.fontSize = 12;
  }
  if (next.type === 'select') {
    const dynamic = hasBinding('options'),
      options = Array.isArray(original.options) ? original.options : [];
    next.props.options = dynamic
      ? options
      : options.map((option, index) => {
          const printed = legacyPrintable(option);
          return { id: `option_${index + 1}`, label: printed, value: printed, disabled: false };
        });
    next.props.value = legacyPrintable(original.value);
    derived('legacyOptions', dynamic);
    derived('legacyValueFormat', true);
  }
  if (next.type === 'input') {
    next.props.value = legacyPrintable(original.value);
    next.props.placeholder = String(original.placeholder ?? '');
    derived('submitOn', 'blur');
    derived('multiline', false);
    derived('inputType', 'text');
  }
  if (next.type === 'switch') next.props.value = Boolean(original.value ?? false);
  if (next.type === 'image') {
    next.props.alt ??= widget.name;
    next.props.fit ??= 'contain';
  }
  if (['input', 'number', 'select'].includes(next.type))
    next.style = { ...createWidgetDefaults(next.type).style, padding: '0 12px', ...next.style };
  if (next.type === 'gauge' && (next.style.fontSize === undefined || next.style.fontSize === 14))
    next.style.fontSize = 29;
  if (next.type === 'module' && project) {
    const module = project.modules.find((entry) => entry.id === next.moduleId);
    for (const [key, exposed] of Object.entries(module?.exposedProps ?? {}))
      if (next.props[key] === null) next.props[key] = structuredClone(exposed.default);
  }
  return next;
}

export function migrationSummary(project: Project, minimumVersion: 3 | 4 = 3): string[] {
  const format =
    project.schemaVersion >= minimumVersion
      ? []
      : project.locale === 'zh-CN'
        ? [
            `升级工程格式为 v${minimumVersion}；旧设计器将拒绝打开新版副本。`,
            '现有控件保留旧版行为，只有明确升级的控件启用新属性。',
            '原始工程文件不会被自动覆盖；建议另存为新版副本。',
          ]
        : [
            `Upgrade this working copy to v${minimumVersion}; older designers cannot open it.`,
            'Existing widgets retain legacy behavior until explicitly upgraded.',
            'The original file is not overwritten automatically; save a separate upgraded copy.',
          ];
  return [
    ...format,
    ...(project.schemaVersion < 3
      ? [
          project.locale === 'zh-CN'
            ? 'v1/v2 明确升级后沿用 v3 严格流程语义：数学和有序比较要求数值，JSON 相等使用结构比较，写入节点输出实际写入值。'
            : 'Explicit v1/v2 upgrades adopt the existing v3 strict flow rules: numeric math and ordered comparisons, structural JSON equality, and write nodes output the written value.',
        ]
      : []),
    ...(project.locale === 'zh-CN'
      ? [
          '明确升级控件时：旧趋势 value 与绑定转为第一条曲线，使用 250 ms 定时采样；旧表格首行转为列标题，剩余行保留为数据。',
          '旧选择框保持原格式化标签和值，文本输入继续在失焦时提交；容器隐藏、禁用、内边距及继承样式按新版规则生效。',
          '未识别的扩展属性会保留；无法表示的新类型约束会阻止升级，不会覆盖原控件。',
        ]
      : [
          'Explicit widget upgrades move the legacy trend value and binding to the first series, sampled every 250 ms. The first table row becomes column headers; the remaining rows remain data.',
          'Select labels and values retain their legacy formatting, and text inputs continue submitting on blur. Containers adopt the new visibility, disabled, padding and inherited-style behavior.',
          'Unrecognized extension properties are retained. Unrepresentable type constraints block the upgrade without replacing the original widget.',
        ]),
  ];
}
