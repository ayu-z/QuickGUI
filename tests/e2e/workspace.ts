import { expect, type Page } from '@playwright/test';

export async function projectManagement(page: Page) {
  const en = (await page.locator('html').getAttribute('lang')) === 'en';
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: en ? 'Project settings' : '项目配置', exact: true })
    .click();
  const management = page.getByRole('region', {
    name: en ? 'Project management' : '工程管理',
    exact: true,
  });
  await expect(management).toBeVisible();
  return management;
}

export async function currentProjectName(page: Page) {
  return (await page.locator('.statusbar .status-project').getAttribute('title'))!;
}

export async function expectProjectName(page: Page, name: string) {
  await expect(page.locator('.statusbar .status-project')).toHaveAttribute('title', name);
}

export async function openPreviewDebug(page: Page) {
  const en = (await page.locator('html').getAttribute('lang')) === 'en';
  const preview = page.locator('.preview-modal');
  if (!(await preview.count())) await page.locator('.preview-button').click();
  const toggle = preview.getByRole('button', {
    name: en ? 'Preview debug' : '预览调试',
    exact: true,
  });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const console = preview.locator('.console-panel');
  await expect(console).toBeVisible();
  return console;
}

export async function closePreview(page: Page) {
  const en = (await page.locator('html').getAttribute('lang')) === 'en';
  await page
    .locator('.preview-modal > header')
    .getByRole('button', { name: en ? 'Close' : '关闭', exact: true })
    .click();
  await expect(page.locator('.preview-modal')).toHaveCount(0);
}
