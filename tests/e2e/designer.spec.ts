import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid="design-canvas"]')).toBeVisible();
});

async function replaceCode(page: Page, source: string) {
  const editor = page.locator('.qg-inspector .monaco-editor textarea').first();
  await expect(editor).toBeAttached();
  await page
    .locator('.qg-inspector .monaco-editor .view-lines')
    .click({ position: { x: 35, y: 10 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.qg-inspector .monaco-editor .view-lines')).toHaveText('');
  await page.keyboard.insertText(source);
}

test('drag from the library, move and resize a real widget', async ({ page }) => {
  const canvas = page.getByTestId('design-canvas');
  const before = await canvas.locator('.qg-design-widget').count();
  await page.locator('.left-tabs').getByRole('button', { name: '控件', exact: true }).click();
  await page
    .locator('.qg-library')
    .getByRole('button', { name: '操作按钮', exact: true })
    .dragTo(canvas, { targetPosition: { x: 240, y: 350 } });
  await expect(canvas.locator('.qg-design-widget')).toHaveCount(before + 1);
  const selected = canvas.locator('.qg-design-widget.is-selected');
  const firstLeft = await selected.evaluate((element) =>
    parseFloat((element as HTMLElement).style.left),
  );
  let box = (await selected.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 48, box.y + box.height / 2 + 24, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => selected.evaluate((element) => parseFloat((element as HTMLElement).style.left)))
    .toBeGreaterThan(firstLeft);
  const firstWidth = await selected.evaluate((element) =>
    parseFloat((element as HTMLElement).style.width),
  );
  box = (await selected.locator('.qg-resize-handle').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 16, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() => selected.evaluate((element) => parseFloat((element as HTMLElement).style.width)))
    .toBeGreaterThan(firstWidth);
});

test('CODE rejects out-of-scope edits and preserves drafts while UI changes', async ({ page }) => {
  const inspector = page.locator('.qg-inspector');
  await inspector.getByRole('button', { name: 'CODE', exact: true }).click();
  const invalid = '{"props":{"text":"UNAPPLIED"},"style":{},"states":{},"layout":{"x":10}}';
  await replaceCode(page, invalid);
  await inspector.getByRole('button', { name: '应用代码', exact: true }).click();
  await expect(inspector.getByRole('alert')).toBeVisible();
  await expect(inspector.getByRole('alert')).toContainText('layout');
  await expect(page.locator('[data-widget="start_button"] button')).toHaveText('启动循环');
  await inspector.getByRole('button', { name: '属性', exact: true }).click();
  await inspector.getByLabel('文本', { exact: true }).fill('UI safe edit');
  await page.locator('.layer-row').filter({ hasText: '页面标题' }).click();
  await page.locator('.layer-row').filter({ hasText: '启动循环' }).click();
  await inspector.getByRole('button', { name: 'CODE', exact: true }).click();
  await expect(inspector.locator('.monaco-editor')).toContainText('UNAPPLIED');
  await inspector.getByRole('button', { name: '还原草稿', exact: true }).click();
  await expect(inspector.locator('.monaco-editor')).toContainText('UI safe edit');
  await replaceCode(
    page,
    '{"props":{"text":"CODE APPLIED","enabled":true,"visible":true},"style":{"background":"#2563eb","color":"#ffffff"},"states":{"hover":{"background":"#1d4ed8"}}}',
  );
  await inspector.getByRole('button', { name: '应用代码', exact: true }).click();
  await expect(inspector.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('[data-widget="start_button"] button')).toHaveText('CODE APPLIED');
  await expect(page.locator('[data-widget="start_button"]')).toHaveCSS(
    'background-color',
    'rgb(37, 99, 235)',
  );
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page
    .locator('.preview-modal')
    .getByRole('button', { name: 'CODE APPLIED', exact: true })
    .click();
  await expect(page.locator('.preview-modal [data-widget="cycles"]')).toContainText('1');
});

test('flow nodes can be added, configured, connected and removed', async ({ page }) => {
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(5);
  const initialEdges = await page.locator('.react-flow__edge').count();
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: '条件判断', exact: true })
    .click();
  await expect(nodes).toHaveCount(6);
  await page
    .locator('.qg-flow-settings')
    .getByRole('combobox', { name: '比较运算符', exact: true })
    .selectOption('gte');
  await page.locator('.qg-flow-settings').getByLabel('比较值', { exact: true }).fill('10');
  await expect(page.locator('.qg-flow-card.selected')).toContainText('gte 10');
  const source = page.locator('.react-flow__node[data-id="log-cycle"] [data-handleid="output"]');
  const target = page
    .locator('.react-flow__node')
    .filter({ hasText: '条件判断' })
    .locator('[data-handleid="input"]');
  await source.dragTo(target);
  await expect(page.locator('.react-flow__edge')).toHaveCount(initialEdges + 1);
  await page
    .locator('.qg-flow-settings')
    .getByRole('button', { name: '删除节点', exact: true })
    .click();
  await expect(nodes).toHaveCount(5);
  await expect(page.locator('.react-flow__edge')).toHaveCount(initialEdges);
  await page.getByRole('button', { name: '新增流程', exact: true }).click();
  await expect(nodes).toHaveCount(1);
  await expect(page.locator('.qg-flow-toolbar select')).toHaveValue(/.+/);
  await nodes.first().click();
  await page
    .locator('.qg-flow-settings')
    .getByRole('combobox', { name: '触发方式', exact: true })
    .selectOption('interval');
  await page.locator('.qg-flow-settings').getByLabel('间隔（毫秒）', { exact: true }).fill('250');
  await expect(page.locator('.qg-flow-card.selected')).toContainText('250 ms');
  await page
    .locator('.qg-flow-settings')
    .getByRole('combobox', { name: '触发方式', exact: true })
    .selectOption('startup');
  await expect(page.locator('.qg-flow-card.selected')).toContainText('运行时启动');
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: '设备请求', exact: true })
    .click();
  await expect(nodes).toHaveCount(2);
  await expect(
    page
      .locator('.qg-flow-settings')
      .getByRole('combobox', { name: '设备或服务连接', exact: true }),
  ).toBeVisible();
});

