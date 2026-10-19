import { expect, test, type Page } from '@playwright/test';
import { createEmptyProject, createWidget } from '../../src/core/project';
import { createWidgetDefaults } from '../../src/core/widgetDefinitions';
import type { Project, Widget, WidgetType } from '../../src/core/types';

const modern = (type: WidgetType): Widget => ({
  ...createWidget(type),
  ...createWidgetDefaults(type),
  definitionVersion: 2,
});
const fixture = (widgets: Widget[]): Project => ({
  ...createEmptyProject(),
  schemaVersion: 5,
  windows: [],
  widgets,
});
async function mount(page: Page, project: Project, inspector = false) {
  await page.goto('/');
  await page.evaluate(async (payload: string) => {
    const { project, inspector } = JSON.parse(payload) as { project: Project; inspector: boolean };
    const reactPath = '/node_modules/.vite/deps/react.js',
      domPath = '/node_modules/.vite/deps/react-dom_client.js',
      rendererPath = '/src/runtime/WidgetRenderer.tsx',
      inspectorPath = '/src/designer/Inspector.tsx';
    const [reactModule, domModule, renderer, editor] = await Promise.all([
      import(reactPath),
      import(domPath),
      import(rendererPath),
      import(inspectorPath),
    ]);
    const React = reactModule.default ?? reactModule,
      ReactDOM = domModule.default ?? domModule;
    const state = window as unknown as {
      fixtureWidget: Widget;
      fixtureEvents: { event: string; payload: unknown }[];
    };
    state.fixtureEvents = [];
    const element = document.createElement('div');
    element.id = 'widget-fixture';
    Object.assign(element.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '99999',
      overflow: 'auto',
      background: '#17191f',
      color: '#edf0f7',
      width: inspector ? '400px' : '1100px',
    });
    document.body.append(element);
    const root = ReactDOM.createRoot(element);
    function Harness() {
      const [widget, update] = React.useState(project.widgets[0]);
      state.fixtureWidget = widget;
      return inspector
        ? React.createElement(editor.Inspector, {
            widget,
            project,
            locale: 'zh-CN',
            onUpdate: (patch: Partial<Widget>) =>
              update((previous: Widget) => ({ ...previous, ...patch })),
            draft: undefined,
            onDraft: () => {},
            onDelete: () => {},
            onDuplicate: () => {},
          })
        : React.createElement(renderer.Scene, {
            project,
            onEvent: (_widget: Widget, event: string, payload: unknown) =>
              state.fixtureEvents.push({ event, payload }),
          });
    }
    root.render(React.createElement(Harness));
  }, JSON.stringify({ project, inspector }));
  await expect(page.locator('#widget-fixture')).toBeVisible();
}

test('modern number and select emit typed values, and disabled parents gate descendants', async ({
  page,
}) => {
  const number = modern('number'),
    select = modern('select'),
    panel = modern('panel'),
    button = modern('button');
  number.props.step = 0.5;
  number.layout.y = 10;
  select.props.options = [
    { id: 'a', label: 'One', value: 1 },
    { id: 'b', label: 'Two', value: 2 },
  ];
  select.props.value = 1;
  select.layout.y = 70;
  panel.props.enabled = false;
  panel.layout.y = 140;
  button.parentId = panel.id;
  await mount(page, fixture([number, select, panel, button]));
  const root = page.locator('#widget-fixture');
  await expect(root.locator('input[type=number]')).toHaveAttribute('step', '0.5');
  await root.locator('input[type=number]').fill('12.5');
  await root.locator('select').selectOption({ label: 'Two' });
  await expect(root.locator('button')).toBeDisabled();
  const events = await page.evaluate(
    () => (window as unknown as { fixtureEvents: unknown[] }).fixtureEvents,
  );
  expect(events).toContainEqual({ event: 'change', payload: 12.5 });
  expect(events).toContainEqual({ event: 'change', payload: 2 });
});

