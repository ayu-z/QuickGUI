import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyProject, createWidget } from '../../src/core/project';
import { createBlockInterface } from '../../src/core/functionBlocks';
import type { FlowNode, Project } from '../../src/core/types';

const storageKey = 'quickgui.project.v1';
const inspector = (page: Page) => page.locator('.qg-parameter-inspector');
const undo = (page: Page) =>
  page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true });
const redo = (page: Page) =>
  page.locator('.workspace-tools').getByRole('button', { name: '重做', exact: true });
const recovered = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).project as Project, storageKey);

async function open(page: Page, project: Project) {
  await page.addInitScript(
    ({ key, saved }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, saved);
    },
    { key: storageKey, saved: JSON.stringify({ project, drafts: {} }) },
  );
  await page.goto('/');
  await expect(page.locator('.project-switch')).toHaveText(project.name);
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
}

async function definitions(page: Page) {
  await page
    .locator('.qg-flow-library-tabs')
    .getByRole('button', { name: '参数', exact: true })
    .click();
  return page.locator('.qg-parameter-library');
}

async function edit(page: Page, name: string) {
  const library = await definitions(page);
  await library.getByRole('button', { name: `编辑参数 ${name}`, exact: true }).click();
  await expect(inspector(page).getByLabel('参数名称', { exact: true })).toHaveValue(name);
}

async function exported(page: Page, info: TestInfo, name: string): Promise<Project> {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const pending = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const path = info.outputPath(`${name}.qgui`);
  await (await pending).saveAs(path);
  return JSON.parse(strFromU8(unzipSync(new Uint8Array(await readFile(path)))['quickgui.json']));
}

async function commitText(page: Page, label: string, value: string) {
  const input = inspector(page).getByLabel(label, { exact: true });
  await input.fill(value);
  await input.blur();
}

