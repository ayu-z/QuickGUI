import type { Project, Widget, WidgetType } from './types';
import { createWidgetDefaults } from './widgetDefinitions';

export const uid = (prefix = 'id') => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
export function createEmptyProject(name = '未命名工程'): Project {
  const project = createProject();
  return {
    ...project,
    schemaVersion: 3,
    windows: [],
    name,
    window: { ...project.window, title: name },
    publish: { ...project.publish, appName: 'QuickGUI App' },
    widgets: [],
    variables: [],
    flows: [],
    scripts: [],
    modules: [],
    assets: [],
    connections: [],
    translations: {},
  };
}
export function subtreeIds(widgets: Widget[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const widget of widgets)
      if (widget.parentId && ids.has(widget.parentId) && !ids.has(widget.id)) {
        ids.add(widget.id);
        changed = true;
      }
  }
  return ids;
}
export function cloneSubtree(widgets: Widget[], rootId: string, normalize = false): Widget[] {
  const ids = subtreeIds(widgets, rootId);
  const copies = structuredClone(widgets.filter((widget) => ids.has(widget.id)));
  const mapping = new Map(copies.map((widget) => [widget.id, uid(widget.type)]));
  for (const copy of copies) {
    const root = copy.id === rootId;
    copy.id = mapping.get(copy.id)!;
    if (root) {
      copy.layout.x = normalize ? 0 : copy.layout.x + 20;
      copy.layout.y = normalize ? 0 : copy.layout.y + 20;
      if (normalize) delete copy.parentId;
      else copy.name += ' copy';
    } else if (copy.parentId) copy.parentId = mapping.get(copy.parentId) ?? copy.parentId;
  }
  return copies;
}
export const widgetNames: Record<WidgetType, [string, string]> = {
  panel: ['容器', 'Panel'],
  text: ['文本', 'Text'],
  button: ['按钮', 'Button'],
  input: ['文本输入', 'Input'],
  number: ['数字输入', 'Number'],
  switch: ['开关', 'Switch'],
  slider: ['滑块', 'Slider'],
  progress: ['进度条', 'Progress'],
  gauge: ['仪表', 'Gauge'],
  chart: ['趋势图', 'Chart'],
  image: ['图片', 'Image'],
  select: ['选择框', 'Select'],
  table: ['数据表', 'Table'],
  module: ['组件模块', 'Module'],
};
export function createWidget(
  type: WidgetType,
  x = 32,
  y = 32,
  definitionVersion: 1 | 2 = 1,
): Widget {
  const sizes: Partial<Record<WidgetType, [number, number]>> = {
    panel: [300, 180],
    text: [220, 32],
    button: [140, 42],
    input: [220, 40],
    number: [160, 40],
    switch: [180, 32],
    slider: [220, 36],
    progress: [240, 18],
    gauge: [180, 150],
    chart: [420, 180],
    image: [180, 120],
    select: [180, 40],
    table: [440, 180],
    module: [300, 180],
  };
  const [width, height] = sizes[type] ?? [160, 40];
  const props: Record<string, unknown> = {
    text: widgetNames[type][0],
    enabled: true,
    visible: true,
  };
  if (['number', 'slider', 'progress', 'gauge', 'chart'].includes(type))
    Object.assign(props, { value: 42, min: 0, max: 100, unit: type === 'gauge' ? '°C' : '' });
  if (type === 'switch') props.value = false;
  if (type === 'input') Object.assign(props, { value: '', placeholder: '输入内容' });
  if (type === 'select') Object.assign(props, { options: ['自动', '手动'], value: '自动' });
  if (type === 'table')
    props.rows = [
      ['设备', '状态', '数值'],
      ['泵 A', '运行中', '42.0'],
      ['泵 B', '就绪', '0.0'],
    ];
  const style: Record<string, string | number> = {
    color: '$color.text',
    fontSize: 14,
    borderRadius: 8,
  };
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
  return {
    id: uid(type),
    type,
    name: widgetNames[type][0],
    layout: { x, y, width, height },
    props: props as Widget['props'],
    style,
    states: {},
    bindings: {},
    events: {},
    ...(definitionVersion === 2 ? { ...createWidgetDefaults(type, 2), definitionVersion } : {}),
  };
}

