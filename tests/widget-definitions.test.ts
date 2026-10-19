import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEmptyProject, createWidget, widgetNames } from '../src/core/project';
import type { Json, Project, Widget, WidgetType } from '../src/core/types';
import {
  createWidgetDefaults,
  getBindableProperties,
  getJsonPath,
  getWidgetDefinition,
  inferBindingPath,
  propertyPath,
  remapArrayBindings,
  resolvedWidgetProps,
  setJsonPath,
  validatePropertyPatch,
} from '../src/core/widgetDefinitions';
import { boundProps, Scene, scopedProject, WidgetView } from '../src/runtime/WidgetRenderer';
import {
  appendChartSample,
  chartPath,
  chartSeries,
  sortTableRows,
  tableColumns,
  TableWidget,
} from '../src/runtime/DataWidgets';

const modern = (type: WidgetType): Widget => ({
  ...createWidget(type),
  ...createWidgetDefaults(type),
  definitionVersion: 2,
});
const project = (): Project => ({ ...createEmptyProject(), schemaVersion: 3, windows: [] });

describe('widget property definitions', () => {
  it('defines all 14 controls with valid defaults and unique keys', () => {
    for (const type of Object.keys(widgetNames) as WidgetType[]) {
      const widget = modern(type),
        definition = getWidgetDefinition(type);
      expect(new Set(definition.properties.map((property) => property.key)).size, type).toBe(
        definition.properties.length,
      );
      expect(validatePropertyPatch(widget, {}, project()), type).toEqual([]);
      expect(
        definition.properties.every(
          (property) => property.editor && property.label.zh && property.label.en,
        ),
        type,
      ).toBe(true);
      const html = renderToStaticMarkup(h(WidgetView, { widget, project: project() }));
      expect(html, type).toContain('data-definition-version="2"');
    }
  });
  it('separates creation defaults from absent-property fallback without mutating old data', () => {
    const widget = modern('number');
    expect(widget.props.value).toBe(42);
    delete widget.props.value;
    expect(resolvedWidgetProps(widget).value).toBe(0);
    expect(Object.hasOwn(widget.props, 'value')).toBe(false);
    const first = createWidgetDefaults('chart'),
      second = createWidgetDefaults('chart');
    (first.props.series as Record<string, Json>[])[0].value = 999;
    expect((second.props.series as Record<string, Json>[])[0].value).toBe(42);
  });
  it('rejects incompatible values, invalid ranges, excessive curves and invalid columns', () => {
    const widget = modern('slider');
    expect(
      validatePropertyPatch(widget, { props: { ...widget.props, min: 100, max: 10, step: 0 } }).map(
        (issue) => issue.path,
      ),
    ).toEqual(expect.arrayContaining(['props.max', 'props.step']));
    const chart = modern('chart');
    expect(
      validatePropertyPatch(chart, {
        props: {
          ...chart.props,
          series: Array.from({ length: 17 }, (_, i) => ({
            id: String(i),
            name: 'A',
            value: 1,
            color: '#fff',
          })),
        },
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'props.series' })]));
    const table = modern('table');
    expect(
      validatePropertyPatch(table, {
        props: {
          ...table.props,
          columns: [{ id: 'a', title: 'A', path: [-1], width: -1, align: 'bogus' }],
        },
      }).length,
    ).toBe(3);
  });
  it('preserves legacy extension maps and supports numeric text and typed select values', () => {
    const old = {
      ...modern('number'),
      definitionVersion: 1 as const,
      props: { vendorData: { nested: true }, value: 'legacy' },
    };
    expect(validatePropertyPatch(old, {})).toEqual([]);
    const select = modern('select');
    expect(
      validatePropertyPatch(select, {
        props: { ...select.props, value: 2, options: [{ id: 'n', label: 'Two', value: 2 }] },
      }),
    ).toEqual([]);
    const text = modern('text'),
      p = project();
    p.variables = [{ id: 'n', name: 'n', type: 'number', initial: 1 }];
    expect(
      validatePropertyPatch(text, { bindings: { text: { variable: 'n', mode: 'oneWay' } } }, p),
    ).toEqual([]);
  });
});

