import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copySelection,
  preparePaste,
  applyPastePlan,
  writeClipboard,
  readClipboard,
  getClipboardStorage,
} from '../src/core/clipboard';
import { createProject, createWidget } from '../src/core/project';
import { upgradeProject } from '../src/core/migration';
import { exportComponentPackage, importComponentPackage } from '../src/core/componentPackage';
import { validateProject } from '../src/core/validation';
import type { ComponentModule, Flow, FlowNode, Project, Widget } from '../src/core/types';
import type { PropertyDefinition } from '../src/core/widgetDefinitions';

vi.mock('../src/native/bridge', () => ({
  isDesktop: () => false,
  readClipboardText: vi.fn(),
  writeClipboardText: vi.fn(),
}));
const main = { kind: 'window' as const, id: 'main' };
function project(id = 'source'): Project {
  const p = upgradeProject(createProject());
  p.id = id;
  p.widgets = [];
  p.windows = [];
  p.variables = [];
  p.flows = [];
  p.scripts = [];
  p.modules = [];
  p.assets = [];
  p.connections = [];
  p.resourceScopes = [];
  return p;
}
function widget(type: Widget['type'], id: string, parentId?: string): Widget {
  return { ...createWidget(type, 10, 20, 1), id, name: id, ...(parentId ? { parentId } : {}) };
}
function flow(
  id: string,
  nodes: Array<{ kind: FlowNode['kind']; config: FlowNode['config'] }>,
): Flow {
  const all = [{ kind: 'event' as const, config: {} }, ...nodes].map((node, i) => ({
    ...node,
    id: `${id}_n${i}`,
    label: node.kind,
    position: { x: i * 100, y: 0 },
  }));
  return {
    id,
    name: id,
    enabled: true,
    nodes: all,
    edges: all
      .slice(1)
      .map((node, i) => ({ id: `${id}_e${i}`, source: all[i].id, target: node.id })),
  };
}
const asset = (id: string) => ({
  id,
  name: id,
  mime: 'image/png',
  data: 'data:image/png;base64,aGVsbG8=',
});
const number = (id: string, name = id) => ({ id, name, type: 'number' as const, initial: 1 });
function reactModule(): ComponentModule {
  const definition: PropertyDefinition = {
    key: 'picture',
    label: { zh: '图片', en: 'Picture' },
    group: 'content',
    type: 'string',
    editor: 'asset',
    initialValue: 'logo',
    fallbackValue: 'logo',
    reference: 'asset',
  };
  const manifest = {
    schemaVersion: 2,
    id: 'react.card',
    name: 'React card',
    version: '1.0.0',
    entry: 'src/card.tsx',
    width: 100,
    height: 80,
    props: { picture: 'logo' },
    propertyDefinitions: { picture: definition },
    events: ['click'],
  };
  return {
    id: manifest.id,
    name: manifest.name,
    version: '1.0.0',
    width: 100,
    height: 80,
    widgets: [],
    exposedProps: { picture: { widgetId: '$component', property: 'picture', default: 'logo' } },
    propertyDefinitions: { picture: definition },
    implementation: {
      kind: 'react',
      files: {
        'manifest.json': JSON.stringify(manifest),
        'src/card.tsx': 'export default function Card(){return null;}',
      },
      bundle: 'export function mount(){return {update(){},unmount(){}}}',
      events: ['click'],
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('dependency-aware project clipboard', () => {
  it('copies selected subtrees once, keeps relative positions, locks and hidden flags', () => {
    const source = project(),
      panel = widget('panel', 'panel'),
      child = widget('text', 'child', 'panel'),
      other = widget('text', 'unrelated');
    panel.layout.x = 100;
    panel.layout.y = 200;
    child.editor = { locked: true, hidden: true };
    source.widgets = [panel, child, other];
    const before = structuredClone(source),
      bundle = copySelection(source, main, ['panel', 'child'], 'session');
    expect(bundle.rootIds).toEqual(['panel']);
    expect(bundle.widgets.map((w) => w.id)).toEqual(['panel', 'child']);
    const target = project('target'),
      plan = preparePaste(target, bundle, main, { x: 20, y: 30 }),
      result = applyPastePlan(target, plan);
    const root = result.widgets.find((w) => w.id === plan.rootIds[0])!,
      nested = result.widgets.find((w) => w.parentId === root.id)!;
    expect(root.layout).toMatchObject({ x: 20, y: 30 });
    expect(nested.layout).toEqual(child.layout);
    expect(nested.editor).toEqual(child.editor);
    expect(source).toEqual(before);
    expect(target.widgets).toHaveLength(0);
    const detached = copySelection(source, main, ['child']);
    expect(detached.widgets[0].parentId).toBeUndefined();
    expect(detached.widgets[0].layout).toMatchObject({ x: 110, y: 220 });
  });
  it('imports only reachable dependencies, supplies automatic flows, and redacts credentials before writing', async () => {
    const source = project(),
      button = widget('button', 'button'),
      unused = widget('text', 'unused');
    button.events.onClick = 'click';
    button.bindings.text = { variable: 'label', mode: 'oneWay' };
    button.props.iconAssetId = 'icon';
    source.widgets = [button, unused];
    source.variables = [
      { id: 'label', name: 'label', type: 'string', initial: 'Ready' },
      number('n'),
      number('ignored'),
    ];
    source.assets = [asset('icon'), asset('unused')];
    source.connections = [
      {
        id: 'connection',
        name: 'Connection',
        protocol: 'http',
        config: {
          url: 'https://user:pass@example.com/data?token=private&ok=1',
          password: 'hidden',
          headers: { Authorization: 'secret', Accept: 'application/json' },
          nested: [{ apiKey: 'key', normal: true }],
        },
      },
    ];
    source.flows = [
      flow('click', [
        { kind: 'connection', config: { connectionId: 'connection' } },
        { kind: 'read', config: { variable: 'n' } },
      ]),
      flow('auto', [{ kind: 'write', config: { variable: 'n', value: 2 } }]),
      flow('unrelated', [{ kind: 'write', config: { variable: 'ignored', value: 3 } }]),
    ];
    source.flows[1].nodes[0].config = { trigger: 'startup' };
    source.flows[2].nodes[0].config = { trigger: 'interval', intervalMs: 1000 };
    const bundle = copySelection(source, main, ['button']);
    expect(bundle.variables.map((v) => v.id).sort()).toEqual(['label', 'n']);
    expect(bundle.flows.map((f) => f.id)).toEqual(['click', 'auto']);
    expect(bundle.assets.map((a) => a.id)).toEqual(['icon']);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('"password"');
    expect(bundle.connections[0].config).toMatchObject({
      headers: { Accept: 'application/json' },
      nested: [{ normal: true }],
    });
    const plan = preparePaste(project('target'), bundle, main);
    expect(plan.candidate.flows.every((f) => !f.enabled)).toBe(true);
    expect(plan.warnings.some((w) => w.includes('credential'))).toBe(true);
    expect(source.connections[0].config.password).toBe('hidden');
  });
  it('creates closed C alias maps without rewriting source, including ID/name collisions and existing scopes', () => {
    const source = project(),
      button = widget('button', 'button');
    button.events.click = 'run';
    source.widgets = [button];
    source.variables = [
      number('a', 'b'),
      number('b', 'other'),
      { id: 'json', name: 'json', type: 'json', initial: 9 },
      { id: 'text', name: 'text', type: 'string', initial: 'x' },
    ];
    const code = 'void qg_process(void){qg_set_number("b",qg_get_number("a"));/* b */}';
    source.scripts = [{ id: 's', name: 'Script', source: code, timeoutMs: 5000 }];
    source.flows = [flow('run', [{ kind: 'script', config: { scriptId: 's' } }])];
    const bundle = copySelection(source, main, ['button']);
    expect(bundle.variables.map((v) => v.id)).toEqual(['a', 'b']);
    const plan = preparePaste(project('target'), bundle, main),
      script = plan.candidate.scripts[0];
    expect(script.source).toBe(code);
    expect(script.variableAliases).toEqual({
      a: plan.mappings.variables.a,
      b: plan.mappings.variables.b,
      other: plan.mappings.variables.b,
    });
    expect(plan.codeTrustRequired).toBe(true);
    source.scripts[0].variableAliases = { left: 'a', right: 'a' };
    const aliased = preparePaste(project('next'), copySelection(source, main, ['button']), main);
    expect(aliased.candidate.scripts[0].variableAliases).toEqual({
      left: aliased.mappings.variables.a,
      right: aliased.mappings.variables.a,
    });
    source.scripts[0].variableAliases = {};
    expect(copySelection(source, main, ['button']).variables).toEqual([]);
  });
  it('does not reuse equal IDs/content across document sessions; supports explicit compatible reuse', () => {
    const source = project('same'),
      button = widget('text', 'text');
    button.bindings.text = { variable: 'v', mode: 'oneWay' };
    source.widgets = [button];
    source.variables = [{ id: 'v', name: 'v', type: 'string', initial: 'Hello' }];
    const bundle = copySelection(source, main, ['text'], 'first'),
      target = structuredClone(source);
    const cross = preparePaste(target, bundle, main);
    expect(cross.mappings.variables.v).not.toBe('v');
    expect(cross.candidate.variables).toHaveLength(2);
    const same = preparePaste(target, bundle, main, undefined, {
      sameDocument: true,
      sessionKey: 'first',
    });
    expect(same.mappings.variables.v).toBe('v');
    expect(same.candidate.variables).toHaveLength(1);
    expect(() =>
      preparePaste(target, bundle, main, undefined, { sameDocument: true, sessionKey: 'another' }),
    ).toThrow(/session/);
    const reused = preparePaste(target, bundle, main, undefined, {
      reuse: { variables: { v: 'v' } },
    });
    expect(reused.candidate.variables).toHaveLength(1);
    const incompatible = project('bad');
    incompatible.variables = [number('n')];
    expect(() =>
      preparePaste(incompatible, bundle, main, undefined, { reuse: { variables: { v: 'n' } } }),
    ).toThrow(/type/);
  });
  it('copies referenced windows once, disables auto-open, and blocks remapping close onto main', () => {
    const source = project(),
      button = widget('button', 'button');
    button.events.click = 'open';
    source.widgets = [button];
    source.windows = [
      {
        id: 'details',
        name: 'Details',
        config: structuredClone(source.window),
        widgets: [widget('text', 'detailText')],
        openOnStart: true,
      },
    ];
    source.flows = [
      flow('open', [{ kind: 'window', config: { action: 'open', windowId: 'details' } }]),
    ];
    const bundle = copySelection(source, main, ['button']),
      plan = preparePaste(project('target'), bundle, main);
    expect(bundle.windows).toHaveLength(1);
    expect(plan.candidate.windows![0].openOnStart).toBe(false);
    expect(plan.candidate.flows[0].nodes[1].config.windowId).toBe(plan.candidate.windows![0].id);
    source.windows[0].widgets = [button];
    source.widgets = [];
    source.flows[0].nodes[1].config = { action: 'close', windowId: 'details' };
    const closing = copySelection(source, { kind: 'window', id: 'details' }, ['button']);
    expect(() => preparePaste(project('target'), closing, main)).toThrow(/close.*main/);
    const target = project('module-target');
    target.modules = [
      {
        id: 'm',
        name: 'M',
        version: '1.0.0',
        width: 100,
        height: 100,
        widgets: [],
        exposedProps: {},
      },
    ];
    expect(() => preparePaste(target, bundle, { kind: 'module', id: 'm' })).toThrow(
      /currentWindowId/,
    );
  });
  it('maps nested module local IDs, exposed widget references, assets and chart history IDs', () => {
    const source = project(),
      image = widget('image', 'localImage');
    image.props.assetId = 'logo';
    source.assets = [asset('logo')];
    source.variables = [number('value')];
    const chart = widget('chart', 'chart');
    chart.props.series = [
      { id: 'series', name: 'One', color: '#fff', value: 0, visible: true, variableId: 'value' },
    ];
    chart.bindings['/series/0/value'] = { variable: 'value', mode: 'oneWay' };
    source.modules = [
      {
        id: 'inner',
        name: 'Inner',
        version: '1.0.0',
        width: 100,
        height: 100,
        widgets: [image],
        exposedProps: { picture: { widgetId: 'localImage', property: 'assetId', default: 'logo' } },
      },
    ];
    const instance = widget('module', 'instance');
    instance.moduleId = 'inner';
    source.widgets = [instance, chart];
    const plan = preparePaste(
        project('target'),
        copySelection(source, main, ['instance', 'chart']),
        main,
      ),
      module = plan.candidate.modules[0];
    expect(module.exposedProps.picture.widgetId).toBe(module.widgets[0].id);
    expect(module.exposedProps.picture.default).toBe(plan.mappings.assets.logo);
    expect(module.widgets[0].props.assetId).toBe(plan.mappings.assets.logo);
    const nextChart = plan.candidate.widgets.find((w) => w.type === 'chart')!;
    expect((nextChart.props.series as Array<{ variableId: string }>)[0].variableId).toBe(
      plan.mappings.variables.value,
    );
    expect(nextChart.bindings['/series/0/value'].variable).toBe(plan.mappings.variables.value);
  });
  it('preserves React source, manifest defaults and package identity while mapping scoped assets', () => {
    const source = project(),
      module = reactModule(),
      instance = widget('module', 'instance');
    instance.moduleId = module.id;
    source.modules = [module];
    source.assets = [asset('logo')];
    source.widgets = [instance];
    source.translations = { en: { hello: 'Hello' }, 'zh-CN': { hello: '你好' } };
    const plan = preparePaste(project('target'), copySelection(source, main, ['instance']), main),
      copy = plan.candidate.modules[0],
      scope = plan.candidate.resourceScopes!.find((scope) => scope.id === copy.resourceScopeId)!;
    expect(copy.implementation).toEqual(module.implementation);
    expect(copy.exposedProps).toEqual(module.exposedProps);
    expect(copy.propertyDefinitions).toEqual(module.propertyDefinitions);
    expect(copy.packageIdentity).toMatchObject({ id: module.id, name: module.name });
    expect(scope.assetAliases!.logo).toBe(plan.mappings.assets.logo);
    expect(scope.translations).toEqual(source.translations);
    const exported = importComponentPackage(exportComponentPackage(copy, plan.candidate));
    expect(exported.implementation).toEqual(module.implementation);
    expect(exported.exposedProps).toEqual(module.exposedProps);
    const again = preparePaste(
      project('third'),
      copySelection(plan.candidate, main, plan.rootIds),
      main,
    );
    expect(again.candidate.modules[0].implementation).toEqual(module.implementation);
    validateProject(again.candidate);
  });
  it('imports package-local assets through scoped aliases without altering source bytes', () => {
    const source = project(),
      module = reactModule(),
      instance = widget('module', 'instance');
    instance.moduleId = module.id;
    module.embeddedResourceScope = {
      id: 'embedded',
      theme: source.theme,
      translations: {},
      locale: 'en',
      assets: [asset('logo')],
    };
    source.modules = [module];
    source.widgets = [instance];
    const bundle = copySelection(source, main, ['instance']);
    expect(bundle.assets).toHaveLength(1);
    expect(source.assets).toHaveLength(0);
    expect(source.modules[0].embeddedResourceScope!.assets).toHaveLength(1);
    const plan = preparePaste(project('target'), bundle, main),
      copy = plan.candidate.modules[0],
      resources = plan.candidate.resourceScopes!.find((s) => s.id === copy.resourceScopeId)!;
    expect(plan.candidate.assets.some((a) => a.id === resources.assetAliases!.logo)).toBe(true);
    expect(copy.implementation).toEqual(module.implementation);
  });
  it('preserves embedded asset precedence over colliding aliases and duplicate embedded IDs', () => {
    const source = project(),
      module = reactModule(),
      instance = widget('module', 'instance');
    instance.moduleId = module.id;
    const embedded = {
      ...asset('logo'),
      name: 'Embedded first',
      data: 'data:image/png;base64,YQ==',
    };
    source.assets = [{ ...asset('global'), name: 'Global alias target' }];
    module.embeddedResourceScope = {
      id: 'embedded',
      theme: source.theme,
      translations: {},
      locale: 'en',
      assetAliases: { logo: 'global' },
      assets: [embedded, { ...embedded, name: 'Duplicate last' }],
    };
    source.modules = [module];
    source.widgets = [instance];
    const original = structuredClone(source);
    const plan = preparePaste(project('target'), copySelection(source, main, ['instance']), main);
    const copy = plan.candidate.modules[0];
    const scope = plan.candidate.resourceScopes!.find(
      (entry) => entry.id === copy.resourceScopeId,
    )!;
    const mapped = plan.candidate.assets.find((entry) => entry.id === scope.assetAliases!.logo)!;
    expect(mapped.name).toMatch(/^Embedded first/);
    expect(mapped.data).toBe(embedded.data);
    expect(plan.candidate.assets.some((entry) => entry.name.startsWith('Duplicate last'))).toBe(
      false,
    );
    expect(source).toEqual(original);
    const again = preparePaste(
      project('third'),
      copySelection(plan.candidate, main, plan.rootIds),
      main,
    );
    const againScope = again.candidate.resourceScopes!.find(
      (entry) => entry.id === again.candidate.modules[0].resourceScopeId,
    )!;
    expect(
      again.candidate.assets.find((entry) => entry.id === againScope.assetAliases!.logo)?.data,
    ).toBe(embedded.data);
  });
  it('keeps legacy same-document copies on their original schema and defaults', () => {
    const legacy = createProject();
    legacy.widgets = [widget('text', 'legacy')];
    legacy.flows = [];
    legacy.scripts = [];
    legacy.variables = [];
    expect(legacy.schemaVersion).toBe(1);
    expect(Object.hasOwn(legacy.widgets[0], 'definitionVersion')).toBe(false);
    const bundle = copySelection(legacy, main, ['legacy'], 'legacy-session');
    const plan = preparePaste(legacy, bundle, main, undefined, {
      sameDocument: true,
      sessionKey: 'legacy-session',
    });
    expect(plan.candidate.schemaVersion).toBe(1);
    expect(Object.hasOwn(plan.candidate, 'windows')).toBe(false);
    expect(Object.hasOwn(plan.candidate, 'resourceScopes')).toBe(false);
    expect(Object.hasOwn(plan.candidate.widgets[1], 'definitionVersion')).toBe(false);
    expect(plan.candidate.scripts).toEqual(legacy.scripts);
    validateProject(plan.candidate);
  });
  it('keeps preallocated IDs stable across theme and reuse review changes', () => {
    const source = project(),
      text = widget('text', 'text');
    text.bindings.text = { variable: 'v', mode: 'oneWay' };
    source.widgets = [text];
    source.variables = [{ id: 'v', name: 'v', type: 'string', initial: 'x' }];
    const target = project('target');
    target.variables = [{ id: 'existing', name: 'existing', type: 'string', initial: 'y' }];
    const bundle = copySelection(source, main, ['text']);
    const first = preparePaste(target, bundle, main);
    const theme = preparePaste(target, bundle, main, undefined, {
      useTargetTheme: true,
      previousMappings: first.mappings,
    });
    expect(theme.rootIds).toEqual(first.rootIds);
    expect(theme.mappings.variables).toEqual(first.mappings.variables);
    const reused = preparePaste(target, bundle, main, undefined, {
      reuse: { variables: { v: 'existing' } },
      previousMappings: theme.mappings,
    });
    expect(reused.mappings.variables.v).toBe('existing');
    expect(reused.rootIds).toEqual(first.rootIds);
    const fresh = preparePaste(target, bundle, main, undefined, {
      previousMappings: reused.mappings,
    });
    expect(fresh.mappings.variables.v).toBe(first.mappings.variables.v);
    expect(fresh.rootIds).toEqual(first.rootIds);
  });
  it('rejects invalid or unknown clipboard data and stale/tampered paste plans atomically', async () => {
    const source = project();
    source.widgets = [widget('text', 'text')];
    const bundle = copySelection(source, main, ['text']),
      target = project('target'),
      plan = preparePaste(target, bundle, main),
      before = structuredClone(target);
    expect(() => preparePaste(target, { ...bundle, futureField: true } as never, main)).toThrow();
    const missing = structuredClone(bundle);
    missing.widgets[0].bindings.text = { variable: 'missing', mode: 'oneWay' };
    expect(() => preparePaste(target, missing, main)).toThrow(/Missing/);
    expect(target).toEqual(before);
    target.name = 'Changed without revision';
    expect(() => applyPastePlan(target, plan)).toThrow(/changed/);
    target.name = before.name;
    plan.candidate.name = 'Tampered';
    expect(() => applyPastePlan(target, plan)).toThrow(/candidate changed/);
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
        readText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });
    await writeClipboard(bundle);
    expect(getClipboardStorage()).toBe('memory');
    expect((await readClipboard()).rootIds).toEqual(['text']);
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn().mockResolvedValue('{broken') } });
    await expect(readClipboard()).rejects.toThrow(/QuickGUI/);
  });
});
