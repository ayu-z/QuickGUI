import type { Project, Widget } from './types';
import { cloneSubtree, createProject, createWidget } from './project';
import { validateProject } from './validation';

export type Section = 'design' | 'flows' | 'scripts' | 'data' | 'connections';
export interface ProjectRecovery {
  project: Project;
  drafts: Record<string, string>;
}
export interface EditorState {
  project: Project | null;
  selectedId: string | null;
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
  return { project, drafts };
}
export function loadRecovery(): Pick<
  EditorState,
  'project' | 'drafts' | 'closedRecovery' | 'recoveryError'
> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && JSON.parse(raw).closed === true) {
      const closed = localStorage.getItem(CLOSED_STORAGE_KEY);
      return {
        project: null,
        drafts: {},
        closedRecovery: closed ? parseRecovery(closed) : undefined,
      };
    }
    if (raw) return parseRecovery(raw);
  } catch (error) {
    return {
      project: null,
      drafts: {},
      recoveryError: `Recovery was not applied: ${String(error)}. The original recovery data has been preserved.`,
    };
  }
  return { project: createProject(), drafts: {} };
}

export class EditorStore {
  private listeners = new Set<() => void>();
  private state: EditorState;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(project?: Project) {
    const recovered = project ? { project, drafts: {} } : loadRecovery();
    this.state = {
      ...recovered,
      selectedId:
        recovered.project?.widgets.find((widget) => widget.id === 'start_button')?.id ??
        recovered.project?.widgets[0]?.id ??
        null,
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
    this.state = { ...this.state, ...patch };
    this.emit();
  }
  setSection = (section: Section) => {
    if (this.state.project && !this.state.closing) this.set({ section });
  };
  select = (selectedId: string | null) => {
    if (this.state.project && !this.state.closing) this.set({ selectedId, inspector: 'widget' });
  };
  inspectWindow = () => {
    if (this.state.project && !this.state.closing)
      this.set({ inspector: 'window', selectedId: null, section: 'design' });
  };
  update = (mutator: (project: Project) => void) => {
    if (!this.state.project || this.state.closing) return;
    const next = structuredClone(this.state.project);
    mutator(next);
    next.revision = this.state.project.revision + 1;
    this.set({
      project: next,
      past: [...this.state.past.slice(-99), this.state.project],
      future: [],
      dirty: true,
    });
    this.scheduleSave();
  };
  updateWidget = (id: string, patch: Partial<Widget>) =>
    this.update((project) => {
      const widget = project.widgets.find((w) => w.id === id);
      if (widget) Object.assign(widget, patch, { id });
    });
  addWidget = (type: Widget['type'], x = 48, y = 48) => {
    if (!this.state.project || this.state.closing) return;
    const widget = createWidget(type, x, y);
    this.update((p) => {
      p.widgets.push(widget);
    });
    this.select(widget.id);
  };
  deleteWidget = (id: string) => {
    if (!this.state.project || this.state.closing) return;
    const toDelete = new Set([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const w of this.state.project.widgets)
        if (w.parentId && toDelete.has(w.parentId) && !toDelete.has(w.id)) {
          toDelete.add(w.id);
          changed = true;
        }
    }
    this.update((p) => {
      p.widgets = p.widgets.filter((w) => !toDelete.has(w.id));
    });
    const drafts = { ...this.state.drafts };
    for (const key of toDelete) delete drafts[key];
    this.set({ selectedId: null, drafts });
  };
  duplicateWidget = (id: string) => {
    if (!this.state.project || this.state.closing) return;
    const original = this.state.project.widgets.find((w) => w.id === id);
    if (!original) return;
    const copies = cloneSubtree(this.state.project.widgets, id);
    const copy = copies.find((w) => w.parentId === original.parentId)!;
    this.update((p) => p.widgets.push(...copies));
    this.select(copy.id);
  };
  setDraft = (id: string, text: string | undefined) => {
    if (!this.state.project || this.state.closing) return;
    const drafts = { ...this.state.drafts };
    if (text === undefined) delete drafts[id];
    else drafts[id] = text;
    this.set({ drafts });
    this.scheduleSave();
  };
  undo = () => {
    if (!this.state.project || this.state.closing) return;
    const previous = this.state.past.at(-1);
    if (!previous) return;
    this.set({
      project: { ...previous, revision: this.state.project.revision + 1 },
      past: this.state.past.slice(0, -1),
      future: [this.state.project, ...this.state.future],
      dirty: true,
    });
    this.scheduleSave();
  };
  redo = () => {
    if (!this.state.project || this.state.closing) return;
    const next = this.state.future[0];
    if (!next) return;
    this.set({
      project: { ...next, revision: this.state.project.revision + 1 },
      past: [...this.state.past, this.state.project],
      future: this.state.future.slice(1),
      dirty: true,
    });
    this.scheduleSave();
  };
  replaceProject = (project: Project, drafts: Record<string, string> = {}) => {
    if (this.state.closing) throw new Error('Wait for the current project to finish closing');
    const validated = validateProject(project);
    this.set({
      project: validated,
      selectedId: validated.widgets[0]?.id ?? null,
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
    const recovery = { project: this.state.project, drafts: { ...this.state.drafts } };
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
      selectedId: null,
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
    this.replaceProject(recovery.project, recovery.drafts);
  };
  saveRecovery = () => {
    if (!this.state.project || this.state.closing || this.state.recoveryError) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ project: this.state.project, drafts: this.state.drafts }),
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
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
