import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const packagePath = path.resolve('artifacts/status-card.qgcomponent');
test.beforeAll(() => {
  execFileSync(
    process.execPath,
    ['scripts/build-component.mjs', 'examples/components/status-card', packagePath],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
});

test('compiled TSX package imports with consent and renders reactive props and declared events', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.locator('.left-tabs').getByRole('button', { name: '模块', exact: true }).click();
  await page.locator('input[type="file"][accept=".qgcomponent"]').setInputFiles(packagePath);
  await expect(page.locator('.settings-modal')).toContainText('导入代码组件');
  await expect(page.locator('.settings-modal')).toContainText('不限制代码权限');
  await expect(page.locator('[data-qg-component]')).toHaveCount(0);
  await page.getByRole('button', { name: '信任并导入', exact: true }).click();
  await page.locator('.module-card').getByRole('button', { name: '添加实例', exact: true }).click();
  const design = page.locator(
    '[data-testid="design-canvas"] [data-qg-component="quickgui.status-card"]',
  );
  await expect(design.locator('.status-card')).toBeVisible();
  await expect(design.locator('.status-card')).toHaveCSS('background-color', 'rgb(32, 35, 44)');
  expect(
    await design
      .locator('.status-card')
      .evaluate((element) => element.getRootNode() instanceof ShadowRoot),
  ).toBe(true);
  await expect(design.locator('header')).toContainText('Production cell');
  await expect(design.locator('.reading strong')).toHaveText('12');
  await expect(design.getByRole('button', { name: /启动循环/ })).toBeDisabled();
  const inspector = page.locator('.qg-inspector');
  await inspector.getByLabel('标签', { exact: true }).fill('Edited module');
  await inspector.getByLabel('数值 / 内容', { exact: true }).fill('27');
  await expect(design.locator('header')).toContainText('Edited module');
  await expect(design.locator('.reading strong')).toHaveText('27');
  await inspector
    .getByRole('combobox', { name: 'onAdvance', exact: true })
    .selectOption('start-cycle');
  await inspector
    .locator('.qg-add-binding')
    .getByRole('button', { name: '绑定', exact: true })
    .click();
  await inspector.getByRole('combobox', { name: '绑定变量', exact: true }).selectOption('cycles');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const runtime = page.locator('.preview-modal [data-qg-component="quickgui.status-card"]');
  await expect(runtime.locator('.reading strong')).toHaveText('0');
  await runtime.getByRole('button', { name: /启动循环/ }).click();
  await expect(runtime.locator('.reading strong')).toHaveText('1');
  await expect(runtime.locator('footer')).toContainText('本地点击: 1');
  await runtime.getByRole('button', { name: /启动循环/ }).click();
  await expect(runtime.locator('.reading strong')).toHaveText('2');
  await expect(runtime.locator('footer')).toContainText('本地点击: 2');
  await expect(page.locator('.preview-modal [data-widget="cycles"]')).toContainText('2');
  await page.screenshot({ path: 'artifacts/react-component-preview.png', fullPage: true });
  await page.locator('.preview-modal').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await expect(design.getByRole('button', { name: /Advance cycle/ })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page
    .locator('.module-card')
    .getByRole('button', { name: 'Export package', exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.qgcomponent$/);
  expect(errors).toEqual([]);
});