describe('JSON property and binding paths', () => {
  it('uses escaped JSON pointers and immutable nested writes', () => {
    const value = { 'a/b': [{ '~key': 1 }], untouched: true };
    const path = propertyPath('/a~1b/0/~0key', value);
    expect(getJsonPath(value, path)).toBe(1);
    const updated = setJsonPath(value, path, 5);
    expect(getJsonPath(updated, path)).toBe(5);
    expect(getJsonPath(value, path)).toBe(1);
    expect(() => setJsonPath(value, ['a/b', 5], 4)).toThrow();
    expect(() => propertyPath('/__proto__/polluted')).toThrow();
    expect(getJsonPath(value, ['constructor'])).toBeUndefined();
    expect(() => propertyPath('/bad~2escape')).toThrow();
  });
  it('resolves JSON variable leaves into nested chart properties without changing the model', () => {
    const widget = modern('chart');
    widget.bindings['/series/0/value'] = {
      variable: 'json',
      mode: 'oneWay',
      path: ['devices', 0, 'temperature'],
    };
    const original = structuredClone(widget);
    const result = boundProps(widget, {
      json: { value: { devices: [{ temperature: 24.5 }] }, quality: 'good', timestamp: 1 },
    });
    expect(getJsonPath(result, ['series', 0, 'value'])).toBe(24.5);
    expect(widget).toEqual(original);
    const diagnostics: string[] = [];
    const invalid = boundProps(
      widget,
      { json: { value: { devices: [{ temperature: 'bad' }] }, quality: 'good', timestamp: 2 } },
      diagnostics,
    );
    expect(getJsonPath(invalid, ['series', 0, 'value'])).toBe(42);
    expect(diagnostics).toEqual(['/series/0/value: Expected number']);
    expect(
      getJsonPath(boundProps(widget, { json: { value: {}, quality: 'good', timestamp: 1 } }), [
        'series',
        0,
        'value',
      ]),
    ).toBe(42);
  });
  it('keeps curve bindings attached to stable series IDs on reorder and deletion', () => {
    const before: Json[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const bindings: Widget['bindings'] = {
      '/series/0/value': { variable: 'x', mode: 'oneWay' },
      '/series/1/value': { variable: 'y', mode: 'oneWay' },
      visible: { variable: 'show', mode: 'once' },
    };
    expect(remapArrayBindings(bindings, 'series', before, [before[1], before[2]])).toEqual({
      '/series/0/value': bindings['/series/1/value'],
      visible: bindings.visible,
    });
    expect(bindings['/series/0/value'].variable).toBe('x');
  });
  it('checks JSON leaf types and prohibits unsupported two-way properties and readonly writes', () => {
    const p = project(),
      widget = modern('number');
    p.variables = [
      { id: 'json', name: 'json', type: 'json', initial: { count: 3, title: 'bad' } },
      { id: 'locked', name: 'locked', type: 'number', initial: 1, readOnly: true },
    ];
    const valid = { value: { variable: 'json', mode: 'twoWay' as const, path: ['count'] } };
    expect(validatePropertyPatch(widget, { bindings: valid }, p)).toEqual([]);
    expect(
      validatePropertyPatch(
        widget,
        { bindings: { value: { ...valid.value, path: ['title'] } } },
        p,
      ),
    ).toHaveLength(1);
    expect(
      validatePropertyPatch(
        widget,
        { bindings: { value: { variable: 'json', mode: 'twoWay' } } },
        p,
      ),
    ).toHaveLength(1);
    expect(
      validatePropertyPatch(
        widget,
        { bindings: { value: { variable: 'locked', mode: 'twoWay' } } },
        p,
      ),
    ).toHaveLength(1);
    expect(
      validatePropertyPatch(
        widget,
        { bindings: { enabled: { variable: 'json', mode: 'twoWay', path: ['count'] } } },
        p,
      ).length,
    ).toBeGreaterThan(0);
    const value = getBindableProperties(widget).find((entry) => entry.key === 'value')!;
    expect(inferBindingPath({ label: 'x', nested: { n: 4 } }, value)).toEqual(['nested', 'n']);
  });
});

describe('versioned render semantics', () => {
  it('hides and disables subtrees consistently', () => {
    const p = project(),
      parent = modern('panel'),
      child = modern('button');
    child.parentId = parent.id;
    parent.props.visible = false;
    p.widgets = [parent, child];
    expect(renderToStaticMarkup(h(Scene, { project: p }))).not.toContain(
      'data-widget="' + child.id + '"',
    );
    parent.definitionVersion = 2;
    parent.props.visible = true;
    parent.props.enabled = false;
    expect(renderToStaticMarkup(h(Scene, { project: p }))).toContain('disabled=""');
  });
  it('applies current step, image fit and state style', () => {
    const p = project(),
      number = modern('number');
    number.props.step = 0.25;
    expect(renderToStaticMarkup(h(WidgetView, { widget: number, project: p }))).toContain(
      'step="0.25"',
    );
    const image = modern('image');
    image.props.assetId = 'img';
    image.props.fit = 'cover';
    p.assets = [{ id: 'img', name: 'a', mime: 'image/png', data: 'data:image/png;base64,aA==' }];
    expect(renderToStaticMarkup(h(WidgetView, { widget: image, project: p }))).toContain(
      'object-fit:cover',
    );
    const button = modern('button');
    button.states.hover = { background: '#123456' };
    expect(
      renderToStaticMarkup(h(WidgetView, { widget: button, project: p, previewState: 'hover' })),
    ).toContain('background:#123456');
  });
  it('uses the scoped theme and locale without mutating the canonical project', () => {
    const p = project(),
      widget = modern('text');
    widget.resourceScopeId = 'scope';
    widget.props.text = '@title';
    p.resourceScopes = [
      {
        id: 'scope',
        theme: { mode: 'dark', tokens: { 'color.text': '#123456' } },
        locale: 'zh-CN',
        translations: { 'zh-CN': { title: '源标题' }, en: { title: 'Source' } },
        localeVariableId: 'lang',
      },
    ];
    const before = structuredClone(p),
      values = { lang: { value: 'en', quality: 'good' as const, timestamp: 1 } };
    expect(scopedProject(p, 'scope', values).locale).toBe('zh-CN');
    const html = renderToStaticMarkup(h(WidgetView, { widget, project: p, values }));
    expect(html).toContain('Source');
    expect(html).toContain('color:#123456');
    expect(p).toEqual(before);
  });
  it('resolves scoped asset aliases and embedded package assets without leaking aliases between scopes', () => {
    const p = project(),
      image = modern('image');
    p.assets = [
      { id: 'same', name: 'destination', mime: 'image/png', data: 'data:image/png;base64,AAA=' },
      { id: 'copied', name: 'source', mime: 'image/png', data: 'data:image/png;base64,BBB=' },
    ];
    p.resourceScopes = [
      { id: 'a', locale: 'en', theme: p.theme, translations: {}, assetAliases: { same: 'copied' } },
      {
        id: 'b',
        locale: 'en',
        theme: p.theme,
        translations: {},
        assetAliases: { original: 'same' },
      },
    ];
    image.resourceScopeId = 'a';
    image.props.assetId = 'same';
    expect(renderToStaticMarkup(h(WidgetView, { widget: image, project: p }))).toContain(
      'data:image/png;base64,BBB=',
    );
    expect(scopedProject(scopedProject(p, 'a'), 'b').assets[0].data).toBe(
      'data:image/png;base64,AAA=',
    );
    p.resourceScopes[0].assets = [
      { id: 'embedded', name: 'embedded', mime: 'image/png', data: 'data:image/png;base64,CCC=' },
    ];
    image.props.assetId = 'embedded';
    expect(validatePropertyPatch(image, {}, p)).toEqual([]);
    expect(renderToStaticMarkup(h(WidgetView, { widget: image, project: p }))).toContain(
      'data:image/png;base64,CCC=',
    );
    expect(p.assets).toHaveLength(2);
  });
});

describe('data widgets', () => {
  it('retains stable values at each interval, bounds samples and splits gaps', () => {
    const series = chartSeries({ series: [{ id: 'a', name: 'A', value: 2, color: '#fff' }] });
    let samples = appendChartSample([], series, 1, 2);
    samples = appendChartSample(samples, series, 2, 2);
    samples = appendChartSample(samples, series, 3, 2);
    expect(samples.map((sample) => sample.timestamp)).toEqual([2, 3]);
    expect(samples.map((sample) => sample.values.a)).toEqual([2, 2]);
    expect(
      chartPath(
        [
          { timestamp: 0, value: 1 },
          { timestamp: 1, value: null },
          { timestamp: 2, value: 3 },
        ],
        0,
        10,
        0,
        2,
      ).match(/M/g),
    ).toHaveLength(2);
    expect(chartSeries({ series: Array(20).fill({}) })).toHaveLength(16);
  });
  it('sorts by JSON field paths stably while retaining original row indexes', () => {
    const rows: Json[] = [{ n: { value: 10 } }, { n: { value: 2 } }, { n: { value: 2 } }];
    const columns = tableColumns(
      { columns: [{ id: 'n', title: 'N', path: ['n', 'value'], align: 'right' }] },
      rows,
    );
    expect(sortTableRows(rows, columns[0]).map((row) => row.index)).toEqual([1, 2, 0]);
    expect(sortTableRows(rows, columns[0], 'desc').map((row) => row.index)).toEqual([0, 1, 2]);
    expect(rows[0]).toEqual({ n: { value: 10 } });
  });
  it('renders a maximum of 20 table rows by default and reports empty data', () => {
    const props = createWidgetDefaults('table').props;
    props.rows = Array.from({ length: 25 }, (_, i) => ({ device: 'Device ' + i, value: i }));
    const html = renderToStaticMarkup(
      h(TableWidget, { props, interactive: true, onEvent: () => {}, locale: 'en' }),
    );
    expect(html.match(/<tr /g)).toHaveLength(20);
    expect(html).toContain('1 / 2');
    expect(html).not.toContain('Device 20');
    expect(
      renderToStaticMarkup(
        h(TableWidget, {
          props: { ...props, rows: [], emptyText: 'Nothing' },
          interactive: true,
          onEvent: () => {},
          locale: 'en',
        }),
      ),
    ).toContain('Nothing');
  });
});
