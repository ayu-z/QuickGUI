import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyProject, createWidget } from '../../src/core/project';
import type { Project } from '../../src/core/types';

async function applyTheme(page: Page, mode: 'light' | 'dark') {
  const tabs = page.locator('.workspace-tabs nav');
  await tabs.getByRole('button', { name: '应用外观', exact: true }).click();
  const settings = page.locator('.appearance-panel');
  const button = settings.getByRole('button', {
    name: mode === 'light' ? '亮色' : '暗色',
    exact: true,
  });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await tabs.getByRole('button', { name: '界面', exact: true }).click();
}

async function exportProject(page: Page, info: TestInfo) {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const downloading = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const filename = info.outputPath('theme.qgui');
  await (await downloading).saveAs(filename);
  const files = unzipSync(new Uint8Array(await readFile(filename)));
  return JSON.parse(strFromU8(files['quickgui.json'])) as Project;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
});

test('applies an undoable project theme to canvas, preview and export independently of designer appearance', async ({
  page,
}, info) => {
  const canvas = page.getByTestId('design-canvas');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await applyTheme(page, 'light');
  await expect(canvas).toHaveCSS('background-color', 'rgb(244, 245, 248)');
  await expect(canvas.locator('[data-widget="start_button"]')).toHaveCSS('color-scheme', 'light');
  await expect(canvas.locator('[data-widget="heading"]')).toHaveCSS('color', 'rgb(32, 35, 51)');
  await expect(canvas.locator('[data-widget="start_button"]')).toHaveCSS(
    'background-color',
    'rgb(124, 58, 237)',
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(canvas).toHaveCSS('background-color', 'rgb(23, 25, 31)');
  await expect(canvas.locator('[data-widget="start_button"]')).toHaveCSS(
    'background-color',
    'rgb(139, 92, 246)',
  );
  await page.locator('.workspace-tools').getByRole('button', { name: '重做', exact: true }).click();
  await expect(canvas).toHaveCSS('background-color', 'rgb(244, 245, 248)');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await expect(preview.locator('.qg-scene')).toHaveCSS('background-color', 'rgb(244, 245, 248)');
  await expect(preview.locator('.qg-scene')).toHaveCSS('color-scheme', 'light');
  await expect(preview.locator('[data-widget="start_button"]')).toHaveCSS('color-scheme', 'light');
  await expect(preview.locator('[data-widget="heading"]')).toHaveCSS('color', 'rgb(32, 35, 51)');
  await preview.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await applyTheme(page, 'dark');
  await expect(canvas).toHaveCSS('background-color', 'rgb(23, 25, 31)');
  await expect(canvas.locator('[data-widget="start_button"]')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(preview.locator('.qg-scene')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
  await expect(preview.locator('.qg-scene')).toHaveCSS('color-scheme', 'dark');
  await expect(preview.locator('[data-widget="start_button"]')).toHaveCSS('color-scheme', 'dark');
  await expect(preview.locator('[data-widget="heading"]')).toHaveCSS('color', 'rgb(237, 240, 247)');
  await preview.getByRole('button', { name: '关闭', exact: true }).click();

  const project = await exportProject(page, info);
  expect(project.theme).toMatchObject({
    mode: 'dark',
    tokens: { 'color.background': '#17191f', 'color.text': '#edf0f7' },
    palettes: {
      light: { 'color.background': '#f4f5f8', 'color.text': '#202333' },
      dark: { 'color.background': '#17191f', 'color.text': '#edf0f7' },
    },
  });
  expect(project.window.background).toBe('#17191f');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await expect(page.getByTestId('design-canvas')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('updates matching child window backgrounds while preserving custom colors and round-tripping the light theme', async ({
  page,
}, info) => {
  const project = createEmptyProject('多窗口主题');
  delete project.theme.palettes;
  const fixed = createWidget('text');
  fixed.id = 'fixed-color';
  fixed.style.color = '#be123c';
  project.widgets = [fixed];
  project.theme.tokens['color.brand'] = '#123456';
  project.windows = [
    {
      id: 'following',
      name: '跟随主题',
      config: { ...project.window, title: '跟随主题', width: 640, height: 420 },
      widgets: [],
      openOnStart: true,
    },
    {
      id: 'custom',
      name: '自定义背景',
      config: {
        ...project.window,
        title: '自定义背景',
        width: 640,
        height: 420,
        background: '#345678',
      },
      widgets: [],
      openOnStart: true,
    },
  ];
  await page.locator('input[accept=".qgui,.json"]').setInputFiles({
    name: 'window-theme.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.locator('.project-switch')).toHaveText('多窗口主题');
  await applyTheme(page, 'light');
  await expect(page.getByTestId('design-canvas')).toHaveCSS(
    'background-color',
    'rgb(244, 245, 248)',
  );
  await expect(page.locator('[data-widget="fixed-color"]')).toHaveCSS('color', 'rgb(190, 18, 60)');
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('following');
  await expect(page.getByTestId('design-canvas')).toHaveCSS(
    'background-color',
    'rgb(244, 245, 248)',
  );
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('custom');
  await expect(page.getByTestId('design-canvas')).toHaveCSS('background-color', 'rgb(52, 86, 120)');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  for (const id of ['main', 'following'])
    await expect(preview.locator(`[data-runtime-window-id="${id}"] .qg-scene`)).toHaveCSS(
      'background-color',
      'rgb(244, 245, 248)',
    );
  await expect(preview.locator('[data-runtime-window-id="custom"] .qg-scene')).toHaveCSS(
    'background-color',
    'rgb(52, 86, 120)',
  );
  await preview.getByRole('button', { name: '关闭', exact: true }).click();

  const exported = await exportProject(page, info);
  expect(exported.theme.mode).toBe('light');
  expect(exported.theme.tokens['color.brand']).toBe('#123456');
  expect(exported.theme.palettes?.light['color.brand']).toBe('#123456');
  expect(exported.theme.palettes?.dark['color.brand']).toBe('#123456');
  expect(exported.widgets[0].style.color).toBe('#be123c');
  expect(exported.windows?.map((window) => window.config.background)).toEqual([
    '#f4f5f8',
    '#345678',
  ]);
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.project-switch')).toHaveText('多窗口主题');
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('main');
  await expect(page.getByTestId('design-canvas')).toHaveCSS(
    'background-color',
    'rgb(244, 245, 248)',
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