export const defaultCScript = `/* QuickGUI C SDK — compile and run in an isolated worker.\n * The same C source is used for preview and native release builds. */\n#include "quickgui.h"\n\nvoid qg_process(void) {\n    double next = qg_input_number() + 1.0;\n    qg_set_number("cycles", next);\n    qg_state_set("last_value", next);\n    qg_log("Cycle completed");\n    qg_emit_number(next);\n}\n`;

export function createProject(): Project {
  const widget = (
    type: WidgetType,
    id: string,
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    props: Widget['props'] = {},
    style: Widget['style'] = {},
  ): Widget => {
    const base = createWidget(type, x, y);
    return {
      ...base,
      id,
      name,
      layout: { x, y, width, height },
      props: { ...base.props, ...props },
      style: { ...base.style, ...style },
    };
  };
  return {
    schemaVersion: 1,
    id: uid('project'),
    name: '泵站控制面板',
    revision: 0,
    locale: 'zh-CN',
    theme: {
      mode: 'dark',
      tokens: {
        'color.primary': '#8b5cf6',
        'color.primaryHover': '#a78bfa',
        'color.text': '#edf0f7',
        'color.muted': '#969eaf',
        'color.surface': '#20232c',
        'color.background': '#17191f',
        'color.border': '#333743',
        'color.success': '#48d5a0',
        'color.warning': '#e9b66c',
      },
    },
    window: {
      title: '泵站控制面板',
      width: 960,
      height: 640,
      minWidth: 640,
      minHeight: 420,
      resizable: true,
      alwaysOnTop: false,
      fullscreen: false,
      maximized: false,
      center: true,
      rememberPosition: true,
      background: '#17191f',
      contentRadius: 0,
      cornerPreference: 'system',
    },
    publish: {
      appName: 'Pump Station',
      identifier: 'com.quickgui.pumpstation',
      version: '1.0.0',
      publisher: '',
      desktopShortcut: true,
    },
    widgets: [
      widget(
        'text',
        'heading',
        '页面标题',
        32,
        28,
        600,
        32,
        { text: '泵站控制面板' },
        { fontSize: 24, fontWeight: 600 },
      ),
      widget(
        'text',
        'subtitle',
        '页面说明',
        32,
        68,
        700,
        24,
        { text: 'PRODUCTION LINE A  /  设备运行概览' },
        { fontSize: 11, color: '$color.muted', letterSpacing: 1.2 },
      ),
      widget('panel', 'metric_panel', '温度卡片', 32, 120, 280, 180),
      widget(
        'text',
        'temperature_label',
        '温度标题',
        52,
        138,
        220,
        24,
        { text: '进水温度' },
        { color: '$color.muted', fontSize: 12 },
      ),
      {
        ...widget('gauge', 'temperature', '温度仪表', 70, 166, 196, 116, {
          value: 42.6,
          min: 0,
          max: 100,
          unit: '°C',
        }),
        bindings: { value: { variable: 'temperature', mode: 'oneWay' } },
      },
      widget('panel', 'pressure_panel', '压力卡片', 332, 120, 280, 180),
      widget(
        'text',
        'pressure_label',
        '压力标题',
        352,
        138,
        220,
        24,
        { text: '管道压力' },
        { color: '$color.muted', fontSize: 12 },
      ),
      {
        ...widget(
          'text',
          'pressure',
          '压力读数',
          352,
          182,
          200,
          52,
          { text: '0.36 MPa', unit: 'MPa' },
          { fontSize: 38, fontWeight: 600 },
        ),
        bindings: { text: { variable: 'pressure', mode: 'oneWay' } },
      },
      widget(
        'text',
        'pressure_note',
        '压力提示',
        352,
        254,
        220,
        22,
        { text: '● 正常范围  0.20–0.60 MPa' },
        { color: '$color.success', fontSize: 11 },
      ),
      widget('panel', 'control_panel', '操作卡片', 632, 120, 296, 180),
      widget(
        'text',
        'control_label',
        '控制标题',
        652,
        138,
        220,
        24,
        { text: '运行控制' },
        { color: '$color.muted', fontSize: 12 },
      ),
      {
        ...widget('switch', 'power', '自动运行', 652, 182, 248, 36, {
          text: '自动运行',
          value: false,
        }),
        bindings: { value: { variable: 'running', mode: 'twoWay' } },
      },
      {
        ...widget('button', 'start_button', '启动循环', 652, 234, 248, 42, { text: '启动循环' }),
        events: { click: 'start-cycle' },
        states: { hover: { background: '$color.primaryHover' } },
      },
      widget('panel', 'chart_panel', '趋势卡片', 32, 320, 580, 276),
      widget(
        'text',
        'chart_label',
        '趋势标题',
        52,
        338,
        400,
        24,
        { text: '温度趋势' },
        { fontSize: 13, fontWeight: 600 },
      ),
      {
        ...widget('chart', 'chart', '实时温度', 52, 380, 540, 190, {
          min: 0,
          max: 100,
          value: 42.6,
        }),
        bindings: { value: { variable: 'temperature', mode: 'oneWay' } },
      },
      widget('panel', 'status_panel', '参数卡片', 632, 320, 296, 276),
      widget(
        'text',
        'status_label',
        '参数标题',
        652,
        338,
        220,
        24,
        { text: '参数设置' },
        { fontSize: 13, fontWeight: 600 },
      ),
      widget(
        'text',
        'speed_label',
        '转速标题',
        652,
        382,
        220,
        22,
        { text: '目标转速  /  %' },
        { fontSize: 12, color: '$color.muted' },
      ),
      {
        ...widget('slider', 'speed', '目标转速', 652, 416, 248, 36, { value: 65 }),
        bindings: { value: { variable: 'speed', mode: 'twoWay' } },
      },
      widget(
        'text',
        'cycle_label',
        '循环标题',
        652,
        480,
        220,
        22,
        { text: '累计循环' },
        { fontSize: 12, color: '$color.muted' },
      ),
      {
        ...widget(
          'text',
          'cycles',
          '循环次数',
          652,
          516,
          220,
          36,
          { text: '0', unit: '次' },
          { fontSize: 27, fontWeight: 600 },
        ),
        bindings: { text: { variable: 'cycles', mode: 'oneWay' } },
      },
    ],
    variables: [
      {
        id: 'temperature',
        name: 'temperature',
        type: 'number',
        initial: 42.6,
        unit: '°C',
        alarm: { max: 80 },
      },
      { id: 'pressure', name: 'pressure', type: 'number', initial: 0.36, unit: 'MPa' },
      { id: 'running', name: 'running', type: 'boolean', initial: false },
      { id: 'speed', name: 'speed', type: 'number', initial: 65, unit: '%' },
      { id: 'cycles', name: 'cycles', type: 'number', initial: 0, persistent: true },
    ],
    flows: [
      {
        id: 'start-cycle',
        name: '启动循环',
        enabled: true,
        nodes: [
          {
            id: 'trigger',
            kind: 'event',
            label: '点击启动',
            position: { x: 30, y: 130 },
            config: {},
          },
          {
            id: 'read-cycles',
            kind: 'read',
            label: '读取次数',
            position: { x: 260, y: 130 },
            config: { variable: 'cycles' },
          },
          {
            id: 'increment',
            kind: 'math',
            label: '次数 + 1',
            position: { x: 490, y: 130 },
            config: { operation: 'add', operand: 1 },
          },
          {
            id: 'write-cycles',
            kind: 'write',
            label: '保存次数',
            position: { x: 720, y: 130 },
            config: { variable: 'cycles' },
          },
          {
            id: 'log-cycle',
            kind: 'log',
            label: '记录运行',
            position: { x: 950, y: 130 },
            config: { message: 'Cycle completed' },
          },
        ],
        edges: [
          ['trigger', 'read-cycles'],
          ['read-cycles', 'increment'],
          ['increment', 'write-cycles'],
          ['write-cycles', 'log-cycle'],
        ].map(([source, target]) => ({ id: `${source}-${target}`, source, target })),
      },
    ],
    translations: {
      'zh-CN': { 'pump.title': '泵站控制面板', 'pump.start': '启动循环' },
      en: { 'pump.title': 'Pump station', 'pump.start': 'Start cycle' },
    },
    scripts: [
      { id: 'counter-script', name: 'cycle_counter.c', source: defaultCScript, timeoutMs: 1000 },
    ],
    modules: [],
    assets: [],
    connections: [],
  };
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2) + '\n';
}
export function assetUrl(project: Project, id?: string): string | undefined {
  return project.assets.find((asset) => asset.id === id)?.data;
}
