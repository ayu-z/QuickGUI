import type {
  FlowNode,
  Json,
  Project,
  RuntimeLog,
  RuntimeSnapshot,
  RuntimeValue,
  ScriptRequest,
  ScriptResponse,
} from '../core/types';
import { uid } from '../core/project';
import { validateFlow } from '../core/validation';

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
  constructor(
    project: Project,
    private executeScript?: ScriptExecutor,
  ) {
    this.project = project;
    this.snapshot = {
      values: Object.fromEntries(
        project.variables.map((v) => [
          v.id,
          { value: v.initial, quality: 'good', timestamp: Date.now() },
        ]),
      ),
      logs: [],
      running: true,
      activeNodes: [],
      revision: project.revision,
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
  getHistory(id: string) {
    return this.history[id] ?? [];
  }
  setVariable = (id: string, value: Json) => {
    const variable = this.project.variables.find((v) => v.id === id || v.name === id);
    if (!variable) throw new Error(`Unknown variable: ${id}`);
    if (variable.readOnly) throw new Error(`Variable is read-only: ${variable.name}`);
    if (typeof value !== variable.type || (typeof value === 'number' && !Number.isFinite(value)))
      throw new Error(`Expected ${variable.type}: ${variable.name}`);
    const previous = this.snapshot.values[variable.id]?.value;
    this.publish({
      values: {
        ...this.snapshot.values,
        [variable.id]: { value, quality: 'good', timestamp: Date.now() },
      },
    });
    if (typeof value === 'number') {
      this.history[variable.id] = [...(this.history[variable.id] ?? []).slice(-119), value];
      const { min, max } = variable.alarm ?? {};
      const bad = (min !== undefined && value < min) || (max !== undefined && value > max);
      const wasBad =
        typeof previous === 'number' &&
        ((min !== undefined && previous < min) || (max !== undefined && previous > max));
      if (bad && !wasBad)
        this.log(`Alarm: ${variable.name} = ${value} ${variable.unit ?? ''}`, 'warning');
    }
  };
  applyProject = (project: Project) => {
    for (const flow of project.flows) validateFlow(flow);
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
        old && typeof old.value === v.type
          ? old
          : { value: v.initial, quality: 'good', timestamp: Date.now() };
    }
    this.project = project;
    this.publish({
      values,
      revision: project.revision,
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
            if (result.port && edge.sourceHandle && edge.sourceHandle !== result.port) continue;
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
      case 'read': {
        const id = this.project.variables.find(
          (v) => v.id === c.variable || v.name === c.variable,
        )?.id;
        if (!id) throw new Error(`Unknown variable: ${c.variable}`);
        value = this.snapshot.values[id].value;
        break;
      }
      case 'write':
        this.setVariable(String(c.variable), Object.hasOwn(c, 'value') ? c.value : input);
        break;
      case 'math': {
        const a = Number(input),
          b = Number(c.operand ?? 1);
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
        const b = c.value;
        const a = input;
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
          const timeout = Math.min(30000, Math.max(0, Number(c.ms ?? 100)));
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
        if (!this.executeScript)
          throw new Error(
            'C scripts require the desktop runtime. Run npm run desktop with libtcc installed.',
          );
        const script = this.project.scripts.find((s) => s.id === c.scriptId);
        if (!script) throw new Error('C script not found');
        const variables = Object.fromEntries(
          Object.entries(this.snapshot.values)
            .filter(([, v]) => typeof v.value === 'number')
            .map(([key, v]) => [key, v.value as number]),
        );
        const response = await this.executeScript({
          source: script.source,
          input,
          variables,
          state: this.scriptState[script.id] ?? {},
          timeoutMs: script.timeoutMs,
        });
        signal.throwIfAborted();
        for (const [key, v] of Object.entries(response.writes)) {
          const variable = this.project.variables.find((x) => x.id === key || x.name === key);
          if (!variable || variable.readOnly || variable.type !== 'number' || !Number.isFinite(v))
            throw new Error(`Invalid C write: ${key}`);
        }
        for (const [key, v] of Object.entries(response.writes)) this.setVariable(key, v);
        this.scriptState[script.id] = response.state;
        for (const message of response.logs) this.log(message, 'info', node.id);
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
