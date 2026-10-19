import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createEmptyProject, createWidget } from '../src/core/project';
import { exportProject, importProject } from '../src/core/archive';
import { exportComponentPackage, importComponentPackage } from '../src/core/componentPackage';
import { copySelection, preparePaste } from '../src/core/clipboard';
import { EditorStore } from '../src/core/store';
import { validateProject } from '../src/core/validation';
import type { ComponentModule } from '../src/core/types';
import {
  addProjectThemeColor,
  applyProjectThemePreset,
  getProjectThemePalette,
  PROJECT_THEME_PRESETS,
  projectThemeKeys,
  setProjectThemeColor,
} from '../src/core/themePresets';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function component(): ComponentModule {
  const manifest = {
    schemaVersion: 1,
    id: 'test.palette',
    name: 'Palette',
    version: '1.0.0',
    entry: 'index.tsx',
    width: 120,
    height: 80,
    props: {},
    events: [],
  };
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    width: manifest.width,
    height: manifest.height,
    widgets: [],
    exposedProps: {},
    implementation: {
      kind: 'react',
      files: {
        'manifest.json': JSON.stringify(manifest),
        'index.tsx': 'export default function Palette() { return <div />; }',
      },
      bundle: 'export function mount() { return { update() {}, unmount() {} }; }',
      events: [],
    },
  };
}

