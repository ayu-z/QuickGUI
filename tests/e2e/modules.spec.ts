import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyProject, createWidget } from '../../src/core/project';
import type { ComponentModule, Project } from '../../src/core/types';
import { expectProjectName } from './workspace';

const storageKey = 'quickgui.project.v1';
const panel = (page: Page) => page.locator('.modules-panel');
const inspector = (page: Page) => page.locator('.qg-module-inspector');
const card = (page: Page, id: string) => panel(page).locator(`[data-module-id="${id}"]`);
const widget = (page: Page, id: string) => page.locator(`[data-design-widget="${id}"]`);
const recovered = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).project as Project, storageKey);
async function open(page: Page, project: Project, drafts: Record<string, string> = {}) {
  await page.addInitScript(
    ({ key, value }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    { key: storageKey, value: JSON.stringify({ project, drafts }) },
  );
  await page.goto('/');
  await expectProjectName(page, project.name);
}
async function modules(page: Page) {
  await page.locator('.left-tabs').getByRole('button', { name: '模块', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function commit(page: Page, label: string, value: string) {
  const input = inspector(page).getByLabel(label, { exact: true });
  await input.fill(value);
  await input.blur();
}
function layoutModule(): ComponentModule {
  const text = createWidget('text', 24, 32, 2);
  text.id = 'definition-label';
  text.name = 'Definition label';
  text.props.text = 'Original definition';
  return {
    id: 'editable-module',
    name: 'Editable module',
    version: '1.0.0',
    width: 400,
    height: 220,
    widgets: [text],
    exposedProps: {},
  };
}
function sourceModule(): ComponentModule {
  const manifest = {
    schemaVersion: 1,
    id: 'source.badge',
    name: 'Source badge',
    version: '1.0.0',
    entry: 'src/Badge.tsx',
    width: 200,
    height: 80,
    props: { label: 'Ready' },
    events: [],
  };
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    width: manifest.width,
    height: manifest.height,
    widgets: [],
    exposedProps: { label: { widgetId: '$component', property: 'label', default: 'Ready' } },
    implementation: {
      kind: 'react',
      files: {
        'manifest.json': JSON.stringify(manifest),
        'src/Badge.tsx': 'export default function Badge() { return <span>Ready</span> }',
      },
      bundle: 'export function mount() { return { update() {}, unmount() {} }; }',
      events: [],
    },
  };
}

test('named modules copy complete multi-selection subtrees and support atomic undo, duplicate, rename, delete and export', async ({
  page,
}, info) => {
  const project = createEmptyProject('Module management');
  const container = createWidget('panel', 100, 80, 2),
    child = createWidget('text', 20, 20, 2),
    button = createWidget('button', 500, 90, 2);
  container.id = 'source-panel';
  child.id = 'source-child';
  button.id = 'source-button';
  child.parentId = container.id;
  project.widgets = [container, child, button];
  await open(page, project);
  await widget(page, container.id).click({ position: { x: 170, y: 120 } });
  await widget(page, button.id).click({ modifiers: ['Shift'] });
  await expect(page.locator('.qg-design-widget.is-selected')).toHaveCount(2);
  await modules(page);
  await panel(page).getByLabel('模块名称', { exact: true }).fill('Reusable controls');
  await panel(page).getByRole('button', { name: '创建模块', exact: true }).click();
  await expect.poll(async () => (await recovered(page)).modules.length).toBe(1);
  const created = (await recovered(page)).modules[0];
  expect(created.name).toBe('Reusable controls');
  expect(created.width).toBeCloseTo(540, 3);
  expect(created.height).toBeCloseTo(180, 3);
  expect(created.widgets).toHaveLength(3);
  expect(created.widgets.find((item) => item.type === 'text')!.parentId).toBe(
    created.widgets.find((item) => item.type === 'panel')!.id,
  );
  expect(created.widgets.find((item) => item.type === 'button')!.layout.x).toBeCloseTo(400, 3);
  expect(created.widgets.find((item) => item.type === 'button')!.layout.y).toBeCloseTo(10, 3);
  expect((await recovered(page)).widgets).toEqual(project.widgets);
  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await recovered(page)).modules.length).toBe(0);
  await page.locator('.workspace-tools').getByRole('button', { name: '重做', exact: true }).click();
  await expect(card(page, created.id)).toBeVisible();
  await card(page, created.id)
    .getByRole('button', { name: '复制模块 Reusable controls', exact: true })
    .click();
  await expect.poll(async () => (await recovered(page)).modules.length).toBe(2);
  const copy = (await recovered(page)).modules.find((item) => item.id !== created.id)!;
  expect(copy.widgets[0].id).not.toBe(created.widgets[0].id);
  await card(page, copy.id)
    .getByRole('button', { name: `重命名模块 ${copy.name}`, exact: true })
    .click();
  await card(page, copy.id).getByLabel('新模块名称', { exact: true }).fill('Renamed copy');
  await card(page, copy.id).getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await recovered(page)).modules.find((item) => item.id === copy.id)!.name)
    .toBe('Renamed copy');
  await panel(page).getByLabel('搜索模块', { exact: true }).fill('Renamed');
  await expect(panel(page).locator('.modules-card')).toHaveCount(1);
  await card(page, copy.id)
    .getByRole('button', { name: '删除模块 Renamed copy', exact: true })
    .click();
  await expect.poll(async () => (await recovered(page)).modules.length).toBe(1);
  await panel(page).getByLabel('搜索模块', { exact: true }).fill('');
  const download = page.waitForEvent('download');
  await card(page, created.id)
    .getByRole('button', { name: '导出模块 Reusable controls', exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.qgui$/);
  const output = info.outputPath('reusable-module.qgui');
  await file.saveAs(output);
  const exported = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(await readFile(output)))['quickgui.json']),
  ) as Project;
  expect(exported.modules.some((item) => item.id === created.id)).toBe(true);
});

