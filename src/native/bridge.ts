import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  Connection,
  HistoryRangeQuery,
  HistoryRangeResult,
  Json,
  JsonPath,
  Project,
  PortSnapshot,
  RuntimeSnapshot,
  ScriptRequest,
  ScriptResponse,
  WindowConfig,
} from '../core/types';

export const isDesktop = (): boolean => isTauri();
let generationRequest: Promise<number> | undefined;
let observedGeneration: number | undefined;
let bridgeEpoch = 0;
let closing: Promise<CloseProjectResult> | undefined;

async function currentGeneration(): Promise<number> {
  const request = (generationRequest ??= invoke<number>('project_generation'));
  try {
    const generation = await request;
    if (generationRequest === request) observedGeneration = generation;
    return generation;
  } catch (error) {
    if (generationRequest === request) generationRequest = undefined;
    throw error;
  }
}

function invokeProject<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (closing) return Promise.reject(new Error('Project close is in progress'));
  const epoch = bridgeEpoch;
  return currentGeneration().then((generation) => {
    if (epoch !== bridgeEpoch || closing) throw new Error('Operation cancelled by project close');
    return invoke<T>(command, { ...args, generation }).then((result) => {
      if (epoch !== bridgeEpoch || closing) throw new Error('Operation cancelled by project close');
      return result;
    });
  });
}

export interface CloseProjectResult {
  generation: number;
}
export function closeProject(): Promise<CloseProjectResult> {
  if (closing) return closing;
  bridgeEpoch++;
  closing = (async () => {
    try {
      const result = await invoke<CloseProjectResult>('close_project');
      generationRequest = Promise.resolve(result.generation);
      observedGeneration = result.generation;
      return result;
    } catch (error) {
      // Closing invalidates old work even when a final database flush must be retried.
      generationRequest = undefined;
      try {
        await currentGeneration();
      } catch {
        /* Preserve the original close failure. */
      }
      throw error;
    } finally {
      closing = undefined;
    }
  })();
  return closing;
}

export const executeC = (request: ScriptRequest) =>
  invokeProject<ScriptResponse>('execute_c', { request });
export const validateC = (request: ScriptRequest) => invokeProject<void>('validate_c', { request });
export interface ConnectionTestResult {
  connectionId: string;
  protocol: string;
  latencyMs: number;
  bytesSent: number;
  bytesReceived: number;
  received: string;
  details: string;
}
export const testConnection = (connection: Connection) =>
  invokeProject<ConnectionTestResult>('test_connection', { connection });
export const scanSerialPorts = (): Promise<PortSnapshot> => {
  if (!isDesktop())
    return Promise.reject(
      Object.assign(new Error('Serial ports require the QuickGUI desktop runtime.'), {
        code: 'NATIVE_SERIAL_REQUIRED',
      }),
    );
  return invokeProject<PortSnapshot>('serial_scan');
};
export const runtimeStart = (project: Project) =>
  invokeProject<RuntimeSnapshot>('runtime_start', { project });
export const attachRuntime = () => invokeProject<RuntimeSnapshot>('runtime_attach');
export const windowAction = (action: 'open' | 'close' | 'focus', windowId: string) =>
  invokeProject<RuntimeSnapshot>('runtime_window_action', { action, windowId });
export const runFlow = (flowId: string, input: Json = null) =>
  invokeProject<RuntimeSnapshot>('runtime_run_flow', { flowId, input });
export const setVariable = (name: string, value: Json, path?: JsonPath) =>
  invokeProject<RuntimeSnapshot>('runtime_set_variable', { name, value, path });
export const runScript = (scriptId: string, input: Json = null) =>
  invokeProject<ScriptResponse>('runtime_run_script', { scriptId, input });
export const snapshot = () => invoke<RuntimeSnapshot>('runtime_snapshot');
export const stop = () => invokeProject<RuntimeSnapshot>('runtime_stop');
export const openPreview = (project: Project, windowId?: string) =>
  invokeProject<{ warnings: string[] }>('open_preview', { project, windowId });
