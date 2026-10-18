import type { Project, Widget, WindowConfig } from './types';
import { cloneSubtree, createProject, createWidget, uid } from './project';
import { validateProject } from './validation';
import { getProjectWindow, listProjectWindows, MAX_ADDITIONAL_WINDOWS } from './windows';

export type Section = 'design' | 'flows' | 'scripts' | 'data' | 'connections';
export interface ProjectRecovery {
  project: Project;
  drafts: Record<string, string>;
  activeWindowId?: string;
}
export interface EditorState {
  project: Project | null;
  selectedId: string | null;
  selectedIds: string[];
  transactionLabel: string | null;
  activeWindowId: string;
  section: Section;
  inspector: 'widget' | 'window';
  drafts: Record<string, string>;
  past: Project[];
  future: Project[];
  dirty: boolean;
  savedAt: number | null;
  recoveryError?: string;
  closing: boolean;
  sessionId: number;
  closedRecovery?: ProjectRecovery;
  closeWarnings: string[];
}
export const STORAGE_KEY = 'quickgui.project.v1';
export const CLOSED_STORAGE_KEY = 'quickgui.closed-project.v1';
function equalValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a),
    other = Object.keys(b);
  return (
    keys.length === other.length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equalValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
const sameContent = (a: Project, b: Project) =>
  equalValue({ ...a, revision: 0 }, { ...b, revision: 0 });
function validWindowId(project: Project, id: unknown): string {
  return typeof id === 'string' && listProjectWindows(project).some((window) => window.id === id)
    ? id
    : 'main';
}
function editorSelection(
  project: Project,
  windowId: string,
  selectedId: string | null,
): string | null {
  return selectedId &&
    (getProjectWindow(project, windowId).widgets.some((widget) => widget.id === selectedId) ||
      project.modules.some((module) => module.widgets.some((widget) => widget.id === selectedId)))
    ? selectedId
    : null;
}
function parseRecovery(raw: string): ProjectRecovery {
  const saved = JSON.parse(raw);
  const project = validateProject(saved.project);
  const drafts = saved.drafts ?? {};
  if (
    !drafts ||
    typeof drafts !== 'object' ||
    Array.isArray(drafts) ||
    Object.values(drafts).some((value) => typeof value !== 'string')
  )
    throw new Error('Invalid editor recovery drafts');
  return { project, drafts, activeWindowId: validWindowId(project, saved.activeWindowId) };
}
export function loadRecovery(): Pick<
  EditorState,
  'project' | 'drafts' | 'closedRecovery' | 'recoveryError' | 'activeWindowId'
> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && JSON.parse(raw).closed === true) {
      const closed = localStorage.getItem(CLOSED_STORAGE_KEY);
      return {
        project: null,
        drafts: {},
        activeWindowId: 'main',
        closedRecovery: closed ? parseRecovery(closed) : undefined,
      };
    }
    if (raw) {
      const recovery = parseRecovery(raw);
      return { ...recovery, activeWindowId: recovery.activeWindowId ?? 'main' };
    }
  } catch (error) {
    return {
      project: null,
      drafts: {},
      activeWindowId: 'main',
      recoveryError: `Recovery was not applied: ${String(error)}. The original recovery data has been preserved.`,
    };
  }
  return { project: createProject(), drafts: {}, activeWindowId: 'main' };
}

