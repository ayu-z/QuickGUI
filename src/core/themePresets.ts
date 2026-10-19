import type { Project } from './types';

export type ProjectThemePreset = 'light' | 'dark';

export const PROJECT_THEME_PRESETS: Readonly<
  Record<ProjectThemePreset, Readonly<Record<string, string>>>
> = {
  dark: {
    'color.primary': '#8b5cf6',
    'color.primaryHover': '#a78bfa',
    'color.text': '#edf0f7',
    'color.muted': '#969eaf',
    'color.surface': '#20232c',
    'color.background': '#17191f',
    'color.border': '#333743',
    'color.success': '#48d5a0',
    'color.warning': '#e9b66c',
  },
  light: {
    'color.primary': '#7c3aed',
    'color.primaryHover': '#6d28d9',
    'color.text': '#202333',
    'color.muted': '#667085',
    'color.surface': '#ffffff',
    'color.background': '#f4f5f8',
    'color.border': '#d6dae3',
    'color.success': '#087f5b',
    'color.warning': '#986100',
  },
};

const sameColor = (left: string, right: string | undefined) =>
  right !== undefined && left.trim().toLowerCase() === right.trim().toLowerCase();

/** Apply inside one editor change so a preset is one undoable project edit. */
export function applyProjectThemePreset(project: Project, mode: ProjectThemePreset): void {
  const previousBackground = project.theme.tokens['color.background'];
  const tokens = PROJECT_THEME_PRESETS[mode];
  for (const window of [project.window, ...(project.windows ?? []).map((entry) => entry.config)])
    if (
      window.background === '$color.background' ||
      sameColor(window.background, previousBackground)
    )
      window.background = tokens['color.background'];
  project.theme.mode = mode;
  // Scoped resources and literal widget colors belong to their component author.
  Object.assign(project.theme.tokens, tokens);
}