test('four parameter components create typed read blocks and undo each definition and node together', async ({
  page,
}, info) => {
  await open(page, createEmptyProject('Typed parameters'));
  await expect(
    page.locator('.workspace-tabs nav').getByRole('button', { name: '数据', exact: true }),
  ).toHaveCount(0);
  for (const [index, label, type, value] of [
    [0, '数值参数', 'number', 0],
    [1, '文本参数', 'string', ''],
    [2, '布尔参数', 'boolean', false],
    [3, 'JSON参数', 'json', {}],
  ] as const) {
    const before = await recovered(page);
    await page
      .locator('.qg-node-palette')
      .getByRole('button', { name: label, exact: true })
      .click();
    await expect(page.locator('.react-flow__node')).toHaveCount(index + 2);
    await expect(inspector(page)).toBeVisible();
    await expect(inspector(page).getByLabel('参数类型', { exact: true })).toHaveValue(type);
    await expect(inspector(page).getByLabel('参数类型', { exact: true })).toBeDisabled();
    await expect(
      inspector(page).getByRole('button', { name: '删除参数', exact: true }),
    ).toBeDisabled();
    await expect.poll(async () => (await recovered(page)).variables.length).toBe(index + 1);
    const created = await recovered(page);
    expect(created.variables).toHaveLength(index + 1);
    expect(created.flows).toHaveLength(1);
    expect(created.revision).toBe(before.revision + 1);
    const parameter = created.variables[index];
    const node = created.flows[0].nodes.find(
      (item) => item.kind === 'read' && item.config.variable === parameter.id,
    )!;
    expect(created.flows[0].nodes.find((item) => item.kind === 'event')?.config.trigger).toBe(
      'manual',
    );
    expect(parameter).toMatchObject({ type, initial: value });
    expect(node).toMatchObject({ kind: 'read', config: { variable: parameter.id } });
    expect(node.block?.inputs).toEqual([]);
    expect(node.block?.outputs).toMatchObject([{ type, path: [] }]);
    await undo(page).click();
    await expect.poll(async () => (await recovered(page)).variables).toEqual(before.variables);
    expect((await recovered(page)).flows).toEqual(before.flows);
    await redo(page).click();
    await expect.poll(async () => (await recovered(page)).variables).toEqual(created.variables);
    expect((await recovered(page)).flows).toEqual(created.flows);
  }
  const saved = await exported(page, info, 'typed-parameters');
  expect(saved.variables.map((variable) => variable.type)).toEqual([
    'number',
    'string',
    'boolean',
    'json',
  ]);
  const screenshot = info.outputPath('parameter-components.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('typed parameter components', { path: screenshot, contentType: 'image/png' });
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  const palette = page.locator('.qg-node-palette');
  for (const label of ['Number parameter', 'Text parameter', 'Boolean parameter', 'JSON parameter'])
    await expect(palette.getByRole('button', { name: label, exact: true })).toBeVisible();
  await expect(
    page.locator('.workspace-tabs nav').getByRole('button', { name: 'Data', exact: true }),
  ).toHaveCount(0);
});

test('parameter definitions preserve metadata, history access and bound IDs across export, refresh and undo', async ({
  page,
}, info) => {
  const project = createEmptyProject('Parameter metadata');
  project.variables = [
    { id: 'spare-id', name: 'Spare', type: 'number', initial: 5 },
    { id: 'bound-id', name: 'Bound', type: 'string', initial: 'stable' },
  ];
  const text = createWidget('text', 20, 20);
  text.id = 'bound-text';
  text.bindings.text = { variable: 'bound-id', mode: 'oneWay' };
  project.widgets = [text];
  await open(page, project);
  await edit(page, 'Spare');
  await expect(inspector(page).getByLabel('参数类型', { exact: true })).toBeEnabled();
  await expect(
    inspector(page).getByRole('button', { name: '删除参数', exact: true }),
  ).toBeEnabled();
  await commitText(page, '参数名称', 'Cadence');
  await commitText(page, '参数单位', 'ms');
  await commitText(page, 'initial Cadence', '12');
  await inspector(page).getByLabel('持久化', { exact: true }).check();
  await inspector(page).getByLabel('只读', { exact: true }).check();
  await expect(inspector(page).getByLabel('runtime Cadence', { exact: true })).toBeDisabled();
  await expect(inspector(page).getByLabel('initial Cadence', { exact: true })).toBeEnabled();
  await inspector(page).getByText('历史与报警', { exact: true }).click();
  const history = inspector(page).locator('.history-panel');
  await expect(history).toBeVisible();
  await history.getByLabel('下限', { exact: true }).fill('1');
  await history.getByLabel('上限', { exact: true }).fill('50');
  const saved = await exported(page, info, 'parameter-metadata');
  expect(saved.variables[0]).toMatchObject({
    id: 'spare-id',
    name: 'Cadence',
    type: 'number',
    initial: 12,
    unit: 'ms',
    persistent: true,
    readOnly: true,
    alarm: { min: 1, max: 50 },
  });
  expect(saved.widgets[0].bindings.text.variable).toBe('bound-id');
  await expect.poll(async () => (await recovered(page)).variables).toEqual(saved.variables);
  await page.reload();
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  await edit(page, 'Cadence');
  await expect(inspector(page).getByLabel('参数单位', { exact: true })).toHaveValue('ms');
  await expect(inspector(page).getByLabel('持久化', { exact: true })).toBeChecked();
  await expect(inspector(page).getByLabel('只读', { exact: true })).toBeChecked();
  await inspector(page).getByLabel('只读', { exact: true }).uncheck();
  await expect.poll(async () => (await recovered(page)).variables[0].readOnly).toBe(false);
  const revision = (await recovered(page)).revision;
  await commitText(page, 'runtime Cadence', '25');
  await expect(inspector(page).getByLabel('runtime Cadence', { exact: true })).toHaveValue('25');
  expect((await recovered(page)).revision).toBe(revision);
  expect((await recovered(page)).variables[0].initial).toBe(12);
  await inspector(page).getByText('历史与报警', { exact: true }).click();
  await expect(inspector(page).locator('.history-caption')).toContainText('25');
  await inspector(page).getByLabel('参数类型', { exact: true }).selectOption('string');
  await expect(inspector(page).getByLabel('initial Cadence', { exact: true })).toHaveValue('');
  await expect.poll(async () => (await recovered(page)).variables[0].type).toBe('string');
  const changed = await recovered(page);
  expect(changed.variables[0]).toMatchObject({
    id: 'spare-id',
    type: 'string',
    initial: '',
    persistent: true,
  });
  expect(changed.variables[0].alarm).toBeUndefined();
  await inspector(page).getByRole('button', { name: '删除参数', exact: true }).click();
  await expect
    .poll(async () => (await recovered(page)).variables.map((variable) => variable.id))
    .toEqual(['bound-id']);
  await undo(page).click();
  await expect.poll(async () => (await recovered(page)).variables).toEqual(changed.variables);
  await edit(page, 'Bound');
  await expect(inspector(page).getByLabel('参数类型', { exact: true })).toBeDisabled();
  await expect(
    inspector(page).getByRole('button', { name: '删除参数', exact: true }),
  ).toBeDisabled();
  expect((await exported(page, info, 'bound-id-preserved')).widgets[0].bindings.text.variable).toBe(
    'bound-id',
  );
});

test('existing definitions create references with typed outputs and data wiring writes the shared runtime value', async ({
  page,
}, info) => {
  const project = createEmptyProject('Parameter flow wiring');
  project.variables = [
    { id: 'source', name: 'Input', type: 'number', initial: 45 },
    { id: 'destination', name: 'Result', type: 'number', initial: 0 },
  ];
  const nodes: FlowNode[] = [
    {
      id: 'event',
      kind: 'event',
      label: 'Run',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual' },
    },
    {
      id: 'write',
      kind: 'write',
      label: 'Save result',
      position: { x: 400, y: 0 },
      config: { variable: 'destination' },
    },
  ];
  for (const node of nodes) node.block = createBlockInterface(node, project);
  project.flows = [
    {
      id: 'flow',
      name: 'Parameter transfer',
      enabled: true,
      nodes,
      edges: [{ id: 'execute', source: 'event', target: 'write' }],
    },
  ];
  await open(page, project);
  const library = await definitions(page);
  const viewport = page.locator('.qg-flow-viewport');
  const bounds = (await viewport.boundingBox())!;
  await library.getByRole('button', { name: '添加参数引用 Input', exact: true }).dragTo(viewport, {
    targetPosition: { x: bounds.width * 0.15, y: bounds.height * 0.75 },
  });
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect.poll(async () => (await recovered(page)).flows[0].nodes.length).toBe(3);
  const referenced = await recovered(page);
  expect(referenced.variables).toEqual(project.variables);
  const reader = referenced.flows[0].nodes.find((node) => node.kind === 'read')!;
  expect(reader.config.variable).toBe('source');
  expect(reader.block?.outputs[0].type).toBe('number');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  const source = page.locator(
    `.react-flow__node[data-id="${reader.id}"] [data-handleid="data-out:q"]`,
  );
  const input = page.locator('.react-flow__node[data-id="write"] [data-handleid="data-in:in"]');
  await source.dragTo(input);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect
    .poll(async () => (await recovered(page)).flows[0].edges.find((edge) => edge.kind === 'data'))
    .toMatchObject({
      source: reader.id,
      sourceHandle: 'data-out:q',
      target: 'write',
      targetHandle: 'data-in:in',
    });
  await edit(page, 'Result');
  // Live graph application is debounced; run only after this revision is accepted.
  await expect(inspector(page).getByLabel('runtime Result', { exact: true })).toBeEnabled();
  await page.locator('.console-panel').getByRole('button', { name: '运行', exact: true }).click();
  await expect(inspector(page).getByLabel('runtime Result', { exact: true })).toHaveValue('45');
  await edit(page, 'Input');
  await commitText(page, 'runtime Input', '81');
  await page.locator('.console-panel').getByRole('button', { name: '运行', exact: true }).click();
  await edit(page, 'Result');
  await expect(inspector(page).getByLabel('runtime Result', { exact: true })).toHaveValue('81');
  await expect(inspector(page).getByLabel('initial Result', { exact: true })).toHaveValue('0');
  const saved = await exported(page, info, 'parameter-data-wire');
  expect(saved.variables).toEqual(project.variables);
  expect(saved.flows[0].edges.find((edge) => edge.kind === 'data')).toMatchObject({
    source: reader.id,
    sourceHandle: 'data-out:q',
    target: 'write',
    targetHandle: 'data-in:in',
  });
});

// Control only the native IPC boundary; exercise production revision checks and inspector state.
test('runtime editing waits for an accepted native revision and honors read-only metadata', async ({
  page,
}) => {
  const project = createEmptyProject('Pending native parameter');
  project.variables = [{ id: 'sample', name: 'Sample', type: 'number', initial: 7 }];
  const entry: FlowNode = {
    id: 'manual-entry',
    kind: 'event',
    label: 'Manual only',
    position: { x: 60, y: 60 },
    config: { trigger: 'manual' },
  };
  entry.block = createBlockInterface(entry, project);
  project.flows = [
    { id: 'manual-flow', name: 'Manual only', enabled: true, nodes: [entry], edges: [] },
  ];
  await page.route(
    (url) =>
      url.pathname === '/src/native/bridge.ts' && !url.searchParams.has('parameter-test-actual'),
    (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
      export * from '/src/native/bridge.ts?parameter-test-actual';
      const harness = window.parameterNative = { hold: false, starts: 0, writes: [] };
      let runtime, listener;
      export const isDesktop = () => true;
      export const setDesignerTheme = async () => {};
      export const onPreviewClosed = async () => () => {};
      export const onStorageError = async () => () => {};
      export const onRuntimeSnapshot = async (callback) => { listener = callback; return () => {}; };
      export const runtimeStart = async (project) => {
        harness.starts++;
        const next = {
          projectId: project.id, revision: project.revision, sequence: harness.starts,
          values: Object.fromEntries(project.variables.map(v => [v.id, { value: v.initial, quality: 'good', timestamp: Date.now() }])),
          logs: [], activeNodes: [], running: true,
        };
        if (harness.hold) await new Promise(resolve => harness.release = resolve);
        return runtime = next;
      };
      export const setVariable = async (id, value) => {
        harness.writes.push({ id, value });
        runtime = { ...runtime, sequence: runtime.sequence + 1,
          values: { ...runtime.values, [id]: { value, quality: 'good', timestamp: Date.now() } } };
        return runtime;
      };
    `,
      }),
  );
  await open(page, project);
  await edit(page, 'Sample');
  const runtime = inspector(page).getByLabel('runtime Sample', { exact: true });
  const run = page.locator('.console-panel').getByRole('button', { name: '运行', exact: true });
  await expect(runtime).toBeEnabled();
  await expect(run).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { parameterNative: { hold: boolean } }).parameterNative.hold = true;
  });
  await commitText(page, '参数单位', 'ms');
  await expect(runtime).toBeDisabled();
  await expect(run).toBeDisabled();
  await expect(run).toHaveAttribute('aria-busy', 'true');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { parameterNative: { writes: unknown[] } }).parameterNative.writes,
    ),
  ).toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as unknown as { parameterNative: { release?: () => void } })
            .parameterNative.release,
      ),
    )
    .toBe('function');
  await page.evaluate(() => {
    const harness = (
      window as unknown as { parameterNative: { hold: boolean; release: () => void } }
    ).parameterNative;
    harness.hold = false;
    harness.release();
  });
  await expect(runtime).toBeEnabled();
  await expect(run).toBeEnabled();
  await expect(run).not.toHaveAttribute('aria-busy', 'true');
  await commitText(page, 'runtime Sample', '9');
  await expect(runtime).toHaveValue('9');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { parameterNative: { writes: unknown[] } }).parameterNative.writes,
    ),
  ).toEqual([{ id: 'sample', value: 9 }]);
  await inspector(page).getByLabel('只读', { exact: true }).check();
  await expect(runtime).toBeDisabled();
  expect((await recovered(page)).variables[0].initial).toBe(7);
});