test('table sorts numeric data, paginates and emits the original row index', async ({ page }) => {
  const table = modern('table');
  table.layout.width = 640;
  table.layout.height = 700;
  table.props.rows = Array.from({ length: 25 }, (_, i) => ({ device: 'D' + i, value: i }));
  await mount(page, fixture([table]));
  const root = page.locator('#widget-fixture');
  await expect(root.locator('tbody tr')).toHaveCount(20);
  await root.getByRole('button', { name: '数值', exact: true }).click();
  await root.getByRole('button', { name: '数值 ↑', exact: true }).click();
  await expect(root.locator('tbody tr').first()).toContainText('D24');
  await root.locator('tbody tr').first().click();
  expect(
    await page.evaluate(() => (window as unknown as { fixtureEvents: unknown[] }).fixtureEvents),
  ).toContainEqual({
    event: 'rowClick',
    payload: { row: { device: 'D24', value: 24 }, index: 24 },
  });
  await root.getByRole('button', { name: '下一页' }).click();
  await expect(root.locator('tbody tr')).toHaveCount(5);
});

test('chart samples stable values on time and reports native history unavailability in browser', async ({
  page,
}) => {
  const chart = modern('chart');
  chart.props.sampleInterval = 50;
  chart.props.maxPoints = 4;
  await mount(page, fixture([chart]));
  await expect(page.locator('#widget-fixture')).toContainText('4 samples');
  expect(await page.locator('#widget-fixture svg').innerHTML()).not.toContain('NaN');
  chart.props.mode = 'history';
  (chart.props.series as Record<string, unknown>[])[0].variableId = 'n';
  const p = fixture([chart]);
  p.variables = [{ id: 'n', name: 'n', type: 'number', initial: 1 }];
  await mount(page, p);
  await expect(page.locator('#widget-fixture').getByRole('status')).toContainText(
    '浏览器无法读取 SQLite 历史',
  );
});

test('series reordering preserves binding identity and JSON leaf paths', async ({ page }) => {
  const chart = modern('chart');
  chart.props.series = [
    { id: 'a', name: 'A', value: 1, color: '#123456', visible: true },
    { id: 'b', name: 'B', value: 2, color: '#abcdef', visible: true },
  ];
  chart.bindings = {
    '/series/1/value': { variable: 'json', mode: 'oneWay', path: ['nested', 'temperature'] },
  };
  const p = fixture([chart]);
  p.variables = [
    { id: 'json', name: 'json', type: 'json', initial: { nested: { temperature: 3 } } },
  ];
  await mount(page, p, true);
  const root = page.locator('#widget-fixture');
  await root.getByRole('button', { name: '上移', exact: true }).nth(1).click();
  const widget = await page.evaluate(
    () => (window as unknown as { fixtureWidget: Widget }).fixtureWidget,
  );
  expect((widget.props.series as Record<string, unknown>[])[0].id).toBe('b');
  expect(widget.bindings['/series/0/value']).toEqual({
    variable: 'json',
    mode: 'oneWay',
    path: ['nested', 'temperature'],
  });
  expect(widget.bindings['/series/1/value']).toBeUndefined();
});

test('property editor rejects invalid ranges, previews states with current definitions', async ({
  page,
}) => {
  const number = modern('number');
  await mount(page, fixture([number]), true);
  const root = page.locator('#widget-fixture');
  await root.getByLabel('最小值', { exact: true }).fill('150');
  await root.getByLabel('最小值', { exact: true }).press('Tab');
  await expect(root.getByRole('alert')).toContainText('Maximum must exceed minimum');
  expect(
    (await page.evaluate(() => (window as unknown as { fixtureWidget: Widget }).fixtureWidget))
      .props.min,
  ).toBe(0);
  number.states.hover = { background: '#123456' };
  await mount(page, fixture([number]), true);
  await page.locator('#widget-fixture').getByLabel('编辑状态').selectOption('hover');
  await expect(page.locator('#widget-fixture .qg-state-preview .qg-widget')).toHaveCSS(
    'background-color',
    'rgb(18, 52, 86)',
  );
});
