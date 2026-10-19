import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyProject, createWidget } from '../../src/core/project';
import type { Project, Widget } from '../../src/core/types';

const designWidget = (page: Page, id: string) => page.locator(`[data-design-widget="${id}"]`);
const undoButton = (page: Page) =>
  page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true });

function legacyProject(name: string, widgets: Widget[] = []): Project {
  const project = createEmptyProject(name);
  project.schemaVersion = 1;
  delete project.windows;
  project.widgets = widgets;
  return project;
}

async function importProject(page: Page, project: Project) {
  await page.locator('input[accept=".qgui,.json"]').setInputFiles({
    name: `${project.name}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.locator('.project-switch')).toHaveText(project.name);
  await expect(page.locator('[data-design-widget]')).toHaveCount(project.widgets.length);
}

async function exportProject(page: Page, info: TestInfo, name: string): Promise<Project> {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const downloading = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const download = await downloading;
  const destination = info.outputPath(`${name}.qgui`);
  await download.saveAs(destination);
  const files = unzipSync(new Uint8Array(await readFile(destination)));
  return JSON.parse(strFromU8(files['quickgui.json'])) as Project;
}

async function useMemoryClipboard(page: Page) {
  // Exercise production clipboard fallback; only the browser permission boundary is mocked.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText() {
          throw new DOMException('Clipboard access denied by test', 'NotAllowedError');
        },
        async readText() {
          throw new DOMException('Clipboard access denied by test', 'NotAllowedError');
        },
      },
    });
  });
}

async function selectSection(page: Page, name: string) {
  await page.locator('.workspace-tabs nav').getByRole('button', { name, exact: true }).click();
}

test('creating a project uses v5 and new widgets use definition version 2', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.locator('.project-switch').click();
  await page
    .locator('.project-dropdown')
    .getByRole('button', { name: '新建工程', exact: true })
    .click();
  const naming = page.getByRole('dialog', { name: '新建工程', exact: true });
  await naming.getByLabel('工程名称', { exact: true }).fill('V3 New Project');
  await naming.getByRole('button', { name: '创建工程', exact: true }).click();
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await page.locator('.left-tabs').getByRole('button', { name: '控件', exact: true }).click();
  await page.locator('.qg-library').getByRole('button', { name: '文本输入', exact: true }).click();
  await expect(page.locator('.qg-inspector').getByLabel('输入类型', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/v3-modern-properties.png', fullPage: true });
  const result = await exportProject(page, info, 'new-v3');
  expect(result.schemaVersion).toBe(5);
  expect(result.windows).toEqual([]);
  expect(result.widgets).toHaveLength(1);
  expect(result.widgets[0]).toMatchObject({ type: 'input', definitionVersion: 2 });
});

test('opening an old document immediately uses current properties and undo stays current', async ({
  page,
}, info) => {
  const old = { ...createWidget('input', 0, 0, 1), id: 'legacy-input', name: 'Legacy Input' };
  await page.goto('/');
  await importProject(page, legacyProject('Automatic Upgrade', [old]));
  await designWidget(page, old.id).click();
  await expect(page.getByRole('button', { name: '升级控件属性', exact: true })).toHaveCount(0);
  const type = page.locator('.qg-inspector').getByLabel('输入类型', { exact: true });
  await expect(type).toBeVisible();
  const opened = await exportProject(page, info, 'auto-upgraded');
  expect(opened.schemaVersion).toBe(5);
  expect(opened.widgets[0]).toMatchObject({ id: old.id, definitionVersion: 2 });
  await expect(undoButton(page)).toBeDisabled();
  await type.selectOption('password');
  await undoButton(page).click();
  const undone = await exportProject(page, info, 'undo-current');
  expect(undone.schemaVersion).toBe(5);
  expect(undone.widgets).toEqual(opened.widgets);
});

test('Ctrl+C and Ctrl+V keep current versions in the same document and undo once', async ({
  page,
}, info) => {
  await useMemoryClipboard(page);
  const original = { ...createWidget('button', 40, 60), id: 'copy-source', name: 'Copy Source' };
  const project = legacyProject('Same Document Copy', [original]);
  await page.goto('/');
  await importProject(page, project);
  await designWidget(page, original.id).click();
  await page.locator('.qg-canvas-viewport').focus();
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.getByRole('status')).toContainText('已复制控件');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('[data-design-widget]')).toHaveCount(2);
  await expect(page.getByRole('dialog', { name: '跨工程粘贴', exact: true })).toHaveCount(0);
  const pasted = await exportProject(page, info, 'same-document-paste');
  expect(pasted.schemaVersion).toBe(5);
  expect(pasted.widgets.map((widget) => widget.definitionVersion ?? 1)).toEqual([2, 2]);
  expect(new Set(pasted.widgets.map((widget) => widget.id)).size).toBe(2);
  expect(pasted.widgets[1].props).toEqual(original.props);
  await page.locator('.qg-canvas-viewport').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('[data-design-widget]')).toHaveCount(1);
  await expect(undoButton(page)).toBeDisabled();
  expect((await exportProject(page, info, 'same-document-undone')).widgets).toEqual(
    project.widgets,
  );
});

test('cross-project fallback paste reviews mappings and code trust, then imports and undoes atomically', async ({
  page,
}, info) => {
  await useMemoryClipboard(page);
  const action = { ...createWidget('button', 40, 60), id: 'action', name: 'Source Action' };
  action.bindings.text = { variable: 'source-count', mode: 'oneWay' };
  action.events.click = 'source-flow';
  const source = legacyProject('Clipboard Source', [action]);
  source.variables = [{ id: 'source-count', name: 'Source Count', type: 'number', initial: 7 }];
  source.scripts = [
    {
      id: 'source-script',
      name: 'increment.c',
      source:
        '#include "quickgui.h"\nvoid qg_process(void) { qg_emit_number(qg_input_number() + 1); }',
      timeoutMs: 1000,
    },
  ];
  source.flows = [
    {
      id: 'source-flow',
      name: 'Source Flow',
      enabled: true,
      nodes: [
        { id: 'trigger', kind: 'event', label: 'Click', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'script',
          kind: 'script',
          label: 'Increment',
          position: { x: 200, y: 0 },
          config: { scriptId: 'source-script' },
        },
      ],
      edges: [{ id: 'run', source: 'trigger', target: 'script' }],
    },
  ];
  const target = legacyProject('Clipboard Target');
  target.variables = [{ id: 'target-count', name: 'Target Count', type: 'number', initial: 99 }];
  await page.goto('/');
  await importProject(page, source);
  await designWidget(page, action.id).click();
  await page.locator('.qg-canvas-viewport').focus();
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.getByRole('status')).toContainText('已复制控件');
  await importProject(page, target);
  await page.locator('.qg-canvas-viewport').focus();
  await page.keyboard.press('ControlOrMeta+v');
  const review = page.getByRole('dialog', { name: '跨工程粘贴', exact: true });
  await expect(review).toBeVisible();
  await expect(review).not.toContainText('工作副本升级');
  await expect(review).toContainText('系统剪贴板不可用');
  await expect(review.locator('.paste-summary')).toContainText('粘贴 1 个控件');
  const cancelIcon = review.getByRole('button', { name: '取消粘贴', exact: true });
  await expect(cancelIcon).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(review.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancelIcon).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(review).toHaveCount(0);
  await expect(page.locator('[data-design-widget]')).toHaveCount(0);
  await expect(undoButton(page)).toBeDisabled();
  await expect(page.locator('.qg-canvas-viewport')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(review).toBeVisible();
  const confirm = review.getByRole('button', { name: '确认粘贴', exact: true });
  await expect(confirm).toBeDisabled();
  await review.getByLabel('变量: Source Count', { exact: true }).selectOption('target-count');
  await expect(
    review.getByLabel('明确启用导入流程: Source Flow', { exact: true }),
  ).not.toBeChecked();
  await review.getByRole('checkbox', { name: /我信任此次导入的 C/ }).check();
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: 'artifacts/v3-paste-review.png', fullPage: true });
  await confirm.click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('[data-design-widget]')).toHaveCount(1);
  const imported = await exportProject(page, info, 'cross-project-pasted');
  expect(imported.schemaVersion).toBe(5);
  expect(imported.variables).toEqual(target.variables);
  expect(imported.widgets[0].bindings.text.variable).toBe('target-count');
  expect(imported.widgets[0].definitionVersion).toBe(2);
  expect(imported.flows).toHaveLength(1);
  expect(imported.flows[0].enabled).toBe(false);
  expect(imported.scripts).toHaveLength(1);
  expect(imported.widgets[0].events.click).toBe(imported.flows[0].id);
  expect(imported.flows[0].nodes.find((node) => node.kind === 'script')?.config.scriptId).toBe(
    imported.scripts[0].id,
  );
  await undoButton(page).click();
  const undone = await exportProject(page, info, 'cross-project-undone');
  expect({ ...undone, revision: 0 }).toEqual({
    ...target,
    schemaVersion: 5,
    windows: [],
    revision: 0,
  });
  await expect(undoButton(page)).toBeDisabled();
});

test('parameter components validate initial and runtime JSON independently', async ({
  page,
}, info) => {
  await page.goto('/');
  await importProject(page, createEmptyProject('JSON Data Editing'));
  await selectSection(page, '流程');
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: 'JSON参数', exact: true })
    .click();
  const row = page.locator('.qg-parameter-inspector');
  await row.getByLabel('参数名称', { exact: true }).fill('Machine');
  await row.getByLabel('参数名称', { exact: true }).blur();
  const initial = row.getByLabel('initial Machine', { exact: true });
  const runtime = row.getByLabel('runtime Machine', { exact: true });
  await initial.fill('{"nested":{"temperature":12},"labels":["A","B"]}');
  await initial.press('Tab');
  const saved = await exportProject(page, info, 'json-initial');
  expect(saved.variables[0]).toMatchObject({
    type: 'json',
    initial: { nested: { temperature: 12 }, labels: ['A', 'B'] },
  });
  await initial.fill('{"unfinished":');
  await initial.press('Tab');
  await expect(row.getByRole('alert')).toBeVisible();
  expect((await exportProject(page, info, 'json-invalid-rejected')).variables[0].initial).toEqual(
    saved.variables[0].initial,
  );
  await initial.focus();
  await initial.press('Escape');
  await expect(row.getByRole('alert')).toHaveCount(0);
  expect(JSON.parse(await initial.inputValue())).toEqual(saved.variables[0].initial);
  await initial.fill('{"cancelled":true}');
  await initial.press('Escape');
  expect(JSON.parse(await initial.inputValue())).toEqual(saved.variables[0].initial);
  await runtime.fill('{"nested":{"temperature":30},"labels":["Runtime"]}');
  await runtime.press('Tab');
  expect(JSON.parse(await runtime.inputValue())).toEqual({
    nested: { temperature: 30 },
    labels: ['Runtime'],
  });
  await runtime.fill('{"unfinished":');
  await runtime.press('Tab');
  await expect(row.getByRole('alert')).toBeVisible();
  await runtime.focus();
  await runtime.press('Escape');
  await expect(row.getByRole('alert')).toHaveCount(0);
  expect(JSON.parse(await runtime.inputValue())).toEqual({
    nested: { temperature: 30 },
    labels: ['Runtime'],
  });
  await runtime.fill('{"cancelled":true}');
  await runtime.press('Escape');
  expect(JSON.parse(await runtime.inputValue())).toEqual({
    nested: { temperature: 30 },
    labels: ['Runtime'],
  });
  expect(
    (await exportProject(page, info, 'json-runtime-does-not-replace-initial')).variables[0].initial,
  ).toEqual(saved.variables[0].initial);
});

test('two-way JSON leaf writes stay shared across independent preview windows without losing siblings', async ({
  page,
}) => {
  const project = createEmptyProject('JSON Shared Windows');
  project.window = { ...project.window, title: 'Main Window', width: 640, height: 420 };
  project.variables = [
    {
      id: 'machine',
      name: 'Machine',
      type: 'json',
      initial: {
        plant: { temperature: 12, mode: 'manual' },
        untouched: { alarms: [1, 2], enabled: true },
      },
    },
  ];
  const controls = (prefix: string) => {
    const temperature = { ...createWidget('number', 32, 32, 2), id: `${prefix}-temperature` };
    temperature.bindings[prefix === 'secondary' ? '/value' : 'value'] = {
      variable: prefix === 'secondary' ? 'Machine' : 'machine',
      mode: 'twoWay',
      path: ['plant', 'temperature'],
    };
    const mode = { ...createWidget('input', 32, 96, 2), id: `${prefix}-mode` };
    mode.bindings[prefix === 'secondary' ? '/value' : 'value'] = {
      variable: prefix === 'secondary' ? 'Machine' : 'machine',
      mode: 'twoWay',
      path: ['plant', 'mode'],
    };
    return [temperature, mode];
  };
  project.widgets = controls('main');
  project.windows = [
    {
      id: 'secondary',
      name: 'Second Window',
      config: { ...project.window, title: 'Second Window' },
      widgets: controls('secondary'),
      openOnStart: true,
    },
  ];
  await page.goto('/');
  await importProject(page, project);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  const number = (id: string) => preview.locator(`[data-widget="${id}-temperature"] input`);
  const mode = (id: string) => preview.locator(`[data-widget="${id}-mode"] input`);
  await expect.poll(async () => Number(await number('main').inputValue())).toBe(12);
  await expect.poll(async () => Number(await number('secondary').inputValue())).toBe(12);
  await preview.getByRole('button', { name: '打开窗口 Main Window', exact: true }).click();
  await number('main').fill('21');
  await expect.poll(async () => Number(await number('secondary').inputValue())).toBe(21);
  await preview.getByRole('button', { name: '打开窗口 Second Window', exact: true }).click();
  await mode('secondary').fill('automatic');
  await expect(mode('main')).toHaveValue('automatic');
  await number('secondary').fill('37');
  await expect.poll(async () => Number(await number('main').inputValue())).toBe(37);
  await preview.getByRole('button', { name: '打开窗口 Main Window', exact: true }).click();
  await mode('main').fill('service');
  await expect(mode('secondary')).toHaveValue('service');
  await page.screenshot({ path: 'artifacts/v3-shared-json-preview.png', fullPage: true });
  await preview
    .locator(':scope > header')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await selectSection(page, '流程');
  await page
    .locator('.qg-flow-library-tabs')
    .getByRole('button', { name: '参数', exact: true })
    .click();
  await page
    .locator('.qg-parameter-library')
    .getByRole('button', { name: '编辑参数 Machine', exact: true })
    .click();
  const value = JSON.parse(await page.getByLabel('runtime Machine', { exact: true }).inputValue());
  expect(value).toEqual({
    plant: { temperature: 37, mode: 'service' },
    untouched: { alarms: [1, 2], enabled: true },
  });
  expect(
    JSON.parse(await page.getByLabel('initial Machine', { exact: true }).inputValue()),
  ).toEqual(project.variables[0].initial);
});

test('canvas context menu remains visible at viewport edges and supports keyboard dismissal', async ({
  page,
}) => {
  const input = { ...createWidget('input', 40, 60, 2), id: 'modern-input', name: 'Modern Input' };
  const project = createEmptyProject('Canvas Visual Review');
  project.widgets = [input];
  await page.goto('/');
  await importProject(page, project);
  await designWidget(page, input.id).click();
  for (const size of [
    { width: 1440, height: 1000 },
    { width: 1100, height: 760 },
  ]) {
    await page.setViewportSize(size);
    const viewport = page.locator('.qg-canvas-viewport');
    const box = (await viewport.boundingBox())!;
    await viewport.click({ button: 'right', position: { x: box.width - 12, y: box.height - 12 } });
    const menu = page.getByRole('menu', { name: 'Canvas actions', exact: true });
    await expect(menu).toBeVisible();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height);
    await page.keyboard.press('End');
    await expect(menu.locator('button:enabled').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.locator('button:enabled').first()).toBeFocused();
    await page.screenshot({ path: `artifacts/v3-canvas-menu-${size.width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(designWidget(page, input.id)).toHaveClass(/is-selected/);
  }
});
