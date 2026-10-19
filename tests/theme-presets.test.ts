import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, createProject, createWidget } from '../src/core/project';
import { EditorStore } from '../src/core/store';
import { applyProjectThemePreset, PROJECT_THEME_PRESETS } from '../src/core/themePresets';
import { validateProject } from '../src/core/validation';
import { createSerialAssistantProject } from '../src/examples/serialAssistant';
import { resolveStyle, scopedProject } from '../src/runtime/WidgetRenderer';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('project UI theme presets', () => {
  it.each([createProject, createSerialAssistantProject])(
    'changes token-based demo controls and matching main/window backgrounds together',
    (factory) => {
      const project = factory();
      project.windows = [
        {
          id: 'following',
          name: 'Following theme',
          config: { ...project.window, background: project.window.background.toUpperCase() },
          widgets: [createWidget('panel')],
          openOnStart: false,
        },
        {
          id: 'custom',
          name: 'Custom background',
          config: { ...project.window, background: '#efe0d0' },
          widgets: [],
          openOnStart: false,
        },
      ];
      const beforeWidgets = structuredClone(project.widgets);

      applyProjectThemePreset(project, 'light');

      expect(project.theme.mode).toBe('light');
      expect(project.theme.tokens).toMatchObject(PROJECT_THEME_PRESETS.light);
      expect(project.window.background).toBe('#f4f5f8');
      expect(project.windows[0].config.background).toBe('#f4f5f8');
      expect(project.windows[1].config.background).toBe('#efe0d0');
      expect(project.widgets).toEqual(beforeWidgets);
      expect(
        resolveStyle(project.widgets.find((widget) => widget.type === 'panel')!.style, project)
          .background,
      ).toBe('#ffffff');
      expect(resolveStyle(project.windows[0].widgets[0].style, project).background).toBe('#ffffff');
      expect(validateProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    },
  );

  it('preserves custom token keys, literal colors, component implementations and isolated resources', () => {
    const project = createEmptyProject();
    project.theme.tokens['color.brand'] = '#f4511e';
    project.window.background = '#101f30';
    const custom = createWidget('button');
    custom.style.color = '#ffffff';
    custom.style.background = '#123456';
    custom.states.hover = { background: '#654321' };
    project.widgets.push(custom);
    const beforeWidget = structuredClone(custom);
    const resources = {
      id: 'isolated',
      theme: structuredClone(project.theme),
      translations: {},
      locale: project.locale,
    };
    const beforeResources = structuredClone(resources);
    project.resourceScopes = [resources];
    project.modules = [
      {
        id: 'shared-module',
        name: 'Shared theme',
        version: '1.0.0',
        width: 300,
        height: 180,
        widgets: [createWidget('panel')],
        exposedProps: {},
      },
      {
        id: 'isolated-module',
        name: 'Isolated theme',
        version: '1.0.0',
        width: 300,
        height: 180,
        widgets: [createWidget('panel')],
        exposedProps: {},
        embeddedResourceScope: structuredClone(resources),
        implementation: {
          kind: 'react',
          files: { 'index.tsx': 'export default () => <div style={{color:"#edf0f7"}} />' },
          bundle: 'opaque compiled source #17191f',
          events: [],
        },
      },
    ];
    const beforeModules = structuredClone(project.modules);

    applyProjectThemePreset(project, 'light');

    expect(project.theme.tokens['color.brand']).toBe('#f4511e');
    expect(project.window.background).toBe('#101f30');
    expect(project.widgets[0]).toEqual(beforeWidget);
    expect(project.modules).toEqual(beforeModules);
    expect(project.resourceScopes[0]).toEqual(beforeResources);
    expect(resolveStyle(project.modules[0].widgets[0].style, project).background).toBe('#ffffff');
    expect(
      resolveStyle(project.modules[1].widgets[0].style, scopedProject(project, 'isolated'))
        .background,
    ).toBe(PROJECT_THEME_PRESETS.dark['color.surface']);
  });

  it('is idempotent and roundtrips the built-in palette without changing project version', () => {
    const project = createProject();
    project.schemaVersion = 3;
    const original = structuredClone(project);
    applyProjectThemePreset(project, 'light');
    const light = structuredClone(project);
    applyProjectThemePreset(project, 'light');
    expect(project).toEqual(light);
    applyProjectThemePreset(project, 'dark');
    expect(project).toEqual(original);
  });

  it('records the complete theme preset as one change and restores it with one undo', () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const project = createProject();
    const store = new EditorStore(project);
    const original = structuredClone(store.getSnapshot().project!);
    store.update((draft) => applyProjectThemePreset(draft, 'light'));
    expect(store.getSnapshot().past).toHaveLength(1);
    store.update((draft) => applyProjectThemePreset(draft, 'light'));
    expect(store.getSnapshot().past).toHaveLength(1);
    store.undo();
    expect(store.getSnapshot().project).toEqual({
      ...original,
      revision: store.getSnapshot().project!.revision,
    });
    store.redo();
    expect(store.getSnapshot().project!.theme.mode).toBe('light');
    expect(store.getSnapshot().project!.window.background).toBe('#f4f5f8');
    store.dispose();
  });
});
