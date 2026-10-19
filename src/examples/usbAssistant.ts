import { createEmptyProject, createWidget } from '../core/project';
import { createFlowNodeConfig } from '../core/flowV4';
import { createBlockInterface, dataInputHandle, dataOutputHandle } from '../core/functionBlocks';
import type { Flow, FlowNode, Json, Locale, Project, WidgetType } from '../core/types';
import { integrateCommunicationFlow } from './communicationFlow';

const variable = (id: string): Json => ({ source: 'variable', variable: id });
const input = (...path: (string | number)[]): Json => ({ source: 'input', path });

/** A normal editable project: no USB handles or native data are embedded. */
export function createUsbAssistantProject(locale: Locale = 'zh-CN'): Project {
  const zh = locale === 'zh-CN';
  const project = createEmptyProject(zh ? 'USB 助手' : 'USB Assistant');
  project.locale = locale;
  project.window = { ...project.window, title: project.name, width: 1060, height: 740 };
  project.publish = {
    ...project.publish,
    appName: 'QuickGUI USB Assistant',
    identifier: 'dev.quickgui.usbassistant',
  };
  project.variables = [
    { id: 'usb_devices', name: 'USB devices', type: 'json', initial: [] },
    { id: 'usb_options', name: 'Device choices', type: 'json', initial: [] },
    { id: 'usb_device', name: 'Selected device identity', type: 'string', initial: '' },
    { id: 'usb_send', name: 'TX hex', type: 'string', initial: '01 02 03' },
    { id: 'usb_rx', name: 'Latest RX', type: 'json', initial: { text: '', hex: '', reportId: 0 } },
    { id: 'usb_status', name: 'Session status', type: 'json', initial: { status: 'closed' } },
    { id: 'usb_error', name: 'Diagnostic', type: 'json', initial: { code: '', message: '' } },
  ];
  const widget = (
    type: WidgetType,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    properties: Record<string, Json>,
  ) => {
    const w = createWidget(type, x, y);
    w.id = id;
    w.name = id;
    w.layout = { ...w.layout, x, y, width, height };
    w.props = { ...w.props, ...properties };
    project.widgets.push(w);
    return w;
  };
  widget('text', 'usb_title', 30, 24, 900, 38, {
    text: zh ? 'USB 设备发现与通信 FB' : 'USB discovery and communication FBs',
  });
  widget('text', 'usb_note', 30, 66, 980, 60, {
    text: zh
      ? '需要桌面运行时。选择精确设备后手动打开；HID 与 Windows USB Print 共用持久会话。HID Report ID 默认 0，编号输入报告请在通信 FB 的 options 中设置。'
      : 'Desktop runtime required. Select an exact device, then open manually. HID and Windows USB Print use persistent sessions. Default Report ID: 0.',
  });
  const choices = widget('select', 'usb_select', 30, 142, 740, 40, {
    options: [],
    placeholder: zh ? '先扫描，再选择设备' : 'Scan and choose a device',
  });
  choices.bindings.options = { variable: 'usb_options', mode: 'oneWay' };
  choices.bindings.value = { variable: 'usb_device', mode: 'twoWay' };
  for (const [id, caption, flow, x] of [
    ['usb_scan', zh ? '扫描 / 监听' : 'Scan / watch', 'usb_discovery', 790],
    ['usb_open', zh ? '打开' : 'Open', 'usb_open_flow', 30],
    ['usb_close', zh ? '关闭' : 'Close', 'usb_close_flow', 185],
    ['usb_tx', zh ? '发送 HEX' : 'Send HEX', 'usb_send_flow', 790],
  ] as const)
    widget(
      'button',
      id,
      x,
      id === 'usb_scan' ? 142 : 202,
      id === 'usb_scan' || id === 'usb_tx' ? 220 : 140,
      40,
      { text: caption },
    ).events.click = flow;
  const tx = widget('input', 'usb_payload', 350, 202, 420, 40, { value: '01 02 03' });
  tx.bindings.value = { variable: 'usb_send', mode: 'twoWay' };
  const state = widget('text', 'usb_state', 30, 258, 980, 30, { text: 'closed' });
  state.bindings.text = { variable: 'usb_status', path: ['status'], mode: 'oneWay' };
  const error = widget('text', 'usb_diagnostic', 30, 300, 980, 50, { text: '' });
  error.bindings.text = { variable: 'usb_error', path: ['message'], mode: 'oneWay' };
  widget('text', 'usb_rx_heading', 30, 370, 980, 30, {
    text: zh ? '最近接收（HEX）' : 'Latest receive (HEX)',
  });
  const rx = widget('input', 'usb_received', 30, 410, 980, 90, {
    value: '',
    readOnly: true,
    multiline: true,
  });
  rx.bindings.value = { variable: 'usb_rx', path: ['hex'], mode: 'oneWay' };
  widget('text', 'usb_safety', 30, 530, 980, 80, {
    text: zh
      ? '打开和发送由按钮显式触发。USB Print 直接使用 usbprint.sys，支持库提供的 ZLP；不支持通用 WinUSB/libusb Bulk。关闭或修改流程时释放资源。示例不会自动选择第一台设备或自动发送。'
      : 'Open and send require explicit clicks. USB Print uses usbprint.sys and upstream ZLP support. Generic WinUSB/libusb Bulk is unavailable. Close and flow revisions release resources.',
  });

  const node = (
    id: string,
    kind: FlowNode['kind'],
    config: FlowNode['config'],
    x: number,
    y: number,
  ): FlowNode => {
    const n = { id, kind, config, label: id, position: { x, y } };
    return { ...n, block: createBlockInterface(n, project) };
  };
  const communication = () => ({
    ...createFlowNodeConfig('usb', project),
    device: variable('usb_device'),
    data: variable('usb_send'),
  });
  const diagnostics = (flow: Flow, source: string, y = 700) => {
    const n = node(`${source}_error_output`, 'write', { variable: 'usb_error' }, 660, y);
    flow.nodes.push(n);
    flow.edges.push({ id: `${source}_error`, source, target: n.id, sourceHandle: 'error' });
  };
  const discovery: Flow = {
    id: 'usb_discovery',
    name: zh ? '01 · 设备发现与热插拔' : '01 · Discovery and hotplug',
    enabled: true,
    nodes: [
      node('discover_trigger', 'event', { trigger: 'manual' }, 20, 80),
      node('discover', 'usb', createFlowNodeConfig('usb', project, 'discover'), 270, 80),
      node(
        'device_options',
        'map',
        {
          operation: 'array',
          items: input('devices'),
          fields: { id: input('id'), label: input('id'), value: input('id') },
        },
        600,
        80,
      ),
      node('save_options', 'write', { variable: 'usb_options' }, 900, 80),
      node('save_devices', 'write', { variable: 'usb_devices' }, 600, 410),
    ],
    edges: [
      { id: 'watch', source: 'discover_trigger', target: 'discover', targetHandle: 'watch' },
      { id: 'snapshot', source: 'discover', target: 'device_options', sourceHandle: 'success' },
      { id: 'hotplug', source: 'discover', target: 'device_options', sourceHandle: 'changed' },
      { id: 'options', source: 'device_options', target: 'save_options', sourceHandle: 'success' },
      { id: 'devices', source: 'discover', target: 'save_devices', sourceHandle: 'success' },
      {
        id: 'devices_changed',
        source: 'discover',
        target: 'save_devices',
        sourceHandle: 'changed',
      },
      {
        id: 'device_values',
        kind: 'data',
        source: 'discover',
        target: 'save_devices',
        sourceHandle: dataOutputHandle('devices'),
        targetHandle: dataInputHandle('in'),
      },
    ],
  };
  diagnostics(discovery, 'discover');
  diagnostics(discovery, 'device_options', 900);
  project.flows = [discovery];
  for (const command of ['open', 'close', 'send'] as const) {
    const flow: Flow = {
      id: `usb_${command}_flow`,
      name: `USB ${command}`,
      enabled: true,
      nodes: [
        node(`${command}_trigger`, 'event', { trigger: 'manual' }, 20, 80),
        node(`${command}_io`, 'usb', communication(), 270, 80),
      ],
      edges: [
        {
          id: `${command}_command`,
          source: `${command}_trigger`,
          target: `${command}_io`,
          targetHandle: command,
        },
      ],
    };
    diagnostics(flow, `${command}_io`);
    project.flows.push(flow);
  }
  const events: Flow = {
    id: 'usb_events',
    name: zh ? 'USB · 异步收发与状态' : 'USB · Async data and state',
    enabled: true,
    nodes: [
      node('usb_io', 'usb', communication(), 40, 80),
      node('usb_receive', 'write', { variable: 'usb_rx' }, 420, 80),
      node('usb_state_output', 'write', { variable: 'usb_status' }, 420, 280),
      node('usb_tx_log', 'log', { message: 'USB TX' }, 420, 480),
    ],
    edges: [
      { id: 'rx', source: 'usb_io', target: 'usb_receive', sourceHandle: 'rx' },
      { id: 'state', source: 'usb_io', target: 'usb_state_output', sourceHandle: 'state' },
      { id: 'tx', source: 'usb_io', target: 'usb_tx_log', sourceHandle: 'tx' },
    ],
  };
  diagnostics(events, 'usb_io');
  project.flows.push(events);
  integrateCommunicationFlow(
    project,
    zh ? 'USB 助手 · 设备发现与通信' : 'USB assistant · Discovery and communication',
    {
      open_io: 'usb_io',
      close_io: 'usb_io',
      send_io: 'usb_io',
      open_io_error_output: 'usb_io_error_output',
      close_io_error_output: 'usb_io_error_output',
      send_io_error_output: 'usb_io_error_output',
      discover_error_output: 'usb_io_error_output',
      device_options_error_output: 'usb_io_error_output',
    },
  );
  return project;
}
