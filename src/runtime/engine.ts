import type {
  FlowNode,
  Json,
  JsonPath,
  Project,
  RuntimeLog,
  RuntimeSnapshot,
  RuntimeValue,
  ScriptRequest,
  ScriptResponse,
  WindowAction,
  Variable,
} from '../core/types';
import {
  cloneJson,
  equalJson,
  readJsonPath,
  replaceJsonPath,
  validateJsonPath,
  variableValue,
} from '../core/jsonValue';
import { uid } from '../core/project';
import { validateFlow } from '../core/validation';
import {
  applyWindowAction,
  initialWindowState,
  reconcileWindowState,
  validateWindowActions,
} from './windowState';

export type ScriptExecutor = (request: ScriptRequest) => Promise<ScriptResponse>;
export class RuntimeController {
  protected project: Project;
  protected listeners = new Set<() => void>();
  protected snapshot: RuntimeSnapshot;
  private abort = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private generation = 0;
  private scriptState: Record<string, Record<string, number>> = {};
  private history: Record<string, number[]> = {};
  private timers: ReturnType<typeof setInterval>[] = [];
  private booted = new Set<string>();
  private activated = false;
  constructor(
    project: Project,
    private executeScript?: ScriptExecutor,
  ) {
    this.validateRuntimeValues(project);
    validateWindowActions(project);
    this.project = project;
    this.snapshot = {
      values: Object.fromEntries(
        project.variables.map((v) => [
          v.id,
          { value: variableValue(v, v.initial), quality: 'good', timestamp: Date.now() },
        ]),
      ),
      logs: [],
      running: true,
      activeNodes: [],
      revision: project.revision,
      windowState: initialWindowState(project),
    };
  }
  getSnapshot = () => this.snapshot;
  getProject = () => this.project;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected publish(patch: Partial<RuntimeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  log(message: string, level: RuntimeLog['level'] = 'info', nodeId?: string, flowId?: string) {
    this.publish({
      logs: [
        ...this.snapshot.logs.slice(-499),
        { id: uid('log'), time: Date.now(), level, message, nodeId, flowId },
      ],
    });
  }
  clearLogs = () => this.publish({ logs: [] });
  windowAction = (action: WindowAction, windowId: string): void => {
    const state = this.snapshot.windowState ?? initialWindowState(this.project);
    this.publish({ windowState: applyWindowAction(this.project, state, action, windowId) });
  };
  getHistory(id: string) {
    return this.history[id] ?? [];
  }
  setVariable = (id: string, value: Json, path?: JsonPath) => {
    const variable = this.resolveVariable(id);
    if (!variable) throw new Error(`Unknown variable: ${id}`);
    if (variable.readOnly) throw new Error(`Variable is read-only: ${variable.name}`);
    if (path !== undefined) validateJsonPath(path);
    if (path?.length) {
      if (this.project.schemaVersion < 3 || variable.type !== 'json')
        throw new Error('JSON paths require schemaVersion 3 and a json variable');
      value = replaceJsonPath(this.snapshot.values[variable.id].value, path, value);
    }
    value = variableValue(variable, value);
    const previous = this.snapshot.values[variable.id]?.value;
    this.publish({
      values: {
        ...this.snapshot.values,
        [variable.id]: { value, quality: 'good', timestamp: Date.now() },
      },
    });
    this.recordNumericChange(variable, value, previous);
  };
  private recordNumericChange(variable: Variable, value: Json, previous: Json | undefined) {
    if (variable.type === 'number' && typeof value === 'number') {
      this.history[variable.id] = [...(this.history[variable.id] ?? []).slice(-119), value];
      const { min, max } = variable.alarm ?? {};
      const bad = (min !== undefined && value < min) || (max !== undefined && value > max);
      const wasBad =
        typeof previous === 'number' &&
        ((min !== undefined && previous < min) || (max !== undefined && previous > max));
      if (bad && !wasBad)
        this.log(`Alarm: ${variable.name} = ${value} ${variable.unit ?? ''}`, 'warning');
    }
  }
  applyProject = (project: Project) => {
    this.validateRuntimeValues(project);
    validateWindowActions(project);
    for (const flow of project.flows) validateFlow(flow);
    if (
      this.activated &&
      project.id === this.project.id &&
      project.revision === this.snapshot.revision
    )
      return;
    this.activated = true;
    this.abort.abort();
    this.abort = new AbortController();
    this.generation++;
    const sameProject = project.id === this.project.id;
    if (!sameProject) {
      this.scriptState = {};
      this.history = {};
      this.booted.clear();
    }
    const values: Record<string, RuntimeValue> = {};
    for (const v of project.variables) {
      const old = sameProject ? this.snapshot.values[v.id] : undefined;
      values[v.id] =
        old &&
        this.project.variables.some((previous) => previous.id === v.id && previous.type === v.type)
          ? old
          : { value: variableValue(v, v.initial), quality: 'good', timestamp: Date.now() };
    }
    const windowState = sameProject
      ? reconcileWindowState(
          this.project,
          project,
          this.snapshot.windowState ?? initialWindowState(this.project),
        )
      : initialWindowState(project);
    this.project = project;
    this.publish({
      values,
      revision: project.revision,
      windowState,
      activeNodes: [],
      running: true,
      ...(!sameProject ? { logs: [] } : {}),
    });
    this.scheduleEvents();
  };
  stop = () => {
    this.abort.abort();
    this.generation++;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.publish({ running: false, activeNodes: [] });
  };
  start = () => {
    this.activated = true;
    this.abort = new AbortController();
    this.publish({ running: true });
    this.scheduleEvents();
  };
  private scheduleEvents() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const flow of this.project.flows.filter((f) => f.enabled))
      for (const node of flow.nodes.filter((n) => n.kind === 'event')) {
        const trigger = node.config.trigger;
        if (trigger === 'interval') {
          const ms = Number(node.config.intervalMs ?? 1000);
          if (!Number.isFinite(ms) || ms < 100 || ms > 86400000) {
            this.log('Interval must be between 100 and 86400000 ms', 'error', node.id);
            continue;
          }
          this.timers.push(
            setInterval(() => {
              if (this.queued === 0 && this.snapshot.running)
                void this.runFlow(flow.id, null, node.id).catch((e) =>
                  this.log(String(e), 'error'),
                );
            }, ms),
          );
        } else if (trigger === 'startup') {
          const key = `${this.project.id}:${flow.id}:${node.id}`;
          if (!this.booted.has(key)) {
            this.booted.add(key);
            void this.runFlow(flow.id, null, node.id).catch((e) => this.log(String(e), 'error'));
          }
        }
      }
  }
  runFlow = (id: string, input: Json = null, entryNode?: string): Promise<void> => {
    if (!this.snapshot.running) return Promise.reject(new Error('Runtime is stopped'));
    if (this.queued >= 256)
      return Promise.reject(new Error('Flow queue is full; command was not accepted'));
    const generation = this.generation;
    this.queued++;
    const task = this.queue
      .then(async () => {
        if (generation !== this.generation) {
          this.log('Queued execution cancelled by project update', 'warning', undefined, id);
          return;
        }
        await this.executeFlow(id, input, this.abort.signal, generation, entryNode);
      })
      .finally(() => {
        this.queued--;
      });
    this.queue = task.catch(() => {});
    return task;
  };
  private async executeFlow(
    id: string,
    input: Json,
    signal: AbortSignal,
    generation: number,
    entryNode?: string,
  ) {
    const flow = this.project.flows.find((f) => f.id === id);
    if (!flow || !flow.enabled) throw new Error(`Flow unavailable: ${id}`);
    const order = validateFlow(flow);
    const messages = new Map<string, Json[]>();
    let activations = 0;
    for (const node of flow.nodes)
      if (node.kind === 'event' && (!entryNode || node.id === entryNode))
        messages.set(node.id, [input]);
    this.log(`Started: ${flow.name}`, 'info', undefined, id);
    try {
      for (const nodeId of order) {
        signal.throwIfAborted();
        const node = flow.nodes.find((n) => n.id === nodeId)!;
        for (const message of messages.get(nodeId) ?? []) {
          if (++activations > 10000) throw new Error('Flow activation limit exceeded');
          this.publish({ activeNodes: [nodeId] });
          const result = await this.executeNode(node, message, signal);
          signal.throwIfAborted();
          if (generation !== this.generation) throw new Error('Stale execution');
          for (const edge of flow.edges.filter((e) => e.source === nodeId)) {
            if (
              result.port &&
              (this.project.schemaVersion >= 3
                ? (edge.sourceHandle ?? 'true') !== result.port
                : edge.sourceHandle && edge.sourceHandle !== result.port)
            )
              continue;
            const incoming = messages.get(edge.target) ?? [];
            if (incoming.length >= 256) throw new Error('Node input queue limit exceeded');
            incoming.push(result.value);
            messages.set(edge.target, incoming);
          }
        }
      }
      this.log(`Completed: ${flow.name}`, 'info', undefined, id);
    } catch (error) {
      this.log(
        signal.aborted ? 'Execution cancelled' : String(error),
        signal.aborted ? 'warning' : 'error',
        undefined,
        id,
      );
      if (!signal.aborted) throw error;
    } finally {
      if (generation === this.generation) this.publish({ activeNodes: [] });
    }
  }
  private async executeNode(
    node: FlowNode,
    input: Json,
    signal: AbortSignal,
  ): Promise<{ value: Json; port?: string }> {
    const c = node.config;
    let value = input;
    switch (node.kind) {
      case 'event':
        break;
      case 'window':
        this.windowAction(String(c.action) as WindowAction, String(c.windowId));
        break;
      case 'read': {
        const variable = this.resolveVariable(String(c.variable));
        const id = variable?.id;
        if (!id) throw new Error(`Unknown variable: ${c.variable}`);
        value = this.snapshot.values[id].value;
        if (c.path !== undefined) {
          validateJsonPath(c.path);
          if (c.path.length && (this.project.schemaVersion < 3 || variable?.type !== 'json'))
            throw new Error('JSON paths require schemaVersion 3 and a json variable');
          value = readJsonPath(value, c.path);
        } else value = cloneJson(value);
        break;
      }
      case 'write': {
        const written = Object.hasOwn(c, 'value') ? c.value : input;
        if (c.path !== undefined) validateJsonPath(c.path);
        this.setVariable(String(c.variable), written, c.path as JsonPath | undefined);
        if (this.project.schemaVersion >= 3) value = cloneJson(written);
        break;
      }
      case 'math': {
        const strict = this.project.schemaVersion >= 3;
        if (
          strict &&
          (typeof input !== 'number' ||
            typeof c.operand !== 'number' ||
            !['add', 'subtract', 'multiply', 'divide'].includes(String(c.operation)))
        )
          throw new Error('Math requires numeric inputs and a valid operation');
        const a = Number(input),
          b = Number(strict ? c.operand : (c.operand ?? 1));
        if (!Number.isFinite(a) || !Number.isFinite(b))
          throw new Error('Math node requires finite numbers');
        if (c.operation === 'divide' && b === 0) throw new Error('Division by zero');
        value =
          c.operation === 'subtract'
            ? a - b
            : c.operation === 'multiply'
              ? a * b
              : c.operation === 'divide'
                ? a / b
                : a + b;
        if (!Number.isFinite(value)) throw new Error('Numeric overflow');
        break;
      }
      case 'condition': {
        const b = this.project.schemaVersion >= 3 ? (c.value ?? null) : c.value;
        const a = input;
        if (this.project.schemaVersion >= 3) {
          if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(String(c.operator)))
            throw new Error('Unknown comparison');
          const equality = c.operator === 'eq' || c.operator === 'neq';
          if (
            !equality &&
            (typeof a !== 'number' ||
              typeof b !== 'number' ||
              !Number.isFinite(a) ||
              !Number.isFinite(b))
          )
            throw new Error('Comparison requires numeric inputs');
          const pass = equality
            ? c.operator === 'eq'
              ? equalJson(a, b)
              : !equalJson(a, b)
            : c.operator === 'gt'
              ? Number(a) > Number(b)
              : c.operator === 'gte'
                ? Number(a) >= Number(b)
                : c.operator === 'lt'
                  ? Number(a) < Number(b)
                  : Number(a) <= Number(b);
          return { value: cloneJson(input), port: pass ? 'true' : 'false' };
        }
        const pass =
          c.operator === 'eq'
            ? a === b
            : c.operator === 'neq'
              ? a !== b
              : c.operator === 'gte'
                ? Number(a) >= Number(b)
                : c.operator === 'lt'
                  ? Number(a) < Number(b)
                  : c.operator === 'lte'
                    ? Number(a) <= Number(b)
                    : Number(a) > Number(b);
        return { value, port: pass ? 'true' : 'false' };
      }
      case 'delay':
        await new Promise<void>((resolve, reject) => {
          if (
            this.project.schemaVersion >= 3 &&
            (typeof c.ms !== 'number' || !Number.isInteger(c.ms) || c.ms < 0)
          )
            throw new Error('Delay ms must be a nonnegative integer');
          const timeout =
            this.project.schemaVersion >= 3
              ? Math.min(60000, Number(c.ms))
              : Math.min(30000, Math.max(0, Number(c.ms ?? 100)));
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('Cancelled'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, timeout);
          signal.addEventListener('abort', abort, { once: true });
        });
        break;
      case 'log':
        this.log(
          `${String(c.message ?? '')}${c.message ? ': ' : ''}${JSON.stringify(input)}`,
          'info',
          node.id,
        );
        break;
      case 'emit':
        this.log(`Event ${String(c.event ?? 'output')}: ${JSON.stringify(input)}`, 'info', node.id);
        break;
      case 'script': {
        const response = await this.executeScriptTransaction(String(c.scriptId), input, node.id);
        signal.throwIfAborted();
        value = response.output;
        break;
      }
      case 'http': {
        const url = new URL(String(c.url));
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP(S) URL required');
        const response = await fetch(url, {
          method: String(c.method ?? 'GET'),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          ...(c.body === undefined
            ? {}
            : {
                body: typeof c.body === 'string' ? c.body : JSON.stringify(c.body),
                headers: { 'Content-Type': 'application/json' },
              }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > 4_000_000) throw new Error('Response exceeds 4 MB');
        try {
          value = JSON.parse(text) as Json;
        } catch {
          value = text;
        }
        break;
      }
      case 'connection': {
        const connection = this.project.connections.find((x) => x.id === c.connectionId);
        if (!connection) throw new Error('Connection not found');
        const native = await import('../native/bridge');
        if (!native.isDesktop())
          throw new Error('Native connection nodes require the desktop runtime');
        value = (await native.testConnection(connection)) as unknown as Json;
        break;
      }
    }
    return { value };
  }
  private validateRuntimeValues(project: Project) {
    for (const variable of project.variables) {
      if (variable.type === 'json' && project.schemaVersion < 3)
        throw new Error('JSON variables require schemaVersion 3');
      variableValue(variable, variable.initial);
    }
    for (const script of project.scripts)
      if (script.variableAliases !== undefined) {
        if (project.schemaVersion < 3) throw new Error('C aliases require schemaVersion 3');
        for (const target of Object.values(script.variableAliases))
          if (!project.variables.some((v) => v.id === target && v.type === 'number'))
            throw new Error(`Invalid C alias target: ${target}`);
      }
    for (const flow of project.flows)
      for (const node of flow.nodes)
        if (node.config.path !== undefined) {
          if (project.schemaVersion < 3) throw new Error('JSON paths require schemaVersion 3');
          validateJsonPath(node.config.path);
        }
  }
  private resolveVariable(key: string) {
    return (
      this.project.variables.find((v) => v.id === key) ??
      this.project.variables.find((v) => v.name === key)
    );
  }
  runScript = (
    scriptId: string,
    input: Json = null,
    expectedRevision?: number,
  ): Promise<ScriptResponse> => {
    if (expectedRevision !== undefined && this.project.revision !== expectedRevision)
      return Promise.reject(
        new Error(
          'The requested project revision was not accepted; script execution was cancelled',
        ),
      );
    if (this.queued >= 256)
      return Promise.reject(new Error('Flow queue is full; command was not accepted'));
    const generation = this.generation;
    this.queued++;
    const task = this.queue
      .then(() => {
        if (generation !== this.generation) throw new Error('Stale C execution');
        return this.executeScriptTransaction(scriptId, input);
      })
      .finally(() => {
        this.queued--;
      });
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  private async executeScriptTransaction(
    scriptId: string,
    input: Json,
    nodeId?: string,
  ): Promise<ScriptResponse> {
    if (!this.executeScript) throw new Error('C scripts require the desktop runtime');
    const script = this.project.scripts.find((s) => s.id === scriptId);
    if (!script) throw new Error('C script not found');
    const generation = this.generation;
    const variables: Record<string, number> = Object.create(null) as Record<string, number>;
    const numeric = this.project.variables.filter((v) => v.type === 'number');
    for (const variable of numeric)
      variables[variable.name] = this.snapshot.values[variable.id].value as number;
    for (const variable of numeric)
      variables[variable.id] = this.snapshot.values[variable.id].value as number;
    if (script.variableAliases !== undefined) {
      if (this.project.schemaVersion < 3) throw new Error('C aliases require schemaVersion 3');
      for (const target of Object.values(script.variableAliases))
        if (!numeric.some((v) => v.id === target))
          throw new Error(`Invalid C alias target: ${target}`);
    }
    const response = await this.executeScript({
      source: script.source,
      input: cloneJson(input),
      variables,
      state: { ...(this.scriptState[scriptId] ?? {}) },
      timeoutMs: script.timeoutMs,
      ...(script.variableAliases === undefined
        ? {}
        : { variableAliases: { ...script.variableAliases } }),
    });
    if (generation !== this.generation || this.abort.signal.aborted)
      throw new Error('Stale C execution');
    const output = cloneJson(response.output);
    if (Object.values(response.state).some((v) => !Number.isFinite(v)))
      throw new Error('Invalid C state');
    const writes: Record<string, RuntimeValue> = {};
    for (const [key, value] of Object.entries(response.writes)) {
      const variable =
        script.variableAliases === undefined
          ? this.resolveVariable(key)
          : this.project.variables.find((v) => v.id === key);
      if (
        script.variableAliases !== undefined &&
        !Object.values(script.variableAliases).includes(key)
      )
        throw new Error(`C wrote outside alias scope: ${key}`);
      if (!variable || variable.readOnly || variable.type !== 'number' || !Number.isFinite(value))
        throw new Error(`Invalid C write: ${key}`);
      writes[variable.id] = { value, quality: 'good', timestamp: Date.now() };
    }
    const previousValues = this.snapshot.values;
    this.scriptState[scriptId] = { ...response.state };
    this.publish({ values: { ...previousValues, ...writes } });
    for (const [id, current] of Object.entries(writes))
      this.recordNumericChange(this.resolveVariable(id)!, current.value, previousValues[id]?.value);
    for (const message of response.logs) this.log(message, 'info', nodeId);
    return { ...response, output };
  }
  dispose() {
    this.stop();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.listeners.clear();
  }
  async closeProject(): Promise<string[]> {
    this.dispose();
    return [];
  }
}
