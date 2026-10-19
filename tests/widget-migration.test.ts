import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEmptyProject, createWidget } from '../src/core/project';
import { upgradeProject, upgradeWidget } from '../src/core/migration';
import {
  createWidgetDefaults,
  getJsonPath,
  propertyPath,
  validatePropertyPatch,
} from '../src/core/widgetDefinitions';
import { readJsonPath, replaceJsonPath } from '../src/core/jsonValue';
import { validateProject } from '../src/core/validation';
import { RuntimeController } from '../src/runtime/engine';
import { writeWidgetBindings } from '../src/runtime/RuntimeWindows';
import { boundProps, runtimeValueAliases, Scene, WidgetView } from '../src/runtime/WidgetRenderer';
import { tableData } from '../src/runtime/DataWidgets';
import type { Json, Project, Widget, WidgetType } from '../src/core/types';

const modern = (type: WidgetType): Widget => ({
  ...createWidget(type),
  ...createWidgetDefaults(type),
  definitionVersion: 2,
});
const project = (): Project => upgradeProject(createEmptyProject());
const printed = (value: Json) =>
  typeof value === 'number'
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)
    : typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value);

describe('automatic widget normalization', () => {
  it('moves the legacy chart value binding to the first curve and canonicalizes names', () => {
    const source = createEmptyProject(),
      old = createWidget('chart', 0, 0, 1);
    old.props.value = 17.5;
    old.props.vendor = { nested: ['retained'] };
    old.bindings.value = { variable: 'reading', mode: 'once' };
    source.variables = [{ id: 'numeric_id', name: 'reading', type: 'number', initial: 9 }];
    source.widgets = [old];
    const before = structuredClone(source),
      next = upgradeProject(source);
    next.widgets = [upgradeWidget(old, next)];
    expect(next.widgets[0].bindings).toEqual({
      '/series/0/value': { variable: 'numeric_id', mode: 'once' },
    });
    expect(getJsonPath(next.widgets[0].props, ['series', 0, 'value'])).toBe(17.5);
    expect(next.widgets[0].props.vendor).toEqual({ nested: ['retained'] });
    expect(next.widgets[0].props.sampleInterval).toBe(250);
    expect(validateProject(next)).toEqual(next);
    expect(source).toEqual(before);
    expect(upgradeWidget(next.widgets[0], next)).toEqual(next.widgets[0]);
  });
  it('turns the first legacy table row into indexed columns and retains every body cell', () => {
    const old = createWidget('table', 0, 0, 1);
    old.props.rows = [
      ['Device', 'Value'],
      ['A', 12],
      ['B', 7, 'extra'],
    ];
    const next = upgradeWidget(old),
      data = tableData(next.props);
    expect(data.columns.map((column) => [column.title, column.path])).toEqual([
      ['Device', [0]],
      ['Value', [1]],
      ['', [2]],
    ]);
    expect(data.rows).toEqual([
      ['A', 12],
      ['B', 7, 'extra'],
    ]);
    expect(getJsonPath(data.rows[1], data.columns[2].path)).toBe('extra');
    expect(validatePropertyPatch(next, {})).toEqual([]);
    expect(old.props.rows).toEqual([
      ['Device', 'Value'],
      ['A', 12],
      ['B', 7, 'extra'],
    ]);
  });
  it('keeps dynamically bound first-row headings out of table body data', () => {
    const p = project(),
      old = createWidget('table', 0, 0, 1);
    old.bindings.rows = { variable: 'rows', mode: 'oneWay' };
    p.variables = [
      {
        id: 'rows',
        name: 'rows',
        type: 'json',
        initial: [
          ['First', 'Second'],
          ['a', 1],
        ],
      },
    ];
    const next = upgradeWidget(old, p),
      props = boundProps(next, {
        rows: {
          value: [
            ['Changed', 'Count'],
            ['b', 2],
          ],
          quality: 'good',
          timestamp: 1,
        },
      });
    const data = tableData(props);
    expect(data.headerOffset).toBe(1);
    expect(data.columns.slice(0, 2).map((column) => column.title)).toEqual(['Changed', 'Count']);
    expect(data.rows).toEqual([['b', 2]]);
    expect(validatePropertyPatch(next, {}, p)).toEqual([]);
  });
  it('preserves legacy select labels, formatted values, object options and duplicate values', () => {
    const old = createWidget('select', 0, 0, 1),
      options: Json[] = [1234.5678, false, { label: 'raw object', value: 8 }, 1234.5678];
    old.props.options = options;
    old.props.value = options[0];
    const next = upgradeWidget(old);
    expect(
      (next.props.options as Record<string, Json>[]).map((option) => [option.label, option.value]),
    ).toEqual(options.map((option) => [printed(option), printed(option)]));
    expect(next.props.value).toBe(printed(options[0]));
    expect(validatePropertyPatch(next, {})).toEqual([]);
    const p = project();
    p.widgets = [next];
    const html = renderToStaticMarkup(
      h(WidgetView, { widget: next, project: p, interactive: true }),
    );
    expect(html).toContain('1234.568'.replace('1234', '1,234'));
    expect(html).toContain('raw object');
  });
  it('adapts dynamic legacy select options and keeps numeric source values selected', () => {
    const old = createWidget('select', 0, 0, 1),
      p = project();
    old.bindings.options = { variable: 'choices', mode: 'oneWay' };
    old.bindings.value = { variable: 'selected', mode: 'oneWay' };
    p.variables = [
      { id: 'choices', name: 'choices', type: 'json', initial: [1, { label: 'raw' }] },
      { id: 'selected', name: 'selected', type: 'number', initial: 1 },
    ];
    const next = upgradeWidget(old, p);
    const html = renderToStaticMarkup(
      h(WidgetView, {
        widget: next,
        project: p,
        values: {
          choices: { value: [1, { label: 'raw' }], quality: 'good', timestamp: 1 },
          selected: { value: 1, quality: 'good', timestamp: 1 },
        },
      }),
    );
    expect(html).toContain('value="0" selected=""');
    expect(html).toContain('{&quot;label&quot;:&quot;raw&quot;}');
    expect(validatePropertyPatch(next, {}, p)).toEqual([]);
  });
  it('preserves blur submission and protects conflicting legacy extension properties', () => {
    const input = createWidget('input', 0, 0, 1);
    input.props.value = 1234.5;
    input.events.submit = 'submit_flow';
    const next = upgradeWidget(input);
    expect(next.props.submitOn).toBe('blur');
    expect(next.props.value).toBe(printed(1234.5));
    expect(next.events).toEqual(input.events);
    const chart = createWidget('chart', 0, 0, 1);
    chart.props.series = { vendorExtension: true };
    const before = structuredClone(chart);
    expect(() => upgradeWidget(chart)).toThrow('Legacy extension props.series');
    expect(chart).toEqual(before);
  });
});

