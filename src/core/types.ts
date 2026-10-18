export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Locale = 'zh-CN' | 'en';
export type ThemeMode = 'light' | 'dark' | 'system';
export type JsonPath = Array<string | number>;
export type VariableType = 'number' | 'string' | 'boolean' | 'json';
export type ValueRef =
  | { source: 'literal'; value: Json }
  | { source: 'input'; path?: JsonPath }
  | { source: 'variable'; variable: string; path?: JsonPath };
export type ValueSource = ValueRef;
export type WidgetType =
  | 'panel'
  | 'text'
  | 'button'
  | 'input'
  | 'number'
  | 'switch'
  | 'slider'
  | 'progress'
  | 'gauge'
  | 'chart'
  | 'image'
  | 'select'
  | 'table'
  | 'module';
export interface Layout {
  x: number;
  y: number;
  width: number;
  height: number;
  mode?: 'absolute' | 'flex' | 'grid';
  gap?: number;
  columns?: number;
  direction?: 'row' | 'column';
  wrap?: boolean;
  alignItems?: string;
  justifyContent?: string;
  rowGap?: number;
  columnGap?: number;
}
export type WidgetStyle = Record<string, string | number>;
export interface Binding {
  variable: string;
  mode: 'oneWay' | 'twoWay' | 'once';
  path?: JsonPath;
}
export interface Widget {
  id: string;
  type: WidgetType;
  name: string;
  parentId?: string;
  moduleId?: string;
  layout: Layout;
  props: Record<string, Json>;
  style: WidgetStyle;
  states: Record<string, WidgetStyle>;
  bindings: Record<string, Binding>;
  events: Record<string, string>;
  definitionVersion?: 1 | 2;
  editor?: { locked?: boolean; hidden?: boolean };
  resourceScopeId?: string;
}
export interface WindowConfig {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  alwaysOnTop: boolean;
  fullscreen: boolean;
  maximized: boolean;
  center: boolean;
  rememberPosition: boolean;
  background: string;
  contentRadius: number;
  cornerPreference: 'system' | 'square' | 'round' | 'small';
  icon?: string;
}
export interface ProjectWindow {
  id: string;
  name: string;
  config: WindowConfig;
  widgets: Widget[];
  openOnStart: boolean;
}
export type WindowAction = 'open' | 'close' | 'focus';
export interface RuntimeWindowState {
  open: string[];
  focused: string;
  revision: number;
}
export interface PublishConfig {
  appName: string;
  identifier: string;
  version: string;
  publisher: string;
  icon?: string;
  shortcutIcon?: string;
  desktopShortcut: boolean;
}
export interface Variable {
  id: string;
  name: string;
  type: VariableType;
  initial: Json;
  unit?: string;
  readOnly?: boolean;
  persistent?: boolean;
  alarm?: { min?: number; max?: number };
}
export type NodeKind =
  | 'event'
  | 'read'
  | 'write'
  | 'condition'
  | 'math'
  | 'delay'
  | 'log'
  | 'script'
  | 'http'
  | 'emit'
  | 'connection'
  | 'window'
  | 'map'
  | 'append'
  | 'serial';
