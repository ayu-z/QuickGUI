import { describe, expect, it } from 'vitest';
import { createEmptyProject, createProject, createWidget } from '../src/core/project';
import { upgradeProject } from '../src/core/migration';
import { validateProject } from '../src/core/validation';
import { exportProject, importProject } from '../src/core/archive';
import { variableReferences } from '../src/core/references';

describe('v3 project persistence and references', () => {
  it('creates current documents and normalizes copies without mutating the source', () => {
    expect(validateProject(createEmptyProject()).schemaVersion).toBe(5);
    const old = createProject();
    old.schemaVersion = 1;
    delete old.windows;
    old.widgets = [createWidget('input', 0, 0, 1)];
    const original = structuredClone(old);
    const next = upgradeProject(old);
    expect(old).toEqual(original);
    expect(next.widgets.every((widget) => widget.definitionVersion === 2)).toBe(true);
    expect(importProject(exportProject(next))).toEqual(next);
    expect(validateProject(old)).toEqual(next);
  });
  it('round-trips typed paths, editor flags and JSON data without dropping extensions', () => {
    const p = createEmptyProject(),
      widget = createWidget('number', 0, 0, 2);
    p.variables.push({ id: 'data', name: 'Data', type: 'json', initial: { items: [1, null] } });
    widget.bindings.value = { variable: 'data', mode: 'twoWay', path: ['items', 0] };
    widget.editor = { locked: true, hidden: true };
    widget.props.vendorData = { retained: true };
    p.widgets.push(widget);
    expect(importProject(exportProject(p))).toEqual(p);
    widget.bindings.value.path = ['items', -1];
    expect(() => validateProject(p)).toThrow();
  });
  it('rejects JSON paths on scalar bindings, even for legacy widgets inside v3', () => {
    const p = createEmptyProject(),
      widget = createWidget('number');
    p.variables.push({ id: 'number', name: 'Number', type: 'number', initial: 1 });
    p.widgets.push(widget);
    widget.bindings.value = { variable: 'Number', mode: 'twoWay', path: [] };
    expect(validateProject(p)).toEqual(p);
    widget.bindings.value.path = ['nested'];
    expect(() => validateProject(p)).toThrow(/json variable|JSON variable/);
  });
  it('checks saved flow paths before handing the document to the runtime', () => {
    const p = createProject();
    p.flows[0].nodes.find((node) => node.kind === 'read')!.config.path = [];
    expect(validateProject(p).schemaVersion).toBe(5);
    const next = upgradeProject(p),
      node = next.flows[0].nodes.find((entry) => entry.kind === 'read')!;
    expect(validateProject(next)).toEqual(next);
    node.config.path = ['nested'];
    expect(() => validateProject(next)).toThrow(/json variable/);
    node.config.path = 'nested';
    expect(() => validateProject(next)).toThrow(/JSON path/);
  });
  it('tracks chart, C alias and locale dependencies before deleting a variable', () => {
    const p = createEmptyProject();
    p.variables.push({ id: 'n', name: 'Number', type: 'number', initial: 1 });
    const chart = createWidget('chart', 0, 0, 2);
    chart.props.series = [{ id: 's', name: 'Series', variableId: 'n' }];
    p.widgets.push(chart);
    p.scripts.push({
      id: 'script',
      name: 'Script',
      source: '',
      timeoutMs: 100,
      variableAliases: { old: 'n' },
    });
    p.resourceScopes = [
      { id: 'source', theme: p.theme, translations: {}, locale: 'en', localeVariableId: 'n' },
    ];
    expect(variableReferences(p, p.variables[0])).toEqual([chart.name, 'Script', 'locale: source']);
  });
});