test('module metadata and public defaults stay separate from window properties and instance overrides', async ({
  page,
}) => {
  const project = createEmptyProject('Module definitions');
  project.modules = [layoutModule()];
  await open(page, project);
  await modules(page);
  await card(page, 'editable-module')
    .getByRole('button', { name: '编辑定义', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await expect(inspector(page)).toBeVisible();
  await expect(page.locator('.qg-window-inspector')).toHaveCount(0);
  await commit(page, '模块名称', 'Editable controls');
  await commit(page, '模块版本', '2.0.0');
  await commit(page, '模块宽度', '440');
  await commit(page, '模块高度', '240');
  await inspector(page).getByLabel('新暴露属性名', { exact: true }).fill('label');
  await inspector(page)
    .getByLabel('新属性目标控件', { exact: true })
    .selectOption('definition-label');
  await inspector(page).getByLabel('新属性目标属性', { exact: true }).selectOption('text');
  await inspector(page).getByRole('button', { name: '添加暴露属性', exact: true }).click();
  await inspector(page).getByLabel('default label', { exact: true }).fill('"Shared label"');
  await inspector(page).getByLabel('default label', { exact: true }).blur();
  await expect
    .poll(async () => (await recovered(page)).modules[0].exposedProps.label?.default)
    .toBe('Shared label');
  const updated = (await recovered(page)).modules[0];
  expect(updated).toMatchObject({
    name: 'Editable controls',
    version: '2.0.0',
    width: 440,
    height: 240,
  });
  expect((await recovered(page)).window).toEqual(project.window);
  await page.getByRole('button', { name: '退出模块定义', exact: true }).click();
  await modules(page);
  await card(page, updated.id).getByRole('button', { name: '添加实例', exact: true }).click();
  const props = page.locator('.qg-inspector');
  await expect(props.getByLabel('label', { exact: true })).toHaveValue('Shared label');
  await props.getByLabel('label', { exact: true }).fill('Instance override');
  await props.getByLabel('label', { exact: true }).blur();
  await expect
    .poll(
      async () =>
        (await recovered(page)).widgets.find((item) => item.type === 'module')?.props.label,
    )
    .toBe('Instance override');
  expect((await recovered(page)).modules[0].exposedProps.label.default).toBe('Shared label');
  await expect(
    card(page, updated.id).getByRole('button', { name: '删除模块 Editable controls', exact: true }),
  ).toBeDisabled();
  await props.getByRole('button', { name: '编辑模块定义', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(
    inspector(page).getByRole('button', { name: '删除暴露属性 label', exact: true }),
  ).toBeDisabled();
  await expect(inspector(page).getByLabel('新暴露属性名', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '退出模块定义', exact: true }).click();
  await expect(props.getByLabel('label', { exact: true })).toHaveValue('Instance override');
});

test('entering a child-window instance definition restores its source selection and preserves overrides', async ({
  page,
}) => {
  const project = createEmptyProject('Module window scope'),
    module = layoutModule();
  module.exposedProps = {
    label: { widgetId: module.widgets[0].id, property: 'text', default: 'Shared text' },
  };
  const mainText = createWidget('text', 24, 32);
  mainText.id = 'main-text';
  project.widgets = [mainText];
  project.modules = [module];
  const instance = createWidget('module', 32, 40);
  instance.id = 'child-instance';
  instance.moduleId = module.id;
  instance.props = { label: 'Child override' };
  instance.layout.width = module.width;
  instance.layout.height = module.height;
  project.windows = [
    {
      id: 'details',
      name: 'Details',
      config: { ...project.window, title: 'Details window' },
      widgets: [instance],
      openOnStart: false,
    },
  ];
  await open(page, project);
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('details');
  await widget(page, instance.id).click({ position: { x: 300, y: 160 } });
  const props = page.locator('.qg-inspector');
  await expect(props.getByLabel('label', { exact: true })).toHaveValue('Child override');
  await props.getByRole('button', { name: '编辑模块定义', exact: true }).click();
  await expect(inspector(page)).toBeVisible();
  await inspector(page).getByLabel('default label', { exact: true }).fill('"Updated shared"');
  await inspector(page).getByLabel('default label', { exact: true }).blur();
  await expect
    .poll(async () => (await recovered(page)).modules[0].exposedProps.label.default)
    .toBe('Updated shared');
  await page.getByRole('button', { name: '退出模块定义', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '选择窗口', exact: true })).toHaveValue(
    'details',
  );
  await expect(widget(page, instance.id)).toHaveClass(/is-selected/);
  await expect(props.getByLabel('label', { exact: true })).toHaveValue('Child override');
  expect((await recovered(page)).widgets).toEqual(project.widgets);
  expect((await recovered(page)).windows![0].widgets[0].props.label).toBe('Child override');
});

test('module actions reject unapplied CODE drafts and retain the valid model and draft text', async ({
  page,
}) => {
  const project = createEmptyProject('Module draft protection'),
    module = layoutModule();
  project.modules = [module];
  const drafts = {
    [`${project.id}/module/${module.id}::${module.widgets[0].id}`]: '{ invalid module CODE',
  };
  await open(page, project, drafts);
  await modules(page);
  await card(page, module.id)
    .getByRole('button', { name: '复制模块 Editable module', exact: true })
    .click();
  await expect(panel(page).getByRole('alert')).toContainText('CODE');
  await card(page, module.id)
    .getByRole('button', { name: '删除模块 Editable module', exact: true })
    .click();
  await expect(panel(page).getByRole('alert')).toContainText('CODE');
  expect((await recovered(page)).modules).toEqual(project.modules);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).drafts, storageKey),
  ).toEqual(drafts);
});