export const closePreview = () => invoke<void>('close_preview');
export const onPreviewClosed = (callback: () => void) => listen('preview-closed', callback);
export const getPreviewProject = () => invoke<Project>('get_preview_project');
export const applyWindow = (config: WindowConfig) =>
  invoke<{ warnings: string[] }>('apply_window', { config });
export const saveProject = (project: Project, path?: string) =>
  invoke<string | null>('save_project', { project, path });
export const loadProject = (path?: string) => invoke<Project | null>('load_project', { path });
export const exportSource = (project: Project, outputDir?: string) =>
  invoke<string | null>('export_source', { project, outputDir });
export const onProjectUpdated = async (callback: (project: Project) => void) => {
  await currentGeneration();
  return listen<Project | { project: Project; projectGeneration: number }>(
    'project-updated',
    (event) => {
      if (closing) return;
      if (
        !('schemaVersion' in event.payload) &&
        'projectGeneration' in event.payload &&
        'project' in event.payload
      ) {
        if (event.payload.projectGeneration !== observedGeneration) return;
        callback(event.payload.project as Project);
      } else callback(event.payload as Project);
    },
  );
};
export const onRuntimeSnapshot = async (callback: (value: RuntimeSnapshot) => void) => {
  const epoch = bridgeEpoch;
  await currentGeneration();
  if (epoch !== bridgeEpoch || closing) return () => {};
  return listen<RuntimeSnapshot & { projectGeneration?: number }>('runtime-snapshot', (event) => {
    if (
      closing ||
      (event.payload.projectGeneration !== undefined &&
        event.payload.projectGeneration !== observedGeneration)
    )
      return;
    callback(event.payload);
  });
};
export interface RuntimeEvent {
  event: string;
  payload: Json;
  time: number;
  flowId: string;
  nodeId: string;
}
export const onRuntimeEvent = (callback: (value: RuntimeEvent) => void) =>
  listen<RuntimeEvent>('runtime-event', (event) => callback(event.payload));
export interface BuildResult {
  sourceDir: string;
  artifactDir: string;
  artifacts: string[];
  signingStatus: string;
}
export interface BuildProgress {
  stage: string;
  message: string;
}
export const buildRuntime = (project: Project, outputDir?: string) =>
  invokeProject<BuildResult | null>('build_runtime', { project, outputDir });
export const cancelBuild = () => invoke<void>('cancel_build');
export const onBuildProgress = (callback: (event: BuildProgress) => void) =>
  listen<BuildProgress>('build-progress', (event) => callback(event.payload));
export interface HistorySample {
  id: number;
  variableId: string;
  timestamp: number;
  value: number;
  quality: string;
}
export interface AlarmRecord {
  id: number;
  variableId: string;
  variableName: string;
  direction: string;
  threshold: number;
  value: number;
  startedAt: number;
  clearedAt: number | null;
  acknowledgedAt: number | null;
  active: boolean;
  acknowledged: boolean;
}
export const queryHistory = (variableId: string, limit = 1000) =>
  invokeProject<HistorySample[]>('query_history', { variableId, limit });
export const queryAlarms = (limit = 1000) =>
  invokeProject<AlarmRecord[]>('query_alarms', { limit });
export const ackAlarm = (id: number) => invokeProject<void>('ack_alarm', { id });
export const onStorageError = (callback: (error: string) => void) =>
  listen<string>('storage-error', (event) => callback(event.payload));

export type { HistoryRangeQuery, HistoryRangeResult } from '../core/types';
export const queryHistoryRange = (query: HistoryRangeQuery): Promise<HistoryRangeResult> => {
  if (!isDesktop())
    return Promise.reject(new Error('Native SQLite history is unavailable in the browser'));
  return invokeProject<HistoryRangeResult>('query_history_range', { query });
};

export const readClipboardText = () => invoke<string>('clipboard_read');
export const writeClipboardText = (text: string) => invoke<void>('clipboard_write', { text });
