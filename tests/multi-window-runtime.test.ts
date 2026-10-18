import { describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '../src/core/project';
import type { Project, ProjectWindow } from '../src/core/types';
import { RuntimeController } from '../src/runtime/engine';

function fixture(): Project {
  const project = createEmptyProject('Window workspace');
  project.schemaVersion = 2;
  project.windows = [
    {
      id: 'details',
      name: 'Details',
      config: { ...project.window, title: 'Details' },
      widgets: [],
      openOnStart: false,
    },
  ];
  project.variables = [{ id: 'count', name: 'count', type: 'number', initial: 0 }];
  project.flows = [
    {
      id: 'open-details',
      name: 'Open details',
      enabled: true,
      nodes: [
        { id: 'start', kind: 'event', label: 'Start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'open',
          kind: 'window',
          label: 'Open',
          position: { x: 100, y: 0 },
          config: { windowId: 'details', action: 'open' },
        },
        {
          id: 'write',
          kind: 'write',
          label: 'Write',
          position: { x: 200, y: 0 },
          config: { variable: 'count' },
        },
      ],
      edges: [
        { id: 'start-open', source: 'start', target: 'open' },
        { id: 'open-write', source: 'open', target: 'write' },
      ],
    },
  ];
  return project;
}

describe('shared multi-window runtime', () => {
  it('attaching views to the same revision neither cancels in-flight startup work nor starts it twice', async () => {
    const project = fixture();
    const flow = project.flows[0];
    flow.nodes[0].config.trigger = 'startup';
    flow.nodes[1].kind = 'delay';
    flow.nodes[1].config = { ms: 80 };
    flow.nodes[2].config.value = 1;
    const engine = new RuntimeController(project);
    engine.applyProject(project);
    await vi.waitFor(() => expect(engine.getSnapshot().activeNodes).toContain('open'));
    engine.applyProject(structuredClone(project));
    engine.windowAction('open', 'details');
    engine.applyProject(project);
    await vi.waitFor(() => expect(engine.getSnapshot().values.count.value).toBe(1));
    expect(
      engine.getSnapshot().logs.filter((log) => log.message.startsWith('Started:')),
    ).toHaveLength(1);
    expect(engine.getSnapshot().logs.some((log) => log.message.includes('cancelled'))).toBe(false);
    engine.dispose();
  });
  it('opens windows through flows without duplicating runtime state and preserves values after close/reopen', async () => {
    const engine = new RuntimeController(fixture());
    expect(engine.getSnapshot().windowState?.open).toEqual(['main']);
    await engine.runFlow('open-details', 42);
    expect(engine.getSnapshot().windowState?.open).toEqual(['main', 'details']);
    expect(engine.getSnapshot().windowState?.focused).toBe('details');
    expect(engine.getSnapshot().values.count.value).toBe(42);
    engine.windowAction('open', 'details');
    expect(engine.getSnapshot().windowState?.open).toEqual(['main', 'details']);
    engine.windowAction('close', 'details');
    expect(engine.getSnapshot().windowState?.open).toEqual(['main']);
    expect(engine.getSnapshot().running).toBe(true);
    engine.windowAction('focus', 'details');
    expect(engine.getSnapshot().windowState?.focused).toBe('details');
    expect(engine.getSnapshot().values.count.value).toBe(42);
    engine.dispose();
  });

  it('preserves manual window visibility during hot updates, removes deleted windows, and initializes new ones', () => {
    const project = fixture();
    project.windows![0].openOnStart = true;
    const engine = new RuntimeController(project);
    engine.windowAction('close', 'details');
    engine.setVariable('count', 7);
    const revision = engine.getSnapshot().windowState!.revision;
    const next = structuredClone(project);
    next.revision++;
    next.windows![0].config.title = 'Updated details';
    engine.applyProject(next);
    expect(engine.getSnapshot().windowState?.open).toEqual(['main']);
    expect(engine.getSnapshot().windowState?.revision).toBe(revision);
    expect(engine.getSnapshot().values.count.value).toBe(7);
    engine.windowAction('focus', 'details');
    const replacement: ProjectWindow = { ...next.windows![0], id: 'alarms', name: 'Alarms' };
    const latest = structuredClone(next);
    latest.windows = [replacement];
    latest.flows = [];
    latest.revision++;
    engine.applyProject(latest);
    expect(engine.getSnapshot().windowState?.open).toEqual(['main', 'alarms']);
    expect(engine.getSnapshot().windowState?.focused).toBe('main');
    expect(engine.getSnapshot().values.count.value).toBe(7);
    engine.dispose();
  });

  it('rejects invalid targets and protects the main window without corrupting visibility', () => {
    const engine = new RuntimeController(fixture());
    const before = engine.getSnapshot().windowState;
    expect(() => engine.windowAction('close', 'main')).toThrow(/main/);
    expect(() => engine.windowAction('open', '../unknown')).toThrow(/Unknown window/);
    expect(engine.getSnapshot().windowState).toEqual(before);
    const invalid = fixture();
    invalid.flows[0].nodes[1].config.windowId = 'unknown';
    expect(() => engine.applyProject(invalid)).toThrow(/Unknown window/);
    expect(engine.getSnapshot().windowState).toEqual(before);
    const malformed = fixture();
    malformed.windows![0].id = 'true';
    malformed.flows[0].nodes[1].config.windowId = true;
    expect(() => new RuntimeController(malformed)).toThrow(/must be strings/);
    engine.dispose();
  });

  it('resets window visibility when loading a different project', () => {
    const project = fixture();
    const engine = new RuntimeController(project);
    engine.windowAction('open', 'details');
    engine.setVariable('count', 7);
    const other = structuredClone(project);
    other.id = 'another-project';
    engine.applyProject(other);
    expect(engine.getSnapshot().windowState?.open).toEqual(['main']);
    expect(engine.getSnapshot().values.count.value).toBe(0);
    engine.dispose();
  });
});
