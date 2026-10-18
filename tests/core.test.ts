import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { cloneSubtree, createProject, createWidget } from '../src/core/project';
import { parseWidgetCode, validateProject, validateFlow } from '../src/core/validation';
import { exportProject, importProject } from '../src/core/archive';
import { RuntimeController } from '../src/runtime/engine';

describe('portable project contract', () => {
  it('copies a container with its descendants and remaps identities without changing bindings', () => {
    const parent = createWidget('panel');
    const child = createWidget('text');
    child.parentId = parent.id;
    child.bindings.text = { variable: 'temperature', mode: 'oneWay' };
    const copies = cloneSubtree([parent, child], parent.id);
    expect(copies).toHaveLength(2);
    expect(copies[0].id).not.toBe(parent.id);
    expect(copies[1].parentId).toBe(copies[0].id);
    expect(copies[1].bindings).toEqual(child.bindings);
    expect(copies[0].layout.x).toBe(parent.layout.x + 20);
    expect(child.parentId).toBe(parent.id);
  });
  it('normalizes a module root without retaining its previous external parent', () => {
    const panel = createWidget('panel');
    panel.parentId = 'outside';
    const child = createWidget('text');
    child.parentId = panel.id;
    const copies = cloneSubtree([panel, child], panel.id, true);
    expect(copies[0].parentId).toBeUndefined();
    expect(copies[0].layout.x).toBe(0);
    expect(copies[1].parentId).toBe(copies[0].id);
  });
  it('round-trips the complete project, C source and local assets', () => {
    const project = createProject();
    project.assets.push({
      id: 'logo',
      name: 'logo.png',
      mime: 'image/png',
      data: 'data:image/png;base64,aGVsbG8=',
    });
    project.publish.icon = 'logo';
    expect(importProject(exportProject(project))).toEqual(project);
  });
  it('does not silently export an unapplied property draft', () => {
    expect(() => exportProject(createProject(), { start_button: '{ invalid' })).toThrow(/draft/i);
  });
  it('rejects malformed and incompatible source files', () => {
    expect(() => importProject(strToU8('{ invalid'))).toThrow();
    const p = createProject();
    expect(() => validateProject({ ...p, schemaVersion: 2 })).toThrow();
    expect(() => validateProject({ ...p, widgets: [...p.widgets, p.widgets[0]] })).toThrow(
      /Duplicate/,
    );
    expect(() =>
      importProject(zipSync({ '../quickgui.json': strToU8(JSON.stringify(p)) })),
    ).toThrow(/missing/);
  });
  it('rejects missing binding references and recursive modules', () => {
    const p = createProject();
    p.widgets[0].bindings.text = { variable: 'missing', mode: 'oneWay' };
    expect(() => validateProject(p)).toThrow(/Missing variable/);
    delete p.widgets[0].bindings.text;
    const moduleWidget = createWidget('module');
    moduleWidget.moduleId = 'recursive';
    p.modules.push({
      id: 'recursive',
      name: 'loop',
      version: '1.0.0',
      width: 100,
      height: 100,
      widgets: [moduleWidget],
      exposedProps: {},
    });
    expect(() => validateProject(p)).toThrow(/Cyclic module/);
  });
});

describe('control-local CODE', () => {
  it('allows supported local styles but prevents identity or tree rewrites', () => {
    const code = {
      props: { text: '启动' },
      style: { borderRadius: 8, background: '$color.primary' },
      states: { hover: { opacity: 0.8 } },
    };
    expect(parseWidgetCode(JSON.stringify(code))).toEqual(code);
    expect(() => parseWidgetCode(JSON.stringify({ ...code, id: 'another-widget' }))).toThrow();
    expect(() => parseWidgetCode(JSON.stringify({ ...code, children: [] }))).toThrow();
    expect(() =>
      parseWidgetCode(JSON.stringify({ ...code, style: { position: 'fixed' } })),
    ).toThrow();
    expect(() =>
      parseWidgetCode(
        JSON.stringify({ ...code, style: { background: 'url(https://example.com)' } }),
      ),
    ).toThrow();
  });
});

