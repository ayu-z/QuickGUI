export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Locale = 'zh-CN' | 'en';
export type ThemeMode = 'light' | 'dark' | 'system';
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
}
export type WidgetStyle = Record<string, string | number>;
export interface Binding {
  variable: string;
  mode: 'oneWay' | 'twoWay' | 'once';
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
  type: 'number' | 'string' | 'boolean';
  initial: string | number | boolean;
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
  | 'window';
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
}
export interface ComponentModule {
  id: string;
  name: string;
  version: string;
  width: number;
  height: number;
  widgets: Widget[];
  exposedProps: Record<string, { widgetId: string; property: string; default: Json }>;
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
  schemaVersion: 1 | 2;
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
}
export interface ScriptRequest {
  source: string;
  input: Json;
  variables: Record<string, number>;
  state: Record<string, number>;
  timeoutMs: number;
}
export interface ScriptResponse {
  output: Json;
  writes: Record<string, number>;
  state: Record<string, number>;
  logs: string[];
}
