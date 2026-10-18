import { createEmptyProject, createWidget } from '../core/project';
import type { Flow, FlowNode, Json, Locale, Project, Widget, WidgetType } from '../core/types';

const literal = (value: Json): Json => ({ source: 'literal', value });
const input = (...path: (string | number)[]): Json => ({ source: 'input', path });
const variable = (id: string, ...path: (string | number)[]): Json => ({
  source: 'variable',
  variable: id,
  path,
});
const connectionId = 'serial_port';
type NodeSpec = [FlowNode['kind'], string, Record<string, Json>];
type Link = [number, number, string?];

function makeFlow(id: string, name: string, specs: NodeSpec[], links?: Link[]): Flow {
  const nodes: FlowNode[] = specs.map(([kind, label, config], index) => ({
    id: `${id}_${index}`,
    kind,
    label,
    config,
    position: { x: 40 + (index % 5) * 245, y: 90 + Math.floor(index / 5) * 180 },
  }));
  const output = (index: number) =>
    ['serial', 'map', 'append'].includes(nodes[index].kind) ? 'success' : 'output';
  const edges = (links ?? specs.slice(1).map((_, index): Link => [index, index + 1])).map(
    ([from, to, handle], index) => ({
      id: `${id}_edge_${index}`,
      source: nodes[from].id,
      target: nodes[to].id,
      sourceHandle: handle ?? output(from),
      targetHandle: 'input',
    }),
  );
  const fallible = nodes.filter((node) => ['serial', 'map', 'append'].includes(node.kind));
  if (fallible.length) {
    const errorMap: FlowNode = {
      id: `${id}_error_map`,
      kind: 'map',
      label: '错误字段 / Error fields',
      position: { x: 285, y: 500 },
      config: { operation: 'object', fields: { code: input('code'), message: input('message') } },
    };
    const errorWrite: FlowNode = {
      id: `${id}_error_write`,
      kind: 'write',
      label: '显示错误 / Show error',
      position: { x: 530, y: 500 },
      config: { variable: 'serial_error' },
    };
    const stopTimer: FlowNode = {
      id: `${id}_stop_timer`,
      kind: 'write',
      label: '停止定时发送 / Stop periodic sends',
      position: { x: 775, y: 500 },
      config: { variable: 'serial_tx', path: ['periodic'], value: false },
    };
    nodes.push(errorMap, errorWrite, stopTimer);
    for (const node of fallible)
      edges.push({
        id: `${id}_error_${node.id}`,
        source: node.id,
        target: errorMap.id,
        sourceHandle: 'error',
        targetHandle: 'input',
      });
    edges.push({
      id: `${id}_error_show`,
      source: errorMap.id,
      target: errorWrite.id,
      sourceHandle: 'success',
      targetHandle: 'input',
    });
    edges.push({
      id: `${id}_error_stop`,
      source: errorWrite.id,
      target: stopTimer.id,
      sourceHandle: 'output',
      targetHandle: 'input',
    });
  }
  return { id, name, enabled: true, nodes, edges };
}