describe('flow execution', () => {
  it('does not leak values or history into a different project with reused variable IDs', async () => {
    const first = createProject();
    const engine = new RuntimeController(first);
    await engine.runFlow('start-cycle');
    engine.setVariable('temperature', 72);
    expect(engine.getHistory('temperature')).toEqual([72]);
    const second = createProject();
    engine.applyProject(second);
    expect(engine.getSnapshot().values.cycles.value).toBe(0);
    expect(engine.getSnapshot().values.temperature.value).toBe(42.6);
    expect(engine.getHistory('temperature')).toEqual([]);
    expect(engine.getSnapshot().logs).toEqual([]);
    engine.dispose();
  });
  it('runs the shipped control workflow and persists the value over compatible hot updates', async () => {
    const p = createProject(),
      engine = new RuntimeController(p);
    await engine.runFlow('start-cycle');
    expect(engine.getSnapshot().values.cycles.value).toBe(1);
    p.revision++;
    p.widgets[0].style.fontSize = 26;
    engine.applyProject(p);
    expect(engine.getSnapshot().values.cycles.value).toBe(1);
    await engine.runFlow('start-cycle');
    expect(engine.getSnapshot().values.cycles.value).toBe(2);
    engine.dispose();
  });
  it('routes condition outputs only to their matching handles', async () => {
    const p = createProject();
    p.flows = [
      {
        id: 'conditional',
        name: 'conditional',
        enabled: true,
        nodes: [
          { id: 'root', kind: 'event', label: '', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'condition',
            kind: 'condition',
            label: '',
            position: { x: 0, y: 0 },
            config: { operator: 'gt', value: 5 },
          },
          {
            id: 'yes',
            kind: 'write',
            label: '',
            position: { x: 0, y: 0 },
            config: { variable: 'cycles', value: 100 },
          },
          {
            id: 'no',
            kind: 'write',
            label: '',
            position: { x: 0, y: 0 },
            config: { variable: 'cycles', value: -1 },
          },
        ],
        edges: [
          { id: 'a', source: 'root', target: 'condition' },
          { id: 'b', source: 'condition', sourceHandle: 'true', target: 'yes' },
          { id: 'c', source: 'condition', sourceHandle: 'false', target: 'no' },
        ],
      },
    ];
    const engine = new RuntimeController(p);
    await engine.runFlow('conditional', 1);
    expect(engine.getSnapshot().values.cycles.value).toBe(-1);
    await engine.runFlow('conditional', 8);
    expect(engine.getSnapshot().values.cycles.value).toBe(100);
    engine.dispose();
  });
  it('rejects cycles before execution and validates variable types', () => {
    const p = createProject();
    p.flows[0].edges.push({ id: 'cycle', source: 'log-cycle', target: 'trigger' });
    expect(() => validateFlow(p.flows[0])).toThrow(/cycle/i);
    const engine = new RuntimeController(createProject());
    expect(() => engine.setVariable('running', 1)).toThrow(/boolean/);
    engine.dispose();
  });
  it('cancels a pending delay during hot update without applying a stale write', async () => {
    const p = createProject();
    p.flows = [
      {
        id: 'slow',
        name: 'slow',
        enabled: true,
        nodes: [
          { id: 'start', kind: 'event', label: '', position: { x: 0, y: 0 }, config: {} },
          { id: 'delay', kind: 'delay', label: '', position: { x: 0, y: 0 }, config: { ms: 1000 } },
          {
            id: 'write',
            kind: 'write',
            label: '',
            position: { x: 0, y: 0 },
            config: { variable: 'cycles', value: 99 },
          },
        ],
        edges: [
          { id: 'start-delay', source: 'start', target: 'delay' },
          { id: 'edge', source: 'delay', target: 'write' },
        ],
      },
    ];
    const engine = new RuntimeController(p);
    const task = engine.runFlow('slow');
    await new Promise((r) => setTimeout(r, 20));
    engine.applyProject({ ...p, revision: 1 });
    await task;
    expect(engine.getSnapshot().values.cycles.value).toBe(0);
    engine.dispose();
  });
  it('does not pretend to run native C in the browser', async () => {
    const p = createProject();
    p.flows = [
      {
        id: 'c',
        name: 'C',
        enabled: true,
        nodes: [
          { id: 'start', kind: 'event', label: '', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'c',
            kind: 'script',
            label: '',
            position: { x: 0, y: 0 },
            config: { scriptId: p.scripts[0].id },
          },
        ],
        edges: [{ id: 'start-c', source: 'start', target: 'c' }],
      },
    ];
    const engine = new RuntimeController(p);
    await expect(engine.runFlow('c', 0)).rejects.toThrow(/desktop runtime/);
    engine.dispose();
  });
  it('commits C output only after the execution is still valid', async () => {
    const p = createProject();
    p.flows = [
      {
        id: 'c',
        name: 'C',
        enabled: true,
        nodes: [
          { id: 'start', kind: 'event', label: '', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'c',
            kind: 'script',
            label: '',
            position: { x: 0, y: 0 },
            config: { scriptId: p.scripts[0].id },
          },
        ],
        edges: [{ id: 'start-c', source: 'start', target: 'c' }],
      },
    ];
    const engine = new RuntimeController(p, async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { output: 5, writes: { cycles: 5 }, state: {}, logs: [] };
    });
    const task = engine.runFlow('c');
    await new Promise((r) => setTimeout(r, 5));
    engine.applyProject({ ...p, revision: 1 });
    await task;
    expect(engine.getSnapshot().values.cycles.value).toBe(0);
    engine.dispose();
  });
});
