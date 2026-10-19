import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyProject, createWidget } from '../../src/core/project';
import type { Project } from '../../src/core/types';

const appearance = (page: Page) => page.locator('.appearance-panel');
const tab = (page: Page, name: string) =>
  page.locator('.workspace-tabs nav').getByRole('button', { name, exact: true });

async function open(page: Page) {
  const project = createEmptyProject('自定义颜色');
  const label = createWidget('text', 32, 32);
  label.id = 'brand-label';
  label.props.text = 'Brand';
  label.style.color = '$color.brand';
  project.widgets = [label];
  await page.addInitScript(
    (recovery) => {
      if (!localStorage.getItem('quickgui.project.v1'))
        localStorage.setItem('quickgui.project.v1', recovery);
    },
    JSON.stringify({ project, drafts: {} }),
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await tab(page, '应用外观').click();
}

async function addColor(page: Page, name: string, color = '#1267ab') {
  await appearance(page).getByLabel('新颜色索引', { exact: true }).fill(name);
  await appearance(page).getByLabel('新颜色值', { exact: true }).fill(color);
  await appearance(page).getByRole('button', { name: '添加颜色', exact: true }).click();
}

async function exportedProject(page: Page, info: TestInfo): Promise<Project> {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const downloading = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const filename = info.outputPath('appearance.qgui');
  await (await downloading).saveAs(filename);
  const files = unzipSync(new Uint8Array(await readFile(filename)));
  return JSON.parse(strFromU8(files['quickgui.json'])) as Project;
}

test('edits theme colors in three compact columns and adds one undoable color without overwriting tokens', async ({
  page,
}) => {
  await open(page);
  const table = appearance(page).getByRole('table', { name: '主题颜色', exact: true });
  await expect(table.locator('thead th')).toHaveText(['索引', '颜色', '颜色值']);
  const originalCount = await table.locator('tbody tr').count();
  await addColor(page, 'brand');
  const value = appearance(page).getByLabel('令牌值：color.brand', { exact: true });
  await expect(value).toHaveValue('#1267ab');
  await expect(table.locator('tbody tr')).toHaveCount(originalCount + 1);
  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(value).toHaveCount(0);
  await page.locator('.workspace-tools').getByRole('button', { name: '重做', exact: true }).click();
  await expect(value).toHaveValue('#1267ab');

  await addColor(page, '$color.brand', '#ffffff');
  await expect(appearance(page).getByRole('alert')).toBeVisible();
  await expect(value).toHaveValue('#1267ab');
  await addColor(page, 'color.primary', '#ffffff');
  await expect(appearance(page).getByRole('alert')).toBeVisible();
  await expect(appearance(page).getByLabel('令牌值：color.primary', { exact: true })).toHaveValue(
    '#8b5cf6',
  );
  for (const invalid of ['', 'color.', 'brand color', 'color..brand']) {
    await addColor(page, invalid);
    await expect(appearance(page).getByRole('alert')).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(originalCount + 1);
  }
  await value.fill('#234567');
  await expect(appearance(page).getByLabel('颜色：color.brand', { exact: true })).toHaveValue(
    '#234567',
  );
  await appearance(page).getByLabel('颜色：color.brand', { exact: true }).fill('#345678');
  await expect(value).toHaveValue('#345678');
});

test('keeps new colors through presets, live canvas and preview, export and reload', async ({
  page,
}, info) => {
  await open(page);
  await addColor(page, 'color.brand');
  for (const name of ['一键亮色', '一键暗色']) {
    await appearance(page).getByRole('button', { name, exact: true }).click();
    await expect(appearance(page).getByLabel('令牌值：color.brand', { exact: true })).toHaveValue(
      '#1267ab',
    );
  }
  await tab(page, '界面').click();
  await expect(page.locator('[data-widget="brand-label"]')).toHaveCSS('color', 'rgb(18, 103, 171)');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await expect(preview.locator('[data-widget="brand-label"]')).toHaveCSS(
    'color',
    'rgb(18, 103, 171)',
  );
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  expect((await exportedProject(page, info)).theme.tokens['color.brand']).toBe('#1267ab');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await tab(page, '应用外观').click();
  await expect(appearance(page).getByLabel('令牌值：color.brand', { exact: true })).toHaveValue(
    '#1267ab',
  );
});

test('keeps three color columns compact and usable in both designer themes at 1100px', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await open(page);
  await addColor(page, 'brand');
  const table = appearance(page).getByRole('table', { name: '主题颜色', exact: true });
  await table.locator('thead').scrollIntoViewIfNeeded();
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(table.locator('thead th')).toHaveCount(3);
    await expect
      .poll(() =>
        table.locator('tbody tr').evaluateAll((rows) =>
          rows.every((row) => {
            const bounds = row.getBoundingClientRect();
            return bounds.height >= 32 && bounds.height <= 52;
          }),
        ),
      )
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    const screenshot = info.outputPath(`appearance-colors-${theme}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach(`compact appearance ${theme}`, {
      path: screenshot,
      contentType: 'image/png',
    });
  }
});