describe('binding and resource integration', () => {
  it('uses typed JSON paths consistently and separately resolves property-pointer indices', () => {
    const p = project(),
      widget = modern('number'),
      value = { rows: [{ n: 3 }], '0': 'object key' };
    p.variables = [{ id: 'j', name: 'j', type: 'json', initial: value }];
    widget.bindings.value = { variable: 'j', mode: 'twoWay', path: ['rows', '0', 'n'] };
    expect(validatePropertyPatch(widget, {}, p)).toEqual([
      expect.objectContaining({ path: 'bindings.value.path' }),
    ]);
    expect(getJsonPath(value, ['rows', '0', 'n'])).toBeUndefined();
    expect(() => readJsonPath(value, ['rows', '0', 'n'])).toThrow();
    expect(() => replaceJsonPath(value, ['rows', '0', 'n'], 4)).toThrow();
    expect(propertyPath('/rows/0/n', value)).toEqual(['rows', 0, 'n']);
    expect(propertyPath('/0', value)).toEqual(['0']);
    expect(getJsonPath(value, [0])).toBeUndefined();
    expect(getJsonPath(value, ['0'])).toBe('object key');
    const ownKeys = JSON.parse('{"__proto__":4}') as Json;
    expect(getJsonPath(ownKeys, ['__proto__'])).toBe(4);
    expect(() => propertyPath('/__proto__')).toThrow();
  });
  it('writes /value into a typed JSON leaf through the actual runtime dispatcher', () => {
    const p = project(),
      widget = modern('number');
    p.variables = [{ id: 'j', name: 'j', type: 'json', initial: { rows: [{ n: 3, other: 8 }] } }];
    widget.bindings['/value'] = { variable: 'j', mode: 'twoWay', path: ['rows', 0, 'n'] };
    p.widgets = [widget];
    expect(validateProject(p)).toEqual(p);
    const engine = new RuntimeController(p);
    writeWidgetBindings(widget, 'change', 9, p, engine.setVariable);
    expect(engine.getSnapshot().values.j.value).toEqual({ rows: [{ n: 9, other: 8 }] });
    writeWidgetBindings(widget, 'focus', null, p, engine.setVariable);
    expect(engine.getSnapshot().values.j.value).toEqual({ rows: [{ n: 9, other: 8 }] });
    engine.dispose();
  });
  it('provides ID-first aliases in every Scene without changing snapshots', () => {
    const p = project(),
      widget = createWidget('text');
    widget.bindings.text = { variable: 'reading', mode: 'oneWay' };
    p.widgets = [widget];
    p.variables = [
      { id: 'id_one', name: 'reading', type: 'number', initial: 17 },
      { id: 'reading', name: 'second', type: 'number', initial: 29 },
    ];
    const values = {
      id_one: { value: 17, quality: 'good' as const, timestamp: 1 },
      reading: { value: 29, quality: 'good' as const, timestamp: 1 },
    };
    expect(runtimeValueAliases(p, values).reading.value).toBe(29);
    expect(renderToStaticMarkup(h(Scene, { project: p, values }))).toContain('>29<');
    p.variables.pop();
    const withoutCollision = { id_one: values.id_one };
    expect(renderToStaticMarkup(h(Scene, { project: p, values: withoutCollision }))).toContain(
      '>17<',
    );
    expect(Object.keys(withoutCollision)).toEqual(['id_one']);
  });
  it('uses a dynamic scoped locale while retaining the source fallback language', () => {
    const p = project(),
      widget = modern('text');
    widget.resourceScopeId = 'scope';
    widget.props.text = '@title';
    p.resourceScopes = [
      {
        id: 'scope',
        locale: 'zh-CN',
        localeVariableId: 'lang',
        theme: p.theme,
        translations: { 'zh-CN': { title: '源回退' }, en: {} },
      },
    ];
    const values = {
      lang: { value: 'en', quality: 'good' as const, timestamp: 1 },
      locale: { value: 'en', quality: 'good' as const, timestamp: 1 },
    };
    expect(renderToStaticMarkup(h(WidgetView, { widget, project: p, values }))).toContain('源回退');
    p.resourceScopes[0].translations.en.title = 'English';
    expect(renderToStaticMarkup(h(WidgetView, { widget, project: p, values }))).toContain(
      'English',
    );
    expect(values.locale.value).toBe('en');
  });
});