export interface FlowNode {
  id: string;
  kind: NodeKind;
  label: string;
  position: { x: number; y: number };
  config: Record<string, Json>;
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}
export interface Flow {
  id: string;
  name: string;
  enabled: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
export interface CScript {
  id: string;
  name: string;
  source: string;
  timeoutMs: number;
  variableAliases?: Record<string, string>;
}
export interface ComponentModule {
  id: string;
  name: string;
  version: string;
  width: number;
  height: number;
  widgets: Widget[];
  exposedProps: Record<string, { widgetId: string; property: string; default: Json }>;
  packageIdentity?: { id: string; name: string; version: string; width: number; height: number };
  propertyDefinitions?: Record<string, import('./widgetDefinitions').PropertyDefinition>;
  resourceScopeId?: string;
  embeddedResourceScope?: ResourceScope;
  implementation?: {
    kind: 'react';
    files: Record<string, string>;
    bundle: string;
    events: string[];
  };
}
export interface Asset {
  id: string;
  name: string;
  mime: string;
  data: string;
}
export interface Connection {
  id: string;
  name: string;
  protocol: 'http' | 'websocket' | 'mqtt' | 'serial' | 'tcp';
  config: Record<string, Json>;
}
export interface Project {
  schemaVersion: 1 | 2 | 3 | 4;
  id: string;
  name: string;
  revision: number;
  locale: Locale;
  theme: { mode: ThemeMode; tokens: Record<string, string> };
  window: WindowConfig;
  /** Additional windows only. The fixed main window remains in window/widgets. */
  windows?: ProjectWindow[];
  publish: PublishConfig;
  widgets: Widget[];
  variables: Variable[];
  flows: Flow[];
  scripts: CScript[];
  modules: ComponentModule[];
  assets: Asset[];
  connections: Connection[];
  translations?: Record<string, Record<string, string>>;
  resourceScopes?: ResourceScope[];
}
export interface ResourceScope {
  id: string;
  theme: { mode: ThemeMode; tokens: Record<string, string> };
  translations: Record<string, Record<string, string>>;
  locale: Locale;
  localeVariableId?: string;
  assetAliases?: Record<string, string>;
  assets?: Asset[];
}
export interface RuntimeValue {
  value: Json;
  quality: 'good' | 'stale' | 'bad';
  timestamp: number;
}
export interface RuntimeLog {
  id: string;
  time: number;
  level: 'info' | 'warning' | 'error';
  message: string;
  nodeId?: string;
  flowId?: string;
}
export interface RuntimeSnapshot {
  values: Record<string, RuntimeValue>;
  logs: RuntimeLog[];
  running: boolean;
  activeNodes: string[];
  revision: number;
  projectId?: string;
  sequence?: number;
  windowState?: RuntimeWindowState;
  serial?: Record<string, SerialSessionState>;
}
export interface FlowError {
  code: string;
  message: string;
  operation: string;
  connectionId?: string;
  sessionId?: number;
  requestId?: string;
  bytesAccepted?: number;
}
export interface SerialPortInfo {
  portName: string;
  portType: 'usb' | 'bluetooth' | 'pci' | 'unknown';
  vid: number | null;
  pid: number | null;
  usbLocation: { busId: string; portChain: number[] } | null;
  serialNumber: string | null;
  manufacturer: string | null;
  product: string | null;
  displayName: string;
}
export interface PortSnapshot {
  kind: 'snapshot' | 'changed';
  ports: SerialPortInfo[];
  added: SerialPortInfo[];
  removed: SerialPortInfo[];
  changed: SerialPortInfo[];
  sequence: number;
  timestamp: number;
  timestampIso: string;
}
export type SerialPortSnapshot = PortSnapshot;
export interface SerialCounters {
  txBytes: number;
  rxBytes: number;
  txPackets: number;
  rxPackets: number;
}
export interface SerialSettings {
  portName: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'odd' | 'even';
  flowControl: 'none' | 'software' | 'hardware';
  framing: 'raw' | 'line' | 'length16';
  autoReconnect: boolean;
}
export interface SerialSessionState {
  connectionId: string;
  sessionId: number | null;
  status: 'closed' | 'opening' | 'open' | 'reconnecting' | 'needsManualOpen' | 'error';
  port: SerialPortInfo | null;
  autoReconnect: boolean;
  listening: boolean;
  isOpen: boolean;
  canOpen: boolean;
  canClose: boolean;
  counters: SerialCounters;
  error: FlowError | null;
  timestamp: number;
  timestampIso: string;
}
export interface SerialDataEvent {
  kind: 'data';
  connectionId: string;
  sessionId: number;
  sequence: number;
  timestamp: number;
  timestampIso: string;
  direction: 'rx' | 'tx';
  hex: string;
  text: string;
  byteLength: number;
  counters: SerialCounters;
}
export type SerialEvent =
  | PortSnapshot
  | SerialDataEvent
  | (SerialSessionState & { kind: 'state' })
  | (FlowError & { kind: 'error'; sequence: number; timestamp: number; timestampIso: string });
export interface ScriptRequest {
  source: string;
  input: Json;
  variables: Record<string, number>;
  state: Record<string, number>;
  timeoutMs: number;
  variableAliases?: Record<string, string>;
}
export interface ScriptResponse {
  output: Json;
  writes: Record<string, number>;
  state: Record<string, number>;
  logs: string[];
}
export interface HistoryRangeQuery {
  variableIds: string[];
  fromMs: number;
  toMs: number;
  aggregation: 'raw' | 'avg' | 'min' | 'max' | 'last';
  bucketMs?: number;
  maxPointsPerSeries?: number;
}
export interface HistoryRangeResult {
  projectId?: string;
  fromMs: number;
  toMs: number;
  aggregation: HistoryRangeQuery['aggregation'];
  bucketMs?: number;
  series: Array<{
    variableId: string;
    truncated: boolean;
    availableFromMs: number | null;
    availableToMs: number | null;
    points: Array<{
      timestamp: number;
      value: number | null;
      count: number;
      quality?: RuntimeValue['quality'];
      id?: number;
    }>;
  }>;
}
