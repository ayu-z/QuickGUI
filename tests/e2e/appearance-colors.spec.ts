import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyProject, createWidget } from '../../src/core/project';
import type { Project } from '../../src/core/types';

type Mode = 'light' | 'dark';
const appearance = (page: Page) => page.locator('.appearance-panel');
const tab = (page: Page, name: string) =>
  page.locator('.workspace-tabs nav').getByRole('button', { name, exact: true });
const value = (page: Page, mode: Mode, key: string) =>
  appearance(page).getByLabel(`${mode === 'light' ? '亮色' : '暗色'}值：${key}`, { exact: true });
const picker = (page: Page, mode: Mode, key: string) =>
  appearance(page).getByLabel(`${mode === 'light' ? '亮色' : '暗色'}颜色：${key}`, { exact: true });

function fixture() {
  const project = createEmptyProject('自定义颜色');
  const label = createWidget('text', 32, 32);
  label.id = 'brand-label';
  label.props.text = 'Brand';
  label.style.color = '$color.brand';
  project.widgets = [label];
  return project;
}
async function open(page: Page, project = fixture()) {
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
async function addColor(page: Page, name: string, light = '#1267ab', dark = '#6842a6') {
  await appearance(page).getByLabel('新颜色索引', { exact: true }).fill(name);
  await appearance(page).getByLabel('新亮色值', { exact: true }).fill(light);
  await appearance(page).getByLabel('新暗色值', { exact: true }).fill(dark);
  await appearance(page).getByRole('button', { name: '添加颜色', exact: true }).click();
}
async function selectTheme(page: Page, mode: Mode) {
  const button = appearance(page).getByRole('button', {
    name: mode === 'light' ? '一键亮色' : '一键暗色',
    exact: true,
  });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
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

test('edits paired light and dark colors in three columns and adds the pair as one undoable change', async ({
  page,
}) => {
  await open(page);
  const table = appearance(page).getByRole('table', { name: '主题颜色', exact: true });
  await expect(table.locator('thead th')).toHaveText(['索引', '亮色', '暗色']);
  const originalCount = await table.locator('tbody tr').count();
  await addColor(page, 'brand');
  await expect(value(page, 'light', 'color.brand')).toHaveValue('#1267ab');
  await expect(value(page, 'dark', 'color.brand')).toHaveValue('#6842a6');
  await expect(table.locator('tbody tr')).toHaveCount(originalCount + 1);
  const row = table.locator('tbody tr').filter({ hasText: 'color.brand' });
  await expect(row.locator(':scope > :first-child')).toContainText('color.brand');
  for (const [mode, column] of [
    ['亮色', 2],
    ['暗色', 3],
  ] as const) {
    const cell = row.locator(`:scope > :nth-child(${column})`);
    await expect(cell.locator('input')).toHaveCount(2);
    await expect(cell.locator('input[type="color"]')).toHaveCount(1);
    await expect(cell.locator('input:not([type="color"])')).toHaveCount(1);
    await expect(cell.getByLabel(`${mode}颜色：color.brand`, { exact: true })).toHaveCount(1);
    const textValue = cell.getByLabel(`${mode}值：color.brand`, { exact: true });
    await expect(textValue).toHaveCount(1);
    await expect(textValue).toHaveJSProperty('type', 'text');
  }
  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(value(page, 'light', 'color.brand')).toHaveCount(0);
  await expect(value(page, 'dark', 'color.brand')).toHaveCount(0);
  await page.locator('.workspace-tools').getByRole('button', { name: '重做', exact: true }).click();
  await expect(value(page, 'light', 'color.brand')).toHaveValue('#1267ab');
  await expect(value(page, 'dark', 'color.brand')).toHaveValue('#6842a6');
  await addColor(page, '$color.brand', '#ffffff', '#000000');
  await expect(appearance(page).getByRole('alert')).toBeVisible();
  await expect(value(page, 'light', 'color.brand')).toHaveValue('#1267ab');
  await expect(value(page, 'dark', 'color.brand')).toHaveValue('#6842a6');
  await addColor(page, 'color.primary', '#ffffff', '#000000');
  await expect(appearance(page).getByRole('alert')).toBeVisible();
  await expect(value(page, 'dark', 'color.primary')).toHaveValue('#8b5cf6');
  for (const invalid of ['', 'color.', 'brand color', 'color..brand']) {
    await addColor(page, invalid);
    await expect(appearance(page).getByRole('alert')).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(originalCount + 1);
  }
  await value(page, 'light', 'color.brand').fill('#234567');
  await expect(picker(page, 'light', 'color.brand')).toHaveValue('#234567');
  await picker(page, 'light', 'color.brand').fill('#345678');
  await expect(value(page, 'light', 'color.brand')).toHaveValue('#345678');
  await expect(value(page, 'dark', 'color.brand')).toHaveValue('#6842a6');
});

test('keeps inactive palette edits independent and applies saved colors to canvas, preview, export and reload', async ({
  page,
}, info) => {
  await open(page);
  await addColor(page, 'color.brand');
  await value(page, 'light', 'color.brand').fill('#11aa77');
  await value(page, 'light', 'color.background').fill('#e9f0e7');
  const inactive = await exportedProject(page, info);
  expect(inactive.theme.mode).toBe('dark');
  expect(inactive.theme.tokens['color.brand']).toBe('#6842a6');
  expect(inactive.theme.tokens['color.background']).toBe('#17191f');
  expect(inactive.window.background).toBe('#17191f');
  expect(inactive.theme.palettes?.light).toMatchObject({
    'color.brand': '#11aa77',
    'color.background': '#e9f0e7',
  });
  await tab(page, '界面').click();
  await expect(page.locator('[data-widget="brand-label"]')).toHaveCSS('color', 'rgb(104, 66, 166)');
  await expect(page.getByTestId('design-canvas')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
  await tab(page, '应用外观').click();
  await selectTheme(page, 'light');
  await tab(page, '界面').click();
  await expect(page.locator('[data-widget="brand-label"]')).toHaveCSS('color', 'rgb(17, 170, 119)');
  await expect(page.getByTestId('design-canvas')).toHaveCSS(
    'background-color',
    'rgb(233, 240, 231)',
  );
  await tab(page, '应用外观').click();
  await value(page, 'dark', 'color.brand').fill('#442266');
  expect((await exportedProject(page, info)).theme.tokens['color.brand']).toBe('#11aa77');
  await selectTheme(page, 'dark');
  await tab(page, '界面').click();
  await expect(page.locator('[data-widget="brand-label"]')).toHaveCSS('color', 'rgb(68, 34, 102)');
  await expect(page.getByTestId('design-canvas')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await expect(preview.locator('[data-widget="brand-label"]')).toHaveCSS(
    'color',
    'rgb(68, 34, 102)',
  );
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await tab(page, '应用外观').click();
  await selectTheme(page, 'light');
  await expect(value(page, 'light', 'color.brand')).toHaveValue('#11aa77');
  await expect(value(page, 'light', 'color.background')).toHaveValue('#e9f0e7');
  await selectTheme(page, 'dark');
  await expect(value(page, 'dark', 'color.brand')).toHaveValue('#442266');
  const exported = await exportedProject(page, info);
  expect(exported.theme.tokens['color.brand']).toBe('#442266');
  expect(exported.theme.palettes?.light['color.brand']).toBe('#11aa77');
  expect(exported.theme.palettes?.dark['color.brand']).toBe('#442266');
  expect(exported.window.background).toBe('#17191f');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await tab(page, '应用外观').click();
  await expect(value(page, 'light', 'color.brand')).toHaveValue('#11aa77');
  await expect(value(page, 'dark', 'color.brand')).toHaveValue('#442266');
  await expect(value(page, 'light', 'color.background')).toHaveValue('#e9f0e7');
});

for (const viewport of [
  { width: 1100, height: 700 },
  { width: 1440, height: 920 },
]) {
  test(`uses the workspace for compact paired colors at ${viewport.width} × ${viewport.height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    const project = fixture();
    for (let row = 0; row < 12; row++) project.theme.tokens[`color.extra${row}`] = '#1267ab';
    await open(page, project);
    const table = appearance(page).getByRole('table', { name: '主题颜色', exact: true });
    const scroll = appearance(page).locator('.appearance-colors-scroll');
    await expect(appearance(page).locator('details')).toHaveJSProperty('open', false);
    await expect(page.locator('.console-panel')).toHaveCount(0);
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: 'Theme', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(table.locator('thead th')).toHaveText(['索引', '亮色', '暗色']);
      const dimensions = await scroll.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const workspace = element.closest('.center-panel')!.getBoundingClientRect();
        const page = element.closest('.appearance-panel')!.getBoundingClientRect();
        const headerBottom = element.querySelector('thead')!.getBoundingClientRect().bottom;
        const rows = Array.from(element.querySelectorAll('tbody tr'));
        return {
          widthRatio: bounds.width / workspace.width,
          heightRatio: bounds.height / page.height,
          height: bounds.height,
          completeRows: rows.filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top >= headerBottom - 1 && rect.bottom <= bounds.bottom + 1;
          }).length,
          compactRows: rows.every((row) => row.getBoundingClientRect().height <= 48),
          hasHorizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        };
      });
      expect(dimensions.widthRatio).toBeGreaterThanOrEqual(0.9);
      expect(dimensions.heightRatio).toBeGreaterThanOrEqual(0.6);
      expect(dimensions.height).toBeGreaterThanOrEqual(viewport.height === 700 ? 340 : 480);
      expect(dimensions.completeRows).toBeGreaterThanOrEqual(viewport.height === 700 ? 6 : 10);
      expect(dimensions.compactRows).toBe(true);
      expect(dimensions.hasHorizontalOverflow).toBe(false);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      const screenshot = info.outputPath(`appearance-colors-${viewport.width}-${theme}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach(`paired appearance ${viewport.width} ${theme}`, {
        path: screenshot,
        contentType: 'image/png',
      });
    }
  });
}

test('hides the runtime console in resource pages while retaining its preference in design and flow pages', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await tab(page, '多语言').click();
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await tab(page, '界面').click();
  await expect(page.locator('.console-panel')).toBeVisible();
  await page.locator('.console-panel > header > button').click();
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await tab(page, '应用外观').click();
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await tab(page, '流程').click();
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await page.locator('.statusbar').getByRole('button', { name: '运行日志', exact: true }).click();
  await expect(page.locator('.console-panel')).toBeVisible();
  await tab(page, '应用外观').click();
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await tab(page, '多语言').click();
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await tab(page, '流程').click();
  await expect(page.locator('.console-panel')).toBeVisible();
});
