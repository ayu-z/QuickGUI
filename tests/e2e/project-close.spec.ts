import { expect, test, type Page } from '@playwright/test';
import { createProject } from '../../src/core/project';

async function askToClose(page: Page) {
  await page.locator('.project-switch').click();
  await page
    .locator('.project-dropdown')
    .getByRole('button', { name: '关闭工程', exact: true })
    .click();
  return page.getByRole('dialog', { name: '关闭当前工程', exact: true });
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
});

test('cancel leaves the project open and close enters a durable empty workspace', async ({
  page,
}) => {
  await page
    .locator('.qg-inspector')
    .getByLabel('文本', { exact: true })
    .fill('Unsaved latest value');
  let dialog = await askToClose(page);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('[data-widget="start_button"] button')).toHaveText(
    'Unsaved latest value',
  );
  dialog = await askToClose(page);
  await dialog.getByRole('button', { name: '保留恢复副本并关闭', exact: true }).click();
  await expect(page.getByTestId('no-project')).toBeVisible();
  await expect(page.getByTestId('design-canvas')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('no-project')).toBeVisible();
  await page.getByRole('button', { name: /恢复上次关闭的工程/ }).click();
  await expect(page.locator('[data-widget="start_button"] button')).toHaveText(
    'Unsaved latest value',
  );
});

test('unapplied CODE drafts survive close, reload and restore', async ({ page }) => {
  await page.locator('.qg-inspector').getByRole('button', { name: 'CODE', exact: true }).click();
  await page
    .locator('.qg-inspector .monaco-editor .view-lines')
    .click({ position: { x: 35, y: 10 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('{"props":{"text":"unfinished"');
  const dialog = await askToClose(page);
  await expect(dialog.getByRole('button', { name: '保存工程并关闭', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '保留恢复副本并关闭', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('no-project')).toContainText('未应用草稿');
  await page.getByRole('button', { name: /恢复上次关闭的工程/ }).click();
  await page.locator('.layer-row').filter({ hasText: '启动循环' }).click();
  await page.locator('.qg-inspector').getByRole('button', { name: 'CODE', exact: true }).click();
  await expect(page.locator('.qg-inspector .monaco-editor')).toContainText('unfinished');
  await expect(page.locator('[data-widget="start_button"] button')).toHaveText('启动循环');
});

test('designer theme survives reload, project close and restore', async ({ page }) => {
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const dialog = await askToClose(page);
  await dialog.getByRole('button', { name: '保留恢复副本并关闭', exact: true }).click();
  await expect(page.getByTestId('no-project')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.getByTestId('no-project')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: /恢复上次关闭的工程/ }).click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('save and close downloads a project and does not silently create another project', async ({
  page,
}) => {
  const dialog = await askToClose(page);
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '保存工程并关闭', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.qgui$/);
  await expect(page.getByTestId('no-project')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('no-project')).toBeVisible();
  await page.getByRole('button', { name: '新建工程', exact: true }).click();
  await page
    .getByRole('dialog', { name: '新建工程', exact: true })
    .getByRole('button', { name: '创建工程', exact: true })
    .click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('.qg-design-widget')).toHaveCount(0);
  await expect(page.locator('.project-switch')).toContainText('未命名工程');
});

test('a future or unknown-field project is rejected without leaving the closed screen', async ({
  page,
}) => {
  const dialog = await askToClose(page);
  await dialog.getByRole('button', { name: '保留恢复副本并关闭', exact: true }).click();
  const project = { ...createProject(), schemaVersion: 99 };
  await page.locator('input[accept=".qgui,.json"]').setInputFiles({
    name: 'future.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByRole('alert')).toContainText('99');
  await expect(page.getByTestId('no-project')).toBeVisible();
  const unknown = { ...createProject(), futureBehavior: { mode: 'new' } };
  await page.locator('input[accept=".qgui,.json"]').setInputFiles({
    name: 'unknown.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(unknown)),
  });
  await expect(page.getByRole('alert')).toContainText('futureBehavior');
  await expect(page.getByTestId('design-canvas')).toHaveCount(0);
});
