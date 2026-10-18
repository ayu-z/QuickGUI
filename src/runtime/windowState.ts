import type { Project, RuntimeWindowState, WindowAction } from '../core/types';
import { listProjectWindows } from '../core/windows';

export function validateWindowActions(project: Project): void {
  for (const flow of project.flows) {
    for (const node of flow.nodes.filter((node) => node.kind === 'window')) {
      if (project.schemaVersion !== 2) throw new Error('Window actions require schemaVersion 2');
      if (typeof node.config.action !== 'string' || typeof node.config.windowId !== 'string') {
        throw new Error('Window action and target must be strings');
      }
      applyWindowAction(
        project,
        initialWindowState(project),
        node.config.action as WindowAction,
        node.config.windowId,
      );
    }
  }
}

export function initialWindowState(project: Project): RuntimeWindowState {
  return {
    open: listProjectWindows(project)
      .filter((window) => window.openOnStart)
      .map((window) => window.id),
    focused: 'main',
    revision: 0,
  };
}

export function reconcileWindowState(
  previous: Project,
  project: Project,
  state: RuntimeWindowState,
): RuntimeWindowState {
  const previousIds = new Set(listProjectWindows(previous).map((window) => window.id));
  const windows = listProjectWindows(project);
  const ids = new Set(windows.map((window) => window.id));
  const open = state.open.filter((id) => ids.has(id));
  for (const window of windows) {
    if (!previousIds.has(window.id) && window.openOnStart) open.push(window.id);
  }
  const focused = open.includes(state.focused) ? state.focused : 'main';
  return {
    open,
    focused,
    revision:
      state.revision +
      (focused !== state.focused || JSON.stringify(open) !== JSON.stringify(state.open) ? 1 : 0),
  };
}

export function applyWindowAction(
  project: Project,
  state: RuntimeWindowState,
  action: WindowAction,
  windowId: string,
): RuntimeWindowState {
  if (!['open', 'close', 'focus'].includes(action))
    throw new Error(`Unknown window action: ${action}`);
  if (!listProjectWindows(project).some((window) => window.id === windowId))
    throw new Error(`Unknown window: ${windowId}`);
  if (action === 'close' && windowId === 'main')
    throw new Error('The main window cannot be closed by a window action');
  const open =
    action === 'close'
      ? state.open.filter((id) => id !== windowId)
      : state.open.includes(windowId)
        ? [...state.open]
        : [...state.open, windowId];
  return {
    open,
    focused: action === 'close' ? (state.focused === windowId ? 'main' : state.focused) : windowId,
    revision: state.revision + 1,
  };
}
