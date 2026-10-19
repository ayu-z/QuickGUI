import type { Project, ProjectWindow } from './types';

export const MAIN_WINDOW_ID = 'main';
export const MAX_ADDITIONAL_WINDOWS = 31;
export const WINDOW_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Returns canonical scene references from the current project model. */
export function listProjectWindows(project: Project): ProjectWindow[] {
  if (!Array.isArray(project.windows))
    throw new Error(`schemaVersion ${project.schemaVersion} requires a windows array`);
  return [
    {
      id: MAIN_WINDOW_ID,
      name: project.window.title,
      config: project.window,
      widgets: project.widgets,
      openOnStart: true,
    },
    ...(project.windows ?? []),
  ];
}

export function getProjectWindow(project: Project, id = MAIN_WINDOW_ID): ProjectWindow {
  const window = listProjectWindows(project).find((window) => window.id === id);
  if (!window) throw new Error(`Unknown project window: ${id}`);
  return window;
}

/**
 * Rendering projection for Scene/WidgetRenderer only. Keep the complete canonical
 * project for the engine, history, saving and exports; never apply this view as a project.
 */
export function projectForWindow(project: Project, id = MAIN_WINDOW_ID): Project {
  const window = getProjectWindow(project, id);
  if (id === MAIN_WINDOW_ID) return project;
  return { ...project, window: window.config, widgets: window.widgets };
}