export class EditorStore {
  private listeners = new Set<() => void>();
  private state: EditorState;
  private timer?: ReturnType<typeof setTimeout>;
  private transaction?: {
    project: Project;
    selectedId: string | null;
    selectedIds: string[];
    dirty: boolean;
  };
  constructor(project?: Project) {
    const recovered = project ? { project, drafts: {}, activeWindowId: 'main' } : loadRecovery();
    const activeWidgets = recovered.project
      ? getProjectWindow(recovered.project, recovered.activeWindowId).widgets
      : [];
    this.state = {
      ...recovered,
      selectedId:
        activeWidgets.find((widget) => widget.id === 'start_button')?.id ??
        activeWidgets[0]?.id ??
        null,
      selectedIds: activeWidgets.length
        ? [activeWidgets.find((widget) => widget.id === 'start_button')?.id ?? activeWidgets[0].id]
        : [],
      transactionLabel: null,
      section: 'design',
      inspector: 'widget',
      past: [],
      future: [],
      dirty: false,
      savedAt: null,
      closing: false,
      sessionId: 1,
      closeWarnings: [],
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private set(patch: Partial<EditorState>) {
    if (Object.hasOwn(patch, 'selectedId') && !Object.hasOwn(patch, 'selectedIds'))
      patch.selectedIds = patch.selectedId ? [patch.selectedId] : [];
    if (patch.selectedIds) {
      const primary = Object.hasOwn(patch, 'selectedId') ? patch.selectedId : this.state.selectedId;
      if (!primary || !patch.selectedIds.includes(primary))
        patch.selectedId = patch.selectedIds.at(-1) ?? null;
    }
    this.state = { ...this.state, ...patch };
    this.emit();
  }
  setSection = (section: Section) => {
    if (section !== this.state.section) this.cancelTransaction();
    if (this.state.project && !this.state.closing) this.set({ section });
  };
  select = (selectedId: string | null) => {
    if (this.state.project && !this.state.closing) this.set({ selectedId, inspector: 'widget' });
  };
  setSelection = (ids: string[], primaryId?: string | null) => {
    if (!this.state.project || this.state.closing) return;
    const selectedIds = [...new Set(ids)].filter((id) =>
      editorSelection(this.state.project!, this.state.activeWindowId, id),
    );
    const selectedId =
      primaryId && selectedIds.includes(primaryId) ? primaryId : (selectedIds.at(-1) ?? null);
    this.set({ selectedIds, selectedId, inspector: 'widget' });
  };
  beginTransaction = (label = 'Edit') => {
    if (!this.state.project || this.state.closing) return;
    if (this.transaction) this.commitTransaction();
    this.transaction = {
      project: this.state.project,
      selectedId: this.state.selectedId,
      selectedIds: [...this.state.selectedIds],
      dirty: this.state.dirty,
    };
    this.set({ transactionLabel: label });
  };
  commitTransaction = () => {
    const transaction = this.transaction;
    if (!transaction || !this.state.project) return;
    this.transaction = undefined;
    const changed = !sameContent(transaction.project, this.state.project);
    this.set({
      transactionLabel: null,
      ...(changed
        ? { past: [...this.state.past.slice(-99), transaction.project], future: [], dirty: true }
        : { dirty: transaction.dirty }),
    });
    this.scheduleSave();
  };
  cancelTransaction = () => {
    const transaction = this.transaction;
    if (!transaction || !this.state.project) return;
    this.transaction = undefined;
    const changed = !sameContent(transaction.project, this.state.project);
    this.set({
      transactionLabel: null,
      ...(changed
        ? { project: { ...transaction.project, revision: this.state.project.revision + 1 } }
        : {}),
      selectedId: transaction.selectedId,
      selectedIds: transaction.selectedIds,
      dirty: transaction.dirty,
    });
    this.scheduleSave();
  };
  inspectWindow = () => {
    if (this.state.project && !this.state.closing)
      this.set({ inspector: 'window', selectedId: null, section: 'design' });
  };
  setActiveWindow = (id: string) => {
    if (!this.state.project || this.state.closing) return;
    getProjectWindow(this.state.project, id);
    this.cancelTransaction();
    this.set({ activeWindowId: id, selectedId: null, inspector: 'window', section: 'design' });
    this.scheduleSave();
  };
  addWindow = (name: string): string | undefined => {
    if (!this.state.project || this.state.closing) return;
    if ((this.state.project.windows?.length ?? 0) >= MAX_ADDITIONAL_WINDOWS)
      throw new Error(`最多支持 ${MAX_ADDITIONAL_WINDOWS} 个附加窗口 / Too many windows`);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed))
      throw new Error('窗口名称应为 1–200 个有效字符 / Enter a valid window name');
    const id = uid('window');
    this.update((project) => {
      if (project.schemaVersion !== 3) project.schemaVersion = 2;
      const config: WindowConfig = {
        ...structuredClone(project.window),
        title: trimmed,
        fullscreen: false,
        maximized: false,
        alwaysOnTop: false,
        center: true,
      };
      project.windows = [
        ...(project.windows ?? []),
        { id, name: trimmed, config, widgets: [], openOnStart: false },
      ];
    });
    this.setActiveWindow(id);
    return id;
  };
  renameWindow = (id: string, name: string) => {
    if (!this.state.project || this.state.closing) return;
    if (id === 'main')
      throw new Error(
        '请在窗口属性中设置主窗口标题 / Edit the main window title in window properties',
      );
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed))
      throw new Error('窗口名称应为 1–200 个有效字符 / Enter a valid window name');
    getProjectWindow(this.state.project, id);
    this.update((project) => {
      project.windows!.find((window) => window.id === id)!.name = trimmed;
    });
  };
  updateWindow = (id: string, patch: Partial<WindowConfig>) => {
    if (!this.state.project || this.state.closing) return;
    getProjectWindow(this.state.project, id);
    this.update((project) => {
      Object.assign(getProjectWindow(project, id).config, patch);
    });
  };
  setWindowOpenOnStart = (id: string, openOnStart: boolean) => {
    if (!this.state.project || this.state.closing) return;
    if (id === 'main')
      throw new Error('主窗口始终在启动时打开 / The main window always opens on startup');
    getProjectWindow(this.state.project, id);
    this.update((project) => {
      project.windows!.find((window) => window.id === id)!.openOnStart = openOnStart;
    });
  };
  deleteWindow = (id: string) => {
    const project = this.state.project;
    if (!project || this.state.closing) return;
    if (id === 'main') throw new Error('不能删除主窗口 / The main window cannot be deleted');
    const window = getProjectWindow(project, id);
    if (
      window.widgets.some((widget) =>
        Object.keys(this.state.drafts).some(
          (key) => key === widget.id || key.endsWith(`::${widget.id}`),
        ),
      )
    )
      throw new Error(
        '此窗口有未应用的 CODE 草稿，请先应用或还原草稿 / Resolve this window’s CODE drafts before deleting it',
      );
    const references = project.flows.filter((flow) =>
      flow.nodes.some((node) => node.kind === 'window' && node.config.windowId === id),
    );
    if (references.length)
      throw new Error(
        `请先移除流程中的窗口引用 / Remove window references from flows: ${references.map((flow) => flow.name).join(', ')}`,
      );
    this.update((next) => {
      next.windows = next.windows!.filter((window) => window.id !== id);
    });
    const activeWindowId = validWindowId(this.state.project!, this.state.activeWindowId);
    this.set({
      activeWindowId,
      selectedId: editorSelection(this.state.project!, activeWindowId, this.state.selectedId),
      selectedIds: this.state.selectedIds.filter((id) =>
        editorSelection(this.state.project!, activeWindowId, id),
      ),
      inspector: activeWindowId !== this.state.activeWindowId ? 'window' : this.state.inspector,
    });
  };
  update = (mutator: (project: Project) => void) => {
    if (!this.state.project || this.state.closing) return;
    const next = structuredClone(this.state.project);
    mutator(next);
    if (equalValue(next, this.state.project)) return;
    next.revision = this.state.project.revision + 1;
    const activeWindowId = validWindowId(next, this.state.activeWindowId);
    this.set({
      project: next,
      ...(activeWindowId !== this.state.activeWindowId
        ? { activeWindowId, selectedId: null, inspector: 'window' as const }
        : {}),
      ...(this.transaction
        ? {}
        : { past: [...this.state.past.slice(-99), this.state.project], future: [] }),
      dirty: true,
    });
    this.scheduleSave();
  };
  updateWidget = (id: string, patch: Partial<Widget>) =>
    this.update((project) => {
      const widget = getProjectWindow(project, this.state.activeWindowId).widgets.find(
        (w) => w.id === id,
      );
      if (widget) Object.assign(widget, patch, { id });
    });
  addWidget = (type: Widget['type'], x = 48, y = 48) => {
    if (!this.state.project || this.state.closing) return;
    const widget = createWidget(type, x, y, this.state.project.schemaVersion === 3 ? 2 : 1);
    this.update((p) => {
      getProjectWindow(p, this.state.activeWindowId).widgets.push(widget);
    });
    this.select(widget.id);
  };
  deleteWidget = (id: string) => {
    if (!this.state.project || this.state.closing) return;
    if (
      !getProjectWindow(this.state.project, this.state.activeWindowId).widgets.some(
        (widget) => widget.id === id,
      )
    )
      return;
    const toDelete = new Set([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const w of getProjectWindow(this.state.project, this.state.activeWindowId).widgets)
        if (w.parentId && toDelete.has(w.parentId) && !toDelete.has(w.id)) {
          toDelete.add(w.id);
          changed = true;
        }
    }
    this.update((p) => {
      const widgets = getProjectWindow(p, this.state.activeWindowId).widgets;
      widgets.splice(0, widgets.length, ...widgets.filter((w) => !toDelete.has(w.id)));
    });
    const drafts = { ...this.state.drafts };
    for (const key of toDelete) delete drafts[key];
    this.set({ selectedId: null, drafts });
  };
  duplicateWidget = (id: string) => {
    if (!this.state.project || this.state.closing) return;
    const widgets = getProjectWindow(this.state.project, this.state.activeWindowId).widgets;
    const original = widgets.find((w) => w.id === id);
    if (!original) return;
    const copies = cloneSubtree(widgets, id);
    const copy = copies.find((w) => w.parentId === original.parentId)!;
    this.update((p) => getProjectWindow(p, this.state.activeWindowId).widgets.push(...copies));
    this.select(copy.id);
  };
  getDraft = (id: string, scope?: string): string | undefined => {
    const key = scope ? `${scope}::${id}` : id;
    return Object.hasOwn(this.state.drafts, key) ? this.state.drafts[key] : this.state.drafts[id];
  };
  setDraft = (id: string, text: string | undefined, scope?: string) => {
    if (!this.state.project || this.state.closing) return;
    const drafts = { ...this.state.drafts };
    const key = scope ? `${scope}::${id}` : id;
    if (text === undefined) delete drafts[key];
    else drafts[key] = text;
    if (scope) delete drafts[id];
    this.set({ drafts });
    this.scheduleSave();
  };
  undo = () => {
    if (!this.state.project || this.state.closing) return;
    if (this.transaction) {
      this.cancelTransaction();
      return;
    }
    const previous = this.state.past.at(-1);
    if (!previous) return;
    const activeWindowId = validWindowId(previous, this.state.activeWindowId);
    this.set({
      project: { ...previous, revision: this.state.project.revision + 1 },
      past: this.state.past.slice(0, -1),
      future: [this.state.project, ...this.state.future],
      dirty: true,
      activeWindowId,
      selectedId: editorSelection(previous, activeWindowId, this.state.selectedId),
      selectedIds: this.state.selectedIds.filter((id) =>
        editorSelection(previous, activeWindowId, id),
      ),
    });
    this.scheduleSave();
  };
  redo = () => {
    if (!this.state.project || this.state.closing) return;
    if (this.transaction) this.commitTransaction();
    const next = this.state.future[0];
    if (!next) return;
    const activeWindowId = validWindowId(next, this.state.activeWindowId);
    this.set({
      project: { ...next, revision: this.state.project.revision + 1 },
      past: [...this.state.past, this.state.project],
      future: this.state.future.slice(1),
      dirty: true,
      activeWindowId,
      selectedId: editorSelection(next, activeWindowId, this.state.selectedId),
      selectedIds: this.state.selectedIds.filter((id) => editorSelection(next, activeWindowId, id)),
    });
    this.scheduleSave();
  };
  replaceProject = (project: Project, drafts: Record<string, string> = {}, windowId = 'main') => {
    if (this.state.closing) throw new Error('Wait for the current project to finish closing');
    const validated = validateProject(project);
    this.transaction = undefined;
    const activeWindowId = validWindowId(validated, windowId);
    this.set({
      project: validated,
      transactionLabel: null,
      selectedId: getProjectWindow(validated, activeWindowId).widgets[0]?.id ?? null,
      activeWindowId,
      drafts: { ...drafts },
      past: [],
      future: [],
      dirty: false,
      recoveryError: undefined,
      section: 'design',
      inspector: 'widget',
      sessionId: this.state.sessionId + 1,
    });
    this.saveRecovery();
  };
  /** Persist before stopping the runtime. Failed storage writes leave the editor active. */
  beginClose = (keepRecovery = true) => {
    if (!this.state.project || this.state.closing) return;
    this.commitTransaction();
    const recovery = {
      project: this.state.project,
      drafts: { ...this.state.drafts },
      activeWindowId: this.state.activeWindowId,
    };
    if (keepRecovery) localStorage.setItem(CLOSED_STORAGE_KEY, JSON.stringify(recovery));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ closed: true }));
    clearTimeout(this.timer);
    this.timer = undefined;
    const previous =
      this.state.closedRecovery ??
      (() => {
        try {
          const raw = localStorage.getItem(CLOSED_STORAGE_KEY);
          return raw ? parseRecovery(raw) : undefined;
        } catch {
          return undefined;
        }
      })();
    this.set({ closing: true, closedRecovery: keepRecovery ? recovery : previous });
  };
  finishClose = (closeWarnings: string[] = []) => {
    if (!this.state.closing) throw new Error('Project close was not prepared');
    this.set({
      project: null,
      transactionLabel: null,
      selectedId: null,
      activeWindowId: 'main',
      drafts: {},
      past: [],
      future: [],
      closing: false,
      dirty: false,
      savedAt: null,
      recoveryError: undefined,
      sessionId: this.state.sessionId + 1,
      closeWarnings,
    });
  };
  cancelClose = () => {
    this.set({ closing: false });
    this.saveRecovery();
  };
  restoreClosedProject = () => {
    const recovery = this.state.closedRecovery;
    if (!recovery) return;
    this.replaceProject(recovery.project, recovery.drafts, recovery.activeWindowId);
  };
  saveRecovery = () => {
    if (!this.state.project || this.state.closing || this.state.recoveryError) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          project: this.state.project,
          drafts: this.state.drafts,
          activeWindowId: this.state.activeWindowId,
        }),
      );
      this.set({ dirty: false, savedAt: Date.now() });
    } catch (error) {
      this.set({ recoveryError: `Auto-save failed: ${String(error)}` });
    }
  };
  private scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.saveRecovery, 500);
  }
  dispose() {
    this.transaction = undefined;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
