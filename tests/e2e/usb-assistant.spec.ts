import { expect, test } from '@playwright/test';

test('USB example opens from the welcome screen and browser preview reports native capability', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.project-switch').click();
  await page
    .locator('.project-dropdown')
    .getByRole('button', { name: '关闭工程', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '打开 USB 助手示例', exact: true }).click();
  await expect(page.locator('.project-switch')).toHaveText('USB 助手');
  await expect(page.locator('[data-design-widget="usb_payload"]')).toBeVisible();
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  await expect(page.getByLabel('选择流程', { exact: true }).locator('option')).toHaveCount(1);
  const communication = page.locator('.react-flow__node[data-id="usb_io"]');
  for (const port of ['open', 'close', 'send', 'rx', 'tx', 'state'])
    await expect(communication.locator(`[data-handleid="${port}"]`)).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/usb-integrated-flow.png', fullPage: true });
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '界面', exact: true })
    .click();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await expect(preview.locator('[data-widget="usb_payload"] input')).toHaveValue('01 02 03');
  await expect(preview.locator('[data-widget="usb_state"]')).toContainText('closed');
  await preview.locator('[data-widget="usb_scan"] button').click();
  await expect(preview.locator('[data-widget="usb_diagnostic"]')).toContainText(/desktop|桌面/i);
  await expect(preview.locator('[data-widget="usb_select"] option')).toHaveCount(1);
  await expect(preview.locator('[data-widget="usb_received"] textarea')).toHaveValue('');
  await page.screenshot({ path: 'artifacts/usb-assistant-preview.png', fullPage: true });
});
