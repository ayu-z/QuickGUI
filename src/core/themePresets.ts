import { z } from 'zod';
import type { Project, ThemeDefinition } from './types';

export type ProjectThemePreset = 'light' | 'dark';

/** Keep source colors and runtime tokens unambiguous, including in resource packages. */
export const themeSchema = z
  .object({
    mode: z.enum(['light', 'dark', 'system']),
    tokens: z.record(z.string()),
    palettes: z
      .object({ light: z.record(z.string()), dark: z.record(z.string()) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((theme, context) => {
    if (!theme.palettes) return;
    const keys = Object.keys(theme.tokens);
    for (const mode of ['light', 'dark'] as const) {
      const palette = theme.palettes[mode];
      if (
        keys.length !== Object.keys(palette).length ||
        keys.some((key) => !Object.hasOwn(palette, key))
      )
        context.addIssue({
          code: 'custom',
          message: 'Both theme palettes must contain the same token keys as effective tokens',
          path: ['palettes', mode],
        });
    }
    const active = theme.palettes[theme.mode === 'light' ? 'light' : 'dark'];
    for (const key of keys)
      if (active[key] !== theme.tokens[key])
        context.addIssue({
          code: 'custom',
          message: 'Effective theme tokens must equal the active saved palette',
          path: ['tokens', key],
        });
  });

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

const activePalette = (theme: ThemeDefinition): ProjectThemePreset =>
  theme.mode === 'light' ? 'light' : 'dark';

/** Reads never materialize palettes or dirty a legacy project. */
export function projectThemeKeys(project: Project): string[] {
  return [
    ...new Set([
      ...Object.keys(project.theme.tokens),
      ...Object.keys(project.theme.palettes?.light ?? {}),
      ...Object.keys(project.theme.palettes?.dark ?? {}),
    ]),
  ];
}

export function getProjectThemePalette(
  project: Project,
  mode: ProjectThemePreset,
): Readonly<Record<string, string>> {
  const { theme } = project;
  // Use only existing keys: missing legacy tokens remain missing until explicitly added.
  // A new default theme already supplies all built-in token keys.
  return Object.fromEntries(
    projectThemeKeys(project).map((key) => [
      key,
      theme.palettes?.[mode][key] ??
        (mode === activePalette(theme)
          ? theme.tokens[key]
          : (PROJECT_THEME_PRESETS[mode][key] ?? theme.tokens[key])) ??
        theme.palettes?.light[key] ??
        theme.palettes?.dark[key] ??
        '',
    ]),
  );
}

function savedPalettes(project: Project): NonNullable<ThemeDefinition['palettes']> {
  if (!project.theme.palettes)
    project.theme.palettes = {
      light: { ...getProjectThemePalette(project, 'light') },
      dark: { ...getProjectThemePalette(project, 'dark') },
    };
  return project.theme.palettes;
}

function updateEffectiveTokens(project: Project, tokens: Readonly<Record<string, string>>): void {
  const previousBackground = project.theme.tokens['color.background'];
  const background = tokens['color.background'];
  for (const window of [project.window, ...(project.windows ?? []).map((entry) => entry.config)])
    if (
      background !== undefined &&
      (window.background === '$color.background' ||
        sameColor(window.background, previousBackground))
    )
      window.background = background;
  project.theme.tokens = { ...tokens };
}

/** Select saved colors inside one editor change so switching is one undoable edit. */
export function applyProjectThemePreset(project: Project, mode: ProjectThemePreset): void {
  const palettes = savedPalettes(project);
  updateEffectiveTokens(project, palettes[mode]);
  project.theme.mode = mode;
  // Scoped resources and literal widget colors belong to their component author.
}

/** Updating an inactive column saves its colors without changing the rendered UI. */
export function setProjectThemeColor(
  project: Project,
  mode: ProjectThemePreset,
  key: string,
  value: string,
): void {
  if (!projectThemeKeys(project).includes(key)) throw new Error(`Unknown theme token: ${key}`);
  const palettes = savedPalettes(project);
  palettes[mode][key] = value;
  if (mode === activePalette(project.theme)) updateEffectiveTokens(project, palettes[mode]);
}

/** Adds both variants atomically; active runtime tokens always retain the same keys. */
export function addProjectThemeColor(
  project: Project,
  key: string,
  light: string,
  dark: string,
): void {
  if (!key || ['__proto__', 'constructor', 'prototype'].includes(key))
    throw new Error('Invalid theme token key');
  if (projectThemeKeys(project).includes(key))
    throw new Error(`Theme token already exists: ${key}`);
  const palettes = savedPalettes(project);
  palettes.light[key] = light;
  palettes.dark[key] = dark;
  updateEffectiveTokens(project, palettes[activePalette(project.theme)]);
}