describe('saved project light and dark colors', () => {
  it.each(['light', 'dark', 'system'] as const)(
    'reads a legacy %s theme without modifying or losing authored colors',
    (mode) => {
      const project = createEmptyProject();
      project.theme.mode = mode;
      project.theme.tokens['color.primary'] = '#123456';
      project.theme.tokens['color.brand'] = '#abcdef';
      const before = structuredClone(project);
      const active = mode === 'light' ? 'light' : 'dark';
      const other = active === 'light' ? 'dark' : 'light';

      expect(getProjectThemePalette(project, active)).toEqual(project.theme.tokens);
      expect(getProjectThemePalette(project, other)['color.primary']).toBe(
        PROJECT_THEME_PRESETS[other]['color.primary'],
      );
      expect(getProjectThemePalette(project, other)['color.brand']).toBe('#abcdef');
      expect(projectThemeKeys(project)).toEqual(Object.keys(project.theme.tokens));
      expect(project).toEqual(before);
      expect(validateProject(project).theme.palettes).toBeUndefined();
    },
  );

  it('keeps sparse legacy keys sparse and returns isolated read snapshots', () => {
    const project = createEmptyProject();
    project.theme.tokens = { 'color.custom': '#123456' };
    const palette = getProjectThemePalette(project, 'light');
    expect(palette).toEqual({ 'color.custom': '#123456' });
    (palette as Record<string, string>)['color.custom'] = '#000000';
    expect(project.theme.tokens['color.custom']).toBe('#123456');
    applyProjectThemePreset(project, 'light');
    expect(Object.keys(project.theme.tokens)).toEqual(['color.custom']);
    expect(validateProject(project).theme).toEqual(project.theme);
  });

  it('edits the inactive palette without altering active tokens or any windows', () => {
    const project = createEmptyProject();
    project.windows = [
      {
        id: 'following',
        name: 'Following',
        config: { ...project.window },
        widgets: [],
        openOnStart: false,
      },
    ];
    const tokens = structuredClone(project.theme.tokens);
    const window = structuredClone(project.window);
    const windows = structuredClone(project.windows);

    setProjectThemeColor(project, 'light', 'color.background', '#dedede');
    expect(project.theme.tokens).toEqual(tokens);
    expect(project.window).toEqual(window);
    expect(project.windows).toEqual(windows);
    expect(project.theme.palettes!.light['color.background']).toBe('#dedede');

    applyProjectThemePreset(project, 'light');
    expect(project.theme.tokens['color.background']).toBe('#dedede');
    expect(project.window.background).toBe('#dedede');
    expect(project.windows[0].config.background).toBe('#dedede');
    applyProjectThemePreset(project, 'dark');
    expect(project.theme.tokens).toEqual(tokens);
    applyProjectThemePreset(project, 'light');
    expect(project.theme.tokens['color.background']).toBe('#dedede');
  });

  it('keeps independent edits in each palette through repeated switching and new colors', () => {
    const project = createEmptyProject();
    setProjectThemeColor(project, 'dark', 'color.primary', '#222222');
    setProjectThemeColor(project, 'light', 'color.primary', '#eeeeee');
    addProjectThemeColor(project, 'color.brand', '#bcdef0', '#123456');
    expect(project.theme.tokens['color.brand']).toBe('#123456');
    expect(() => addProjectThemeColor(project, 'color.brand', '#fff', '#000')).toThrow(
      /already exists/,
    );
    expect(() => setProjectThemeColor(project, 'light', 'color.absent', '#fff')).toThrow(/Unknown/);
    for (let attempt = 0; attempt < 3; attempt++) {
      applyProjectThemePreset(project, 'light');
      expect(project.theme.tokens['color.primary']).toBe('#eeeeee');
      expect(project.theme.tokens['color.brand']).toBe('#bcdef0');
      applyProjectThemePreset(project, 'dark');
      expect(project.theme.tokens['color.primary']).toBe('#222222');
      expect(project.theme.tokens['color.brand']).toBe('#123456');
    }
    const before = structuredClone(project);
    applyProjectThemePreset(project, 'dark');
    expect(project).toEqual(before);
    expect(validateProject(project).theme).toEqual(project.theme);
  });

  it('updates only theme-following window backgrounds for active edits', () => {
    const project = createEmptyProject();
    const old = project.theme.tokens['color.background'];
    project.window.background = ` ${old.toUpperCase()} `;
    project.windows = ['$color.background', '#aabbcc', old].map((background, index) => ({
      id: `window_${index}`,
      name: `Window ${index}`,
      config: { ...project.window, background },
      widgets: [],
      openOnStart: false,
    }));
    const fixed = createWidget('panel');
    fixed.style.background = old;
    project.widgets.push(fixed);
    setProjectThemeColor(project, 'dark', 'color.background', '#101020');
    expect(project.window.background).toBe('#101020');
    expect(project.windows.map((window) => window.config.background)).toEqual([
      '#101020',
      '#aabbcc',
      '#101020',
    ]);
    expect(project.widgets[0].style.background).toBe(old);
  });

  it('saves inactive edits and both values of a new color as separate undoable changes', () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const store = new EditorStore(createEmptyProject());
    const before = structuredClone(store.getSnapshot().project!.theme);
    store.update((project) => setProjectThemeColor(project, 'light', 'color.primary', '#aabbcc'));
    expect(store.getSnapshot().past).toHaveLength(1);
    expect(store.getSnapshot().project!.theme.tokens).toEqual(before.tokens);
    store.update((project) => addProjectThemeColor(project, 'color.brand', '#ffffff', '#000000'));
    expect(store.getSnapshot().past).toHaveLength(2);
    store.undo();
    expect(projectThemeKeys(store.getSnapshot().project!)).not.toContain('color.brand');
    store.undo();
    expect(store.getSnapshot().project!.theme).toEqual(before);
    store.redo();
    store.redo();
    const theme = store.getSnapshot().project!.theme;
    expect(theme.palettes!.light['color.brand']).toBe('#ffffff');
    expect(theme.palettes!.dark['color.brand']).toBe('#000000');
    expect(theme.tokens['color.brand']).toBe('#000000');
    store.dispose();
  });

  it('roundtrips projects, isolated resources, component packages and cross-project copies', () => {
    const source = createEmptyProject();
    addProjectThemeColor(source, 'color.brand', '#abcdef', '#123456');
    setProjectThemeColor(source, 'light', 'color.background', '#dedede');
    const module = component();
    const imported = importComponentPackage(exportComponentPackage(module, source));
    expect(imported.embeddedResourceScope!.theme).toEqual(source.theme);
    const widget = createWidget('module');
    widget.moduleId = imported.id;
    source.modules = [imported];
    source.widgets = [widget];
    source.resourceScopes = [
      { id: 'isolated', theme: structuredClone(source.theme), translations: {}, locale: 'en' },
    ];
    const originalTheme = structuredClone(source.theme);
    applyProjectThemePreset(source, 'light');
    expect(source.resourceScopes[0].theme).toEqual(originalTheme);
    expect(source.modules[0].embeddedResourceScope!.theme).toEqual(originalTheme);
    expect(importProject(exportProject(source))).toEqual(source);

    const target = createEmptyProject();
    const targetTheme = structuredClone(target.theme);
    const scope = { kind: 'window' as const, id: 'main' };
    const pasted = preparePaste(target, copySelection(source, scope, [widget.id]), scope).candidate;
    expect(pasted.theme).toEqual(targetTheme);
    const copy = pasted.modules[0];
    const resources = pasted.resourceScopes!.find((entry) => entry.id === copy.resourceScopeId)!;
    expect(resources.theme).toEqual(originalTheme);
    expect(
      importComponentPackage(exportComponentPackage(copy, pasted)).embeddedResourceScope!.theme,
    ).toEqual(originalTheme);
    expect(validateProject(pasted)).toEqual(pasted);
  });

  it('rejects incomplete, unknown or inconsistent palette data without mutating its input', () => {
    const project = createEmptyProject();
    applyProjectThemePreset(project, 'dark');
    const valid = structuredClone(project);
    project.theme.tokens['color.primary'] = '#badbad';
    const before = structuredClone(project);
    expect(() => validateProject(project)).toThrow(/active saved palette/);
    expect(project).toEqual(before);
    const missing = structuredClone(valid);
    delete missing.theme.palettes!.light['color.primary'];
    expect(() => validateProject(missing)).toThrow(/same token keys/);
    const extra = structuredClone(valid);
    extra.theme.palettes!.dark['color.unknown'] = '#123456';
    expect(() => validateProject(extra)).toThrow(/same token keys/);
    const unknown = structuredClone(valid);
    Object.assign(unknown.theme.palettes!, { unexpected: {} });
    expect(() => validateProject(unknown)).toThrow(/unexpected/);

    const bytes = exportComponentPackage(component(), valid);
    const files = unzipSync(bytes);
    const envelope = JSON.parse(strFromU8(files['module.json']));
    delete envelope.resources.theme.palettes.dark['color.primary'];
    expect(() =>
      importComponentPackage(zipSync({ 'module.json': strToU8(JSON.stringify(envelope)) })),
    ).toThrow(/same token keys/);
  });
});
