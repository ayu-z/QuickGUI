import type { Json, JsonPath, Project, RuntimeLog, RuntimeSnapshot } from '../core/types';
import * as native from '../native/bridge';
import { RuntimeController } from './engine';

export class NativeRuntimeController extends RuntimeController {
  private ready: Promise<void>;
  private revision: number;
  private requestedProjectId: string;
  private disposed = false;
  private closing = false;
  private unlisten?: () => void;
  private storageUnlisten?: () => void;
  private accepted = { projectId: '', revision: -1, sequence: -1 };
  private updateError?: RuntimeLog;
  private accept = (snapshot: RuntimeSnapshot) => {
    if (this.disposed || snapshot.revision !== this.project.revision) return;
    if (snapshot.projectId && snapshot.projectId !== this.project.id) return;
    const sequence = snapshot.sequence ?? this.accepted.sequence + 1;
    if (
      this.accepted.projectId === this.project.id &&
      this.accepted.revision === snapshot.revision &&
      sequence <= this.accepted.sequence
    )
      return;
    this.accepted = { projectId: this.project.id, revision: snapshot.revision, sequence };
    this.publish({
      ...snapshot,
      logs: this.updateError ? [...snapshot.logs, this.updateError] : snapshot.logs,
    });
  };
  constructor(
    project: Project,
    private readonly options: { attachOnly?: boolean } = {},
  ) {
    super(project, native.executeC);
    this.revision = project.revision;
    this.requestedProjectId = project.id;
    this.ready = Promise.all([
      native.onRuntimeSnapshot(this.accept),
      native.onStorageError((error) => this.log(`Storage: ${error}`, 'error')),
    ])
      .then(async ([unlisten, storageUnlisten]) => {
        if (this.disposed) {
          unlisten();
          storageUnlisten();
          return;
        }
        this.unlisten = unlisten;
        this.storageUnlisten = storageUnlisten;
        if (this.closing) return;
        this.accept(
          await (this.options.attachOnly ? native.attachRuntime() : native.runtimeStart(project)),
        );
      })
      .catch((error) => this.log(String(error), 'error'));
  }
  override setVariable = (id: string, value: Json, path?: JsonPath) => {
    if (this.disposed || this.closing) return;
    void this.ready
      .then(async () => {
        if (!this.disposed && !this.closing) this.accept(await native.setVariable(id, value, path));
      })
      .catch((error) => this.log(String(error), 'error'));
  };
  override applyProject = (project: Project) => {
    if (this.disposed || this.closing) return;
    if (
      this.options.attachOnly &&
      project.id === this.project.id &&
      project.revision < this.project.revision
    )
      return;
    if (this.revision === project.revision && this.requestedProjectId === project.id) return;
    this.revision = project.revision;
    this.requestedProjectId = project.id;
    if (this.options.attachOnly) {
      // Only the owner applies/compiles project revisions. Child views receive
      // already committed documents and attach to the existing engine state.
      this.project = project;
      this.ready = this.ready
        .then(async () => {
          if (!this.disposed && !this.closing) this.accept(await native.attachRuntime());
        })
        .catch((error) => this.log(String(error), 'error'));
      return;
    }
    this.ready = this.ready
      .then(async () => {
        if (this.disposed || this.closing) return;
        const previous = this.project;
        for (const script of project.scripts) {
          const old =
            previous.id === project.id
              ? previous.scripts.find((item) => item.id === script.id)
              : undefined;
          if (old?.source === script.source) continue;
          await native.validateC({
            source: script.source,
            input: 0,
            variables: {},
            state: {},
            timeoutMs: script.timeoutMs,
            variableAliases: script.variableAliases,
          });
          if (this.disposed || this.closing) return;
        }
        this.updateError = undefined;
        this.project = project;
        try {
          this.accept(await native.runtimeStart(project));
        } catch (error) {
          this.project = previous;
          throw error;
        }
      })
      .catch((error) => {
        if (this.disposed || this.closing) return;
        this.updateError = {
          id: 'quickgui-update-error',
          time: Date.now(),
          level: 'error',
          message: `Update rejected; keeping revision ${this.project.revision}: ${String(error)}`,
        };
        this.publish({
          logs: [
            ...this.snapshot.logs.filter((log) => log.id !== this.updateError!.id),
            this.updateError,
          ],
        });
      });
  };
  override runScript = async (scriptId: string, input: Json = null) => {
    await this.ready;
    if (this.disposed || this.closing) throw new Error('Project is closed or closing');
    const response = await native.runScript(scriptId, input);
    this.accept(await native.snapshot());
    return response;
  };
  override runFlow = async (id: string, input: Json = null) => {
    await this.ready;
    if (this.disposed || this.closing) throw new Error('Project is closed or closing');
    try {
      this.accept(await native.runFlow(id, input));
    } catch (error) {
      this.log(String(error), 'error');
      throw error;
    }
  };
  override windowAction = (action: 'open' | 'close' | 'focus', windowId: string) => {
    if (this.disposed || this.closing) return;
    void this.ready
      .then(async () => {
        if (!this.disposed && !this.closing)
          this.accept(await native.windowAction(action, windowId));
      })
      .catch((error) => this.log(String(error), 'error'));
  };
  override stop = () => {
    void native
      .stop()
      .then(this.accept)
      .catch((error) => this.log(String(error), 'error'));
  };
  override start = () => {
    if (this.disposed || this.closing) return;
    const project = this.project;
    this.ready = this.ready
      .then(async () => {
        if (!this.disposed && !this.closing)
          this.accept(
            await (this.options.attachOnly ? native.attachRuntime() : native.runtimeStart(project)),
          );
      })
      .catch((error) => this.log(String(error), 'error'));
  };
  override dispose() {
    this.disposed = true;
    this.unlisten?.();
    this.storageUnlisten?.();
    this.listeners.clear();
  }
  override async closeProject(): Promise<string[]> {
    if (this.disposed) return [];
    this.closing = true;
    try {
      await native.closeProject();
      this.dispose();
      return [];
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }
}
export function createRuntime(
  project: Project,
  options: { attachOnly?: boolean } = {},
): RuntimeController {
  const windowId =
    typeof location === 'undefined'
      ? 'main'
      : (new URLSearchParams(location.search).get('windowId') ?? 'main');
  return native.isDesktop()
    ? new NativeRuntimeController(project, {
        attachOnly: options.attachOnly ?? windowId !== 'main',
      })
    : new RuntimeController(project);
}