test('preview uses event bindings and live runtime values', async ({ page }) => {
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await expect(preview.locator('[data-widget="cycles"]')).toContainText('0');
  await preview.getByRole('button', { name: '启动循环', exact: true }).click();
  await expect(preview.locator('[data-widget="cycles"]')).toContainText('1');
  await preview.getByRole('button', { name: '启动循环', exact: true }).click();
  await expect(preview.locator('[data-widget="cycles"]')).toContainText('2');
  await preview.locator('[data-widget="power"] input').check();
  await expect(preview.locator('[data-widget="power"] input')).toBeChecked();
  await expect(page.locator('.console-content')).toContainText('Cycle completed');
  await page.screenshot({ path: 'artifacts/preview-runtime.png', fullPage: true });
});

test('window metadata, local icon and platform capability note are editable', async ({ page }) => {
  await page
    .locator('.workspace-tools')
    .getByRole('button', { name: '窗口属性', exact: true })
    .click();
  const inspector = page.locator('.qg-window-inspector');
  await expect(inspector).toBeVisible();
  await inspector.getByLabel('窗口标题', { exact: true }).fill('Workshop HMI');
  await expect(page.locator('.qg-artboard-caption')).toContainText('Workshop HMI');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  await inspector
    .locator('input[type="file"]')
    .setInputFiles({ name: 'app-icon.png', mimeType: 'image/png', buffer: png });
  await expect(inspector.locator('.qg-icon-preview img')).toBeVisible();
  await inspector
    .getByRole('combobox', { name: '原生窗口圆角偏好', exact: true })
    .selectOption('round');
  await expect(inspector.locator('.qg-info-note')).toContainText('仅在支持的平台生效');
  await inspector.getByRole('button', { name: '发布', exact: true }).click();
  await inspector.getByLabel('应用名称', { exact: true }).fill('Workshop HMI');
  await expect(inspector.getByLabel('应用名称', { exact: true })).toHaveValue('Workshop HMI');
});

test('theme and language controls update the whole designer', async ({ page }) => {
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.qg-inspector')).toContainText('Properties');
  await page.locator('.left-tabs').getByRole('button', { name: 'Widgets', exact: true }).click();
  await expect(page.locator('.qg-library')).toContainText('Button');
  await page.screenshot({ path: 'artifacts/designer-light-english.png', fullPage: true });
});

test('original project export and import round-trip edited widget content', async ({
  page,
}, testInfo) => {
  await page.locator('.qg-inspector').getByLabel('文本', { exact: true }).fill('Round-trip button');
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const downloaded = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.qgui$/);
  const projectPath = testInfo.outputPath('roundtrip.qgui');
  await download.saveAs(projectPath);
  await page.locator('.qg-inspector').getByLabel('文本', { exact: true }).fill('Temporary edit');
  await page.locator('input[type="file"][accept=".qgui,.json"]').setInputFiles(projectPath);
  await page
    .getByRole('dialog', { name: '关闭当前工程' })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.locator('[data-widget="start_button"] button')).toHaveText('Round-trip button');
});