export function createSerialAssistantProject(locale: Locale = 'zh-CN'): Project {
  const zh = locale === 'zh-CN';
  const project = createEmptyProject(zh ? '串口助手' : 'Serial Assistant');
  project.schemaVersion = 4;
  project.locale = locale;
  project.window = {
    ...project.window,
    title: project.name,
    width: 1200,
    height: 940,
    minWidth: 900,
    minHeight: 700,
  };
  project.publish = {
    ...project.publish,
    appName: 'QuickGUI Serial Assistant',
    identifier: 'dev.quickgui.serialassistant',
  };
  project.theme.tokens = {
    ...project.theme.tokens,
    'color.primary': '#7c5cff',
    'color.surface': '#20232e',
    'color.background': '#141720',
    'color.text': '#eef0f8',
    'color.muted': '#9aa3ba',
    'color.border': '#33394b',
  };
  project.window.background = '#141720';
  const settings = {
    portName: '',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    framing: 'raw',
    autoReconnect: false,
  };
  project.connections = [
    {
      id: connectionId,
      name: zh ? '助手串口' : 'Assistant serial port',
      protocol: 'serial',
      config: { ...settings },
    },
  ];
  project.variables = [
    { id: 'serial_settings', name: 'Serial settings', type: 'json', initial: settings },
    { id: 'serial_filters', name: 'USB filters', type: 'json', initial: { vid: '', pid: '' } },
    {
      id: 'serial_ports',
      name: 'Port snapshot',
      type: 'json',
      initial: {
        kind: 'snapshot',
        ports: [],
        added: [],
        removed: [],
        changed: [],
        sequence: 0,
        timestamp: 0,
        timestampIso: '',
      },
    },
    { id: 'serial_options', name: 'Port options', type: 'json', initial: [] },
    {
      id: 'serial_state',
      name: 'Serial session state',
      type: 'json',
      initial: {
        connectionId,
        sessionId: null,
        status: 'closed',
        port: null,
        autoReconnect: false,
        listening: false,
        isOpen: false,
        canOpen: true,
        canClose: false,
        counters: { txBytes: 0, rxBytes: 0, txPackets: 0, rxPackets: 0 },
        error: null,
        timestamp: 0,
        timestampIso: '',
      },
    },
    {
      id: 'serial_tx',
      name: 'Transmit settings',
      type: 'json',
      initial: {
        data: '',
        encoding: 'utf8',
        lineEnding: 'none',
        intervalMs: 1000,
        periodic: false,
      },
    },
    {
      id: 'serial_history',
      name: 'Bounded I/O history',
      type: 'json',
      initial: { rows: [], dropped: 0 },
    },
    { id: 'serial_error', name: 'Serial error', type: 'json', initial: { code: '', message: '' } },
    { id: 'serial_last_rx', name: 'Last receive time', type: 'string', initial: '—' },
    { id: 'serial_last_tx', name: 'Last send time', type: 'string', initial: '—' },
  ];
  project.translations = { 'zh-CN': {}, en: {} };
  const tr = (id: string, cn: string, en: string) => {
    project.translations!['zh-CN'][id] = cn;
    project.translations!.en[id] = en;
    return `@${id}`;
  };
  const widget = (
    type: WidgetType,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    props: Record<string, Json> = {},
  ): Widget => {
    const item = createWidget(type, x, y, 2);
    item.id = id;
    item.name = id;
    item.layout = { x, y, width, height };
    item.props = { ...item.props, ...props };
    project.widgets.push(item);
    return item;
  };
  const label = (
    id: string,
    cn: string,
    en: string,
    x: number,
    y: number,
    width = 300,
    size = 12,
  ) => {
    const item = widget('text', id, x, y, width, 26, { text: tr(id, cn, en) });
    item.style = { ...item.style, fontSize: size, color: '$color.muted' };
    return item;
  };
  const bind = (
    item: Widget,
    property: string,
    id: string,
    path: (string | number)[] = [],
    twoWay = false,
  ) => {
    item.bindings[property] = { variable: id, path, mode: twoWay ? 'twoWay' : 'oneWay' };
    return item;
  };
  const enabled = (item: Widget, path = 'canOpen') => bind(item, 'enabled', 'serial_state', [path]);
  const button = (
    id: string,
    cn: string,
    en: string,
    flowId: string,
    x: number,
    y: number,
    width = 150,
  ) => {
    const item = widget('button', id, x, y, width, 38, { text: tr(id, cn, en) });
    item.events.click = flowId;
    return item;
  };
  const select = (
    id: string,
    x: number,
    y: number,
    width: number,
    values: (string | number)[],
    source: string,
    path: string,
    labels?: string[],
  ) => {
    const item = widget('select', id, x, y, width, 36, {
      options: values.map((value, index) => ({
        id: `${id}_${index}`,
        label: labels?.[index] ?? String(value),
        value,
      })),
    });
    return bind(item, 'value', source, [path], true);
  };
  widget('panel', 'device_panel', 24, 86, 350, 826, { overflow: 'hidden' });
  widget('panel', 'traffic_panel', 394, 86, 782, 516, { overflow: 'hidden' });
  widget('panel', 'transmit_panel', 394, 620, 782, 292, { overflow: 'hidden' });
  const heading = label('page_title', '串口助手', 'Serial Assistant', 28, 20, 560, 26);
  heading.style = { ...heading.style, color: '$color.text', fontWeight: 650 };
  label(
    'page_note',
    '原生串口 · 可视化流程 · 工程可独立运行',
    'Native serial · Visual flows · Standalone project',
    30,
    52,
    650,
  );
  label('connection_heading', '01  设备与连接', '01  DEVICE & CONNECTION', 42, 104, 310, 14);
  label('port_label', '端口', 'Port', 42, 140, 160);
  const port = widget('select', 'serial_port_select', 42, 168, 222, 36, {
    options: [],
    value: '',
    placeholder: tr('port_hint', '扫描后选择串口', 'Scan and choose a port'),
  });
  bind(port, 'options', 'serial_options');
  bind(port, 'value', 'serial_settings', ['portName'], true);
  enabled(port);
  button('scan_ports', '扫描', 'Scan', 'serial_scan', 274, 168, 82);
  label('vid_label', 'VID（十六进制，可留空）', 'VID (hex, optional)', 42, 215, 155);
  label('pid_label', 'PID（十六进制，可留空）', 'PID (hex, optional)', 207, 215, 155);
  for (const [key, x] of [
    ['vid', 42],
    ['pid', 207],
  ] as const) {
    const field = widget('input', `filter_${key}`, x, 244, 149, 34, {
      value: '',
      placeholder: key === 'vid' ? '1A86' : '7523',
      maxLength: 6,
    });
    bind(field, 'value', 'serial_filters', [key], true);
    enabled(field);
    field.events.change = 'serial_filter';
  }
  label('baud_label', '波特率', 'Baud rate', 42, 292, 150);
  label('bits_label', '数据位', 'Data bits', 207, 292, 140);
  const baud = widget('number', 'baud_rate', 42, 320, 149, 36, {
    value: 115200,
    min: 1,
    max: 4000000,
    precision: 0,
    step: 1,
  });
  bind(baud, 'value', 'serial_settings', ['baudRate'], true);
  enabled(baud);
  enabled(select('data_bits', 207, 320, 149, [5, 6, 7, 8], 'serial_settings', 'dataBits'));
  label('parity_label', '校验', 'Parity', 42, 367, 150);
  label('stop_label', '停止位', 'Stop bits', 207, 367, 140);
  enabled(
    select(
      'parity',
      42,
      395,
      149,
      ['none', 'odd', 'even'],
      'serial_settings',
      'parity',
      zh ? ['无', '奇校验', '偶校验'] : ['None', 'Odd', 'Even'],
    ),
  );
  enabled(select('stop_bits', 207, 395, 149, [1, 2], 'serial_settings', 'stopBits'));
  label('flow_label', '流控', 'Flow control', 42, 442, 150);
  label('framing_label', '接收组帧', 'Receive framing', 207, 442, 140);
  enabled(
    select(
      'flow_control',
      42,
      470,
      149,
      ['none', 'hardware', 'software'],
      'serial_settings',
      'flowControl',
      zh ? ['无', '硬件', '软件'] : ['None', 'Hardware', 'Software'],
    ),
  );
  enabled(
    select(
      'framing',
      207,
      470,
      149,
      ['raw', 'line', 'length16'],
      'serial_settings',
      'framing',
      zh ? ['原始批次', '换行', '16位长度'] : ['Raw batches', 'Line', '16-bit length'],
    ),
  );
  enabled(button('open_port', '手动打开', 'Open manually', 'serial_open', 42, 526, 149));
  enabled(button('close_port', '断开', 'Disconnect', 'serial_close', 207, 526, 149), 'canClose');
  enabled(
    button('listen_start', '开始监听', 'Start listening', 'serial_listen_start', 42, 578, 149),
    'isOpen',
  );
  enabled(
    button('listen_stop', '停止监听', 'Stop listening', 'serial_listen_stop', 207, 578, 149),
    'isOpen',
  );
  const reconnect = widget('switch', 'auto_reconnect', 42, 634, 305, 34, {
    text: tr('reconnect_text', '严格同设备自动重连', 'Reconnect only to the same device'),
    value: false,
  });
  bind(reconnect, 'value', 'serial_settings', ['autoReconnect'], true);
  reconnect.events.change = 'serial_reconnect';
  label(
    'reconnect_note',
    '默认关闭。VID、PID、端口与物理拓扑必须完全一致；缺少标识须手动打开。',
    'Off by default. VID, PID, port and physical topology must match. Missing identity requires manual open.',
    42,
    675,
    312,
  ).layout.height = 72;
  label('state_label', '状态', 'Status', 42, 758, 70);
  bind(label('connection_state', '', '', 115, 758, 235), 'text', 'serial_state', ['status']);
  label('listening_label', '监听', 'Listening', 42, 791, 70);
  const listening = widget('switch', 'listening_state', 115, 790, 210, 30, {
    text: '',
    enabled: false,
  });
  bind(listening, 'value', 'serial_state', ['listening']);
  label(
    'overflow_note',
    '接收队列过载将断开并锁存；排除故障后点击“手动打开”恢复。',
    'RX overload disconnects and latches the fault. Resolve it, then open manually.',
    42,
    834,
    312,
  ).layout.height = 56;
  label('traffic_heading', '02  收发记录', '02  TRAFFIC', 414, 103, 220, 14);
  button('clear_history', '清空记录', 'Clear history', 'serial_clear', 933, 100, 108);
  enabled(
    button('reset_counters', '重置计数', 'Reset counters', 'serial_reset_counters', 1052, 100, 108),
    'isOpen',
  );
  for (const [id, cn, en, path, x] of [
    ['tx_bytes', '发送字节', 'TX bytes', 'txBytes', 414],
    ['rx_bytes', '接收字节', 'RX bytes', 'rxBytes', 600],
    ['tx_packets', '发送批次', 'TX batches', 'txPackets', 786],
    ['rx_packets', '接收批次', 'RX batches', 'rxPackets', 972],
  ] as const) {
    label(`${id}_label`, cn, en, x, 148, 160);
    const count = widget('number', id, x, 175, 166, 34, {
      readOnly: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      precision: 0,
    });
    bind(count, 'value', 'serial_state', ['counters', path]);
  }
  const history = widget('table', 'traffic_history', 414, 228, 742, 290, {
    rows: [],
    pageSize: 10,
    sortable: false,
    rowHeight: 29,
    emptyText: tr(
      'history_empty',
      '打开串口后，真实收发数据将在这里显示',
      'Open a serial port to receive real traffic',
    ),
    columns: [
      { id: 'time', title: zh ? '时间' : 'Time', path: ['time'], width: 188 },
      { id: 'direction', title: zh ? '方向' : 'Dir', path: ['direction'], width: 52 },
      { id: 'bytes', title: zh ? '字节' : 'Bytes', path: ['bytes'], width: 56, align: 'right' },
      { id: 'text', title: 'UTF-8', path: ['text'], width: 215 },
      { id: 'hex', title: 'HEX', path: ['hex'], width: 215 },
    ],
  });
  bind(history, 'rows', 'serial_history', ['rows']);
  label(
    'history_limit',
    '保留最近 500 条 / 512 KiB，淘汰旧记录数：',
    'Latest 500 records / 512 KiB; evicted:',
    414,
    527,
    330,
  );
  const dropped = widget('number', 'dropped_records', 752, 525, 90, 30, {
    readOnly: true,
    precision: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  bind(dropped, 'value', 'serial_history', ['dropped']);
  label('rx_time_label', '最近接收', 'Last RX', 414, 565, 85);
  bind(label('rx_time', '', '', 505, 565, 270), 'text', 'serial_last_rx');
  label('tx_time_label', '最近发送', 'Last TX', 786, 565, 85);
  bind(label('tx_time', '', '', 875, 565, 280), 'text', 'serial_last_tx');
  label('send_heading', '03  发送', '03  TRANSMIT', 414, 635, 170, 14);
  const payload = widget('input', 'send_payload', 414, 675, 508, 110, {
    multiline: true,
    value: '',
    placeholder: tr(
      'payload_hint',
      '输入 UTF-8 文本，或完整 HEX 字节（例如 01 A0 FF）',
      'UTF-8 text, or complete HEX bytes such as 01 A0 FF',
    ),
    maxLength: 196605,
  });
  bind(payload, 'value', 'serial_tx', ['data'], true);
  select('send_encoding', 936, 675, 220, ['utf8', 'hex'], 'serial_tx', 'encoding', [
    'UTF-8',
    'HEX',
  ]);
  select(
    'line_ending',
    936,
    721,
    220,
    ['none', 'lf', 'crlf'],
    'serial_tx',
    'lineEnding',
    zh ? ['不追加行尾', '追加 LF', '追加 CRLF'] : ['No line ending', 'Append LF', 'Append CRLF'],
  );
  enabled(button('send_once', '发送', 'Send', 'serial_send', 936, 767, 220), 'isOpen');
  const periodic = widget('switch', 'periodic_send', 414, 803, 210, 32, {
    text: tr('periodic_text', '定时发送', 'Periodic send'),
    value: false,
  });
  bind(periodic, 'value', 'serial_tx', ['periodic'], true);
  enabled(periodic, 'isOpen');
  const interval = widget('number', 'send_interval', 645, 803, 130, 34, {
    value: 1000,
    min: 100,
    max: 86400000,
    precision: 0,
    unit: 'ms',
  });
  bind(interval, 'value', 'serial_tx', ['intervalMs'], true);
  label(
    'send_note',
    '写入完成不代表设备应答。断开、错误、重连后均停止定时发送。',
    'Write completion is not device acknowledgement. Disconnects, errors and reconnects stop periodic sends.',
    414,
    850,
    740,
  ).layout.height = 44;
  bind(label('error_code', '', '', 720, 24, 170), 'text', 'serial_error', ['code']);
  bind(label('error_message', '', '', 720, 50, 450), 'text', 'serial_error', ['message']);
  project.widgets.find((item) => item.id === 'error_message')!.style.color = '$color.warning';

  const manual: NodeSpec = ['event', 'UI 事件 / UI event', { trigger: 'manual' }];
  const filterNodes: NodeSpec[] = [
    [
      'serial',
      'VID / PID 过滤',
      {
        action: 'filter',
        ports: variable('serial_ports', 'ports'),
        vid: variable('serial_filters', 'vid'),
        pid: variable('serial_filters', 'pid'),
      },
    ],
    [
      'map',
      '端口选项 / Port options',
      {
        operation: 'array',
        items: input(),
        fields: { id: input('portName'), label: input('displayName'), value: input('portName') },
      },
    ],
    ['write', '更新下拉列表 / Update options', { variable: 'serial_options' }],
  ];
  const send: NodeSpec = [
    'serial',
    '串口发送 / Serial send',
    {
      action: 'send',
      connectionId,
      data: variable('serial_tx', 'data'),
      encoding: variable('serial_tx', 'encoding'),
      lineEnding: variable('serial_tx', 'lineEnding'),
      timeoutMs: literal(5000),
    },
  ];
  project.flows = [
    makeFlow('serial_scan', '01 · 扫描端口 / Scan ports', [
      manual,
      ['serial', '扫描串口 / Scan serial ports', { action: 'scan' }],
      ['write', '保存扫描结果 / Save snapshot', { variable: 'serial_ports' }],
      ...filterNodes,
    ]),
    makeFlow('serial_devices', '02 · 插入与拔出 / Device changes', [
      ['event', '设备列表事件 / Device event', { trigger: 'serial', event: 'devices' }],
      ['write', '保存设备快照 / Save snapshot', { variable: 'serial_ports' }],
      ...filterNodes,
    ]),
    makeFlow('serial_filter', '03 · 更新 VID/PID 过滤 / Filter devices', [manual, ...filterNodes]),
    makeFlow('serial_open', '04 · 手动打开并监听 / Open and listen', [
      manual,
      [
        'serial',
        '打开串口 / Open serial',
        { action: 'open', connectionId, settings: variable('serial_settings') },
      ],
      ['serial', '开始监听 / Start listening', { action: 'listenStart', connectionId }],
      [
        'write',
        '清除旧错误 / Clear error',
        { variable: 'serial_error', value: { code: '', message: '' } },
      ],
    ]),
    makeFlow('serial_close', '05 · 断开 / Disconnect', [
      manual,
      [
        'write',
        '停止定时发送 / Stop periodic sends',
        { variable: 'serial_tx', path: ['periodic'], value: false },
      ],
      ['serial', '关闭串口 / Close serial', { action: 'close', connectionId }],
    ]),
    makeFlow('serial_listen_start', '06 · 开始监听 / Start listening', [
      manual,
      ['serial', '开始监听 / Start listening', { action: 'listenStart', connectionId }],
    ]),
    makeFlow('serial_listen_stop', '07 · 停止监听 / Stop listening', [
      manual,
      ['serial', '停止监听 / Stop listening', { action: 'listenStop', connectionId }],
    ]),
    makeFlow('serial_send', '08 · 手动发送 / Send once', [manual, send]),
    makeFlow('serial_periodic', '09 · 定时发送 / Periodic send', [
      [
        'event',
        '受控定时器 / Controlled interval',
        {
          trigger: 'controlledInterval',
          interval: variable('serial_tx', 'intervalMs'),
          enabled: variable('serial_tx', 'periodic'),
        },
      ],
      send,
    ]),
    makeFlow('serial_reconnect', '10 · 重连策略 / Reconnect policy', [
      manual,
      [
        'serial',
        '设置重连 / Set reconnect',
        {
          action: 'setReconnect',
          connectionId,
          enabled: variable('serial_settings', 'autoReconnect'),
        },
      ],
    ]),
    makeFlow(
      'serial_state',
      '11 · 会话状态 / Session state',
      [
        ['event', '串口状态 / Serial state', { trigger: 'serial', event: 'state', connectionId }],
        ['write', '更新状态 / Update state', { variable: 'serial_state' }],
        ['map', '提取状态 / Read status', { operation: 'value', value: input('status') }],
        ['condition', '非打开状态 / Not open', { operator: 'neq', value: 'open' }],
        [
          'write',
          '停止定时发送 / Stop periodic sends',
          { variable: 'serial_tx', path: ['periodic'], value: false },
        ],
      ],
      [
        [0, 1],
        [0, 2],
        [2, 3],
        [3, 4, 'true'],
      ],
    ),
    makeFlow('serial_errors', '12 · 设备错误 / Device errors', [
      ['event', '串口错误 / Serial error', { trigger: 'serial', event: 'error', connectionId }],
      [
        'map',
        '错误字段 / Error fields',
        { operation: 'object', fields: { code: input('code'), message: input('message') } },
      ],
      ['write', '显示错误 / Show error', { variable: 'serial_error' }],
      [
        'write',
        '停止定时发送 / Stop periodic sends',
        { variable: 'serial_tx', path: ['periodic'], value: false },
      ],
    ]),
    makeFlow('serial_clear', '15 · 清空显示历史 / Clear history', [
      manual,
      [
        'write',
        '清空记录 / Clear history',
        { variable: 'serial_history', value: { rows: [], dropped: 0 } },
      ],
    ]),
    makeFlow('serial_reset_counters', '16 · 重置计数 / Reset counters', [
      manual,
      ['serial', '重置计数 / Reset counters', { action: 'resetCounters', connectionId }],
    ]),
  ];
  for (const direction of ['rx', 'tx'])
    project.flows.push(
      makeFlow(
        `serial_${direction}`,
        `${direction === 'rx' ? '13 · 接收' : '14 · 发送'}记录 / ${direction.toUpperCase()} history`,
        [
          [
            'event',
            `${direction.toUpperCase()} 数据 / Data`,
            { trigger: 'serial', event: 'data', direction, connectionId },
          ],
          [
            'map',
            '日志行 / History row',
            {
              operation: 'object',
              fields: {
                time: input('timestampIso'),
                direction: input('direction'),
                bytes: input('byteLength'),
                text: input('text'),
                hex: input('hex'),
              },
            },
          ],
          [
            'append',
            '有界显示历史 / Bounded history',
            {
              variable: 'serial_history',
              path: ['rows'],
              item: input(),
              maxItems: 500,
              maxBytes: 524288,
              order: 'oldestFirst',
              droppedPath: ['dropped'],
            },
          ],
          ['map', '事件时间 / Event time', { operation: 'value', value: input('timestampIso') }],
          ['write', '最近收发 / Latest I/O', { variable: `serial_last_${direction}` }],
        ],
        [
          [0, 1],
          [1, 2],
          [0, 3],
          [3, 4],
        ],
      ),
    );
  return project;
}