test('source definitions expose read-only files and export original package identity after local rename', async ({
  page,
}, info) => {
  const project = createEmptyProject('Source definitions'),
    source = sourceModule();
  project.modules = [source];
  await open(page, project);
  await modules(page);
  await card(page, source.id).getByRole('button', { name: '查看源码', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(inspector(page).getByLabel('模块版本', { exact: true })).toBeDisabled();
  await expect(inspector(page).getByLabel('模块宽度', { exact: true })).toBeDisabled();
  await inspector(page).locator('summary').filter({ hasText: 'src/Badge.tsx' }).click();
  await expect(inspector(page).getByLabel('source src/Badge.tsx', { exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await expect(inspector(page).getByLabel('source src/Badge.tsx', { exact: true })).toHaveValue(
    source.implementation!.files['src/Badge.tsx'],
  );
  await commit(page, '模块名称', 'Local source badge');
  const pending = page.waitForEvent('download');
  await inspector(page).getByRole('button', { name: '导出源码包', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.qgcomponent$/);
  const output = info.outputPath('source.qgcomponent');
  await download.saveAs(output);
  const archive = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(await readFile(output)))['module.json']),
  );
  const exported = archive.module ?? archive;
  expect(exported.name).toBe('Source badge');
  expect(exported.implementation.files).toEqual(source.implementation!.files);
});

test('module controls fit the narrow sidebar in light and dark English themes', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const project = createEmptyProject('Module layout');
  project.modules = [layoutModule(), sourceModule()];
  await open(page, project);
  await modules(page);
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(panel(page).getByLabel('Module name', { exact: true })).toBeVisible();
    await expect(
      panel(page).getByRole('button', { name: 'Create module', exact: true }),
    ).toBeVisible();
    const overflow = await panel(page).evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
      sidebar: element.parentElement!.getBoundingClientRect().width,
    }));
    expect(overflow.sidebar).toBe(190);
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 1);
    await card(page, 'source.badge')
      .getByRole('button', { name: 'View source', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      card(page, 'source.badge').getByRole('button', { name: 'View source', exact: true }),
    ).toBeVisible();
    const image = info.outputPath(`modules-${theme}.png`);
    await page.screenshot({ path: image, fullPage: true });
    await info.attach(`modules ${theme}`, { path: image, contentType: 'image/png' });
  }
});
