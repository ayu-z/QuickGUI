import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import type { Project } from '../../src/core/types';

async function projectMenuAction(page: Page, name: string) {
  await page.locator('.project-switch').click();
  await page.locator('.project-dropdown').getByRole('button', { name, exact: true }).click();
}

async function closeToWelcome(page: Page) {
  await projectMenuAction(page, '关闭工程');
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.getByTestId('no-project')).toBeVisible();
}

async function exportOriginal(page: Page, testInfo: TestInfo, artifact: string) {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const downloaded = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const download = await downloaded;
  const destination = testInfo.outputPath(`${artifact}.qgui`);
  await download.saveAs(destination);
  const files = unzipSync(new Uint8Array(await readFile(destination)));
  expect(files['quickgui.json']).toBeDefined();
  return {
    filename: download.suggestedFilename(),
    project: JSON.parse(strFromU8(files['quickgui.json'])) as Project,
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
});

test('naming keeps keyboard focus inside the dialog and supports header Escape and valid Enter', async ({
  page,
}) => {
  const originalName = await page.locator('.project-switch').innerText();
  await projectMenuAction(page, '新建工程');
  let dialog = page.getByRole('dialog', { name: '新建工程', exact: true });
  await expect(dialog.getByLabel('工程名称', { exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '取消命名', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '创建工程', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '取消命名', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-switch')).toHaveText(originalName);

  await projectMenuAction(page, '新建工程');
  dialog = page.getByRole('dialog', { name: '新建工程', exact: true });
  const input = dialog.getByLabel('工程名称', { exact: true });
  await input.fill('a'.repeat(201));
  await expect(dialog.getByRole('button', { name: '创建工程', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('200');
  await input.press('Tab');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '取消命名', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();

  await input.fill('  键盘创建工程  ');
  await input.press('Enter');
  const closing = page.getByRole('dialog', { name: '关闭当前工程', exact: true });
  await expect(closing).toBeVisible();
  await expect(page.locator('.project-switch')).toHaveText(originalName);
  await closing.getByRole('button', { name: '保留恢复副本并关闭', exact: true }).click();
  await expect(page.locator('.project-switch')).toHaveText('键盘创建工程');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
});

test('welcome creation rejects blank names, can be cancelled and creates the chosen project', async ({
  page,
}, testInfo) => {
  await closeToWelcome(page);
  await page.getByRole('button', { name: '新建工程', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新建工程', exact: true });
  await expect(dialog.getByLabel('工程名称', { exact: true })).toHaveValue('未命名工程');
  for (const blank of ['', '   ']) {
    await dialog.getByLabel('工程名称', { exact: true }).fill(blank);
    await dialog.getByLabel('工程名称', { exact: true }).press('Enter');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('no-project')).toBeVisible();
    await expect(page.getByTestId('design-canvas')).toHaveCount(0);
  }
  await dialog.getByLabel('工程名称', { exact: true }).fill('取消的新工程');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('no-project')).toBeVisible();

  await page.getByRole('button', { name: '新建工程', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新建工程', exact: true });
  await dialog.getByLabel('工程名称', { exact: true }).fill('产线 A HMI');
  await dialog.getByRole('button', { name: '创建工程', exact: true }).click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('.qg-design-widget')).toHaveCount(0);
  await expect(page.locator('.project-switch')).toHaveText('产线 A HMI');
  const exported = await exportOriginal(page, testInfo, 'welcome-created');
  expect(exported.filename).toBe('产线 A HMI.qgui');
  expect(exported.project.name).toBe('产线 A HMI');
});

test('the project menu names a new project before replacing the current project', async ({
  page,
}, testInfo) => {
  const initial = await exportOriginal(page, testInfo, 'before-menu-create');
  const originalWidgetCount = await page.locator('.qg-design-widget').count();
  await projectMenuAction(page, '新建工程');
  let dialog = page.getByRole('dialog', { name: '新建工程', exact: true });
  await dialog.getByLabel('工程名称', { exact: true }).fill('不创建的项目');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.project-switch')).toHaveText(initial.project.name);
  await expect(page.locator('.qg-design-widget')).toHaveCount(originalWidgetCount);
  await expect(page.getByRole('dialog', { name: '关闭当前工程', exact: true })).toHaveCount(0);

  await projectMenuAction(page, '新建工程');
  dialog = page.getByRole('dialog', { name: '新建工程', exact: true });
  await dialog.getByLabel('工程名称', { exact: true }).fill('设备维护工程');
  await dialog.getByRole('button', { name: '创建工程', exact: true }).click();
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.locator('.project-switch')).toHaveText('设备维护工程');
  await expect(page.locator('.qg-design-widget')).toHaveCount(0);
  const created = await exportOriginal(page, testInfo, 'menu-created');
  expect(created.filename).toBe('设备维护工程.qgui');
  expect(created.project.name).toBe('设备维护工程');
  expect(created.project.id).not.toBe(initial.project.id);
});

test('renaming updates the project name, export and recovery while preserving independent identity and app names', async ({
  page,
}, testInfo) => {
  await page
    .locator('.workspace-tools')
    .getByRole('button', { name: '窗口属性', exact: true })
    .click();
  const windowInspector = page.locator('.qg-window-inspector');
  await windowInspector.getByLabel('窗口标题', { exact: true }).fill('运行窗口标题');
  await windowInspector.getByRole('button', { name: '发布', exact: true }).click();
  await windowInspector.getByLabel('应用名称', { exact: true }).fill('Station Application');
  const original = await exportOriginal(page, testInfo, 'before-rename');

  await projectMenuAction(page, '重命名工程');
  let dialog = page.getByRole('dialog', { name: '重命名工程', exact: true });
  await expect(dialog.getByLabel('工程名称', { exact: true })).toHaveValue(original.project.name);
  await dialog.getByLabel('工程名称', { exact: true }).fill('   ');
  await dialog.getByLabel('工程名称', { exact: true }).press('Enter');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.project-switch')).toHaveText(original.project.name);
  await dialog.getByLabel('工程名称', { exact: true }).fill('取消的工程名');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.project-switch')).toHaveText(original.project.name);

  await projectMenuAction(page, '重命名工程');
  dialog = page.getByRole('dialog', { name: '重命名工程', exact: true });
  await dialog.getByLabel('工程名称', { exact: true }).fill('一级泵站工程');
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-switch')).toHaveText('一级泵站工程');
  await expect(page.locator('.qg-artboard-caption')).toContainText('运行窗口标题');
  await expect(windowInspector.getByLabel('应用名称', { exact: true })).toHaveValue(
    'Station Application',
  );
  const renamed = await exportOriginal(page, testInfo, 'renamed');
  expect(renamed.filename).toBe('一级泵站工程.qgui');
  expect(renamed.project.name).toBe('一级泵站工程');
  expect(renamed.project.id).toBe(original.project.id);
  expect(renamed.project.window).toEqual(original.project.window);
  expect(renamed.project.publish).toEqual(original.project.publish);
  expect(renamed.project.widgets).toEqual(original.project.widgets);

  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.project-switch')).toHaveText('一级泵站工程');
  await closeToWelcome(page);
  await page.reload();
  await expect(page.getByTestId('no-project')).toContainText('一级泵站工程');
  await page.getByRole('button', { name: /恢复上次关闭的工程/ }).click();
  await expect(page.locator('.project-switch')).toHaveText('一级泵站工程');
  const restored = await exportOriginal(page, testInfo, 'restored-rename');
  expect(restored.project.name).toBe('一级泵站工程');
  expect(restored.project.id).toBe(original.project.id);
  expect(restored.project.window).toEqual(original.project.window);
  expect(restored.project.publish).toEqual(original.project.publish);
});
