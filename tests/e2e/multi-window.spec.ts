import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import type { Project } from '../../src/core/types';

async function addWindow(page: Page, name: string) {
  await page.getByRole('button', { name: '新增窗口', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增窗口', exact: true });
  await dialog.getByLabel('窗口名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '创建窗口', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.locator('.window-manager-row.active');
  await expect(row).toContainText(name);
  return (await row.getAttribute('data-window-id'))!;
}
async function selectWindow(page: Page, id: string) {
  await page.locator(`.window-manager-row[data-window-id="${id}"] .window-select`).click();
}
async function addText(page: Page) {
  await page.locator('.left-tabs').getByRole('button', { name: '控件', exact: true }).click();
  await page.locator('.qg-library').getByRole('button', { name: '文本标签', exact: true }).click();
  return (await page
    .locator('.qg-design-widget.is-selected [data-widget]')
    .getAttribute('data-widget'))!;
}
async function exportedProject(page: Page, info: TestInfo, name: string) {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const downloading = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const download = await downloading,
    filename = info.outputPath(`${name}.qgui`);
  await download.saveAs(filename);
  const files = unzipSync(new Uint8Array(await readFile(filename)));
  return { filename, project: JSON.parse(strFromU8(files['quickgui.json'])) as Project };
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
});

test('creates, configures, renames and round-trips independent scenes with stable IDs', async ({
  page,
}, info) => {
  const originalCount = await page.locator('.qg-design-widget').count();
  const id = await addWindow(page, '设备详情');
  await expect(page.locator('.qg-design-widget')).toHaveCount(0);
  const inspector = page.locator('.qg-window-inspector');
  await inspector.getByLabel('窗口标题', { exact: true }).fill('设备详情运行窗口');
  await inspector.getByLabel('宽度', { exact: true }).fill('760');
  await inspector.getByLabel('高度', { exact: true }).fill('520');
  await page.getByLabel('启动时打开此窗口', { exact: true }).check();
  const widgetId = await addText(page);
  await page.locator('.qg-inspector').getByLabel('文本', { exact: true }).fill('子窗口专属内容');
  await selectWindow(page, 'main');
  await expect(page.locator('.qg-design-widget')).toHaveCount(originalCount);
  await expect(
    page.getByTestId('design-canvas').locator(`[data-widget="${widgetId}"]`),
  ).toHaveCount(0);
  await selectWindow(page, id);
  await expect(page.locator('.qg-design-widget')).toHaveCount(1);
  await expect(page.getByTestId('design-canvas')).toHaveCSS('width', '760px');
  await page.getByRole('button', { name: '重命名窗口 设备详情', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名窗口', exact: true });
  await rename.getByLabel('窗口名称', { exact: true }).fill('参数窗口');
  await rename.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.locator(`.window-manager-row[data-window-id="${id}"]`)).toContainText(
    '参数窗口',
  );
  await expect(page.locator('.qg-artboard-caption')).toContainText('设备详情运行窗口');
  const exported = await exportedProject(page, info, 'multi-window');
  expect(exported.project.schemaVersion).toBe(5);
  expect(exported.project.widgets).toHaveLength(originalCount);
  expect(exported.project.window.title).toBe('泵站控制面板');
  expect(exported.project.windows).toHaveLength(1);
  expect(exported.project.windows![0]).toMatchObject({
    id,
    name: '参数窗口',
    openOnStart: true,
    config: { title: '设备详情运行窗口', width: 760, height: 520 },
  });
  expect(exported.project.windows![0].widgets[0]).toMatchObject({
    id: widgetId,
    props: { text: '子窗口专属内容' },
  });
  await page.locator('input[type="file"][accept=".qgui,.json"]').setInputFiles(exported.filename);
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await selectWindow(page, id);
  await expect(
    page.getByTestId('design-canvas').locator(`[data-widget="${widgetId}"]`),
  ).toContainText('子窗口专属内容');
  await expect(page.getByLabel('启动时打开此窗口', { exact: true })).toBeChecked();
});

test('retains invalid per-widget drafts during switching and protects deletion before undo/redo', async ({
  page,
}) => {
  const id = await addWindow(page, '草稿窗口');
  await addText(page);
  let inspector = page.locator('.qg-inspector');
  await inspector.getByRole('button', { name: 'CODE', exact: true }).click();
  await inspector.locator('.monaco-editor .view-lines').click({ position: { x: 35, y: 10 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('{"props":{"text":"unfinished child"');
  await selectWindow(page, 'main');
  await selectWindow(page, id);
  await page.locator('.qg-design-widget').first().click();
  inspector = page.locator('.qg-inspector');
  await inspector.getByRole('button', { name: 'CODE', exact: true }).click();
  await expect(inspector.locator('.monaco-editor')).toContainText('unfinished child');
  await page.getByRole('button', { name: '删除窗口 草稿窗口', exact: true }).click();
  let deleting = page.getByRole('dialog', { name: '删除窗口', exact: true });
  await deleting.getByRole('button', { name: '删除窗口', exact: true }).click();
  await expect(deleting.getByRole('alert')).toContainText('CODE');
  await expect(page.locator(`.window-manager-row[data-window-id="${id}"]`)).toBeVisible();
  await deleting.getByRole('button', { name: '取消', exact: true }).click();
  await inspector.getByRole('button', { name: '还原草稿', exact: true }).click();
  await page.getByRole('button', { name: '删除窗口 草稿窗口', exact: true }).click();
  deleting = page.getByRole('dialog', { name: '删除窗口', exact: true });
  await deleting.getByRole('button', { name: '删除窗口', exact: true }).click();
  await expect(page.locator(`.window-manager-row[data-window-id="${id}"]`)).toHaveCount(0);
  await expect(page.locator('.window-manager-row.active')).toHaveAttribute(
    'data-window-id',
    'main',
  );
  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
  await selectWindow(page, id);
  await expect(page.locator('.qg-design-widget')).toHaveCount(1);
  await page.locator('.workspace-tools').getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.window-manager-row.active')).toHaveAttribute(
    'data-window-id',
    'main',
  );
  await expect(page.locator(`.window-manager-row[data-window-id="${id}"]`)).toHaveCount(0);
});

test('keeps module insertion and editing scoped to the selected window and protects child-only bindings', async ({
  page,
}) => {
  const mainWidgetCount = await page.locator('.qg-design-widget').count();
  await page.locator('.left-tabs').getByRole('button', { name: '模块', exact: true }).click();
  await page.getByRole('button', { name: '从选中控件创建', exact: true }).click();
  await page.locator('.module-card').getByRole('button', { name: '编辑定义', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出模块定义', exact: true })).toBeVisible();
  const id = await addWindow(page, '模块窗口');
  await expect(page.getByRole('button', { name: '退出模块定义', exact: true })).toHaveCount(0);
  await page.locator('.module-card').getByRole('button', { name: '添加实例', exact: true }).click();
  await expect(page.locator('.qg-design-widget')).toHaveCount(1);
  await selectWindow(page, 'main');
  await expect(page.locator('.qg-design-widget')).toHaveCount(mainWidgetCount);
  await selectWindow(page, id);
  await page.locator('.module-card').getByRole('button', { name: '编辑定义', exact: true }).click();
  await page.locator('.qg-inspector').getByLabel('字号', { exact: true }).fill('22');
  await page
    .locator('.workspace-tools')
    .getByRole('button', { name: '窗口属性', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '退出模块定义', exact: true })).toHaveCount(0);
  await expect(
    page.locator('.qg-window-inspector').getByLabel('窗口标题', { exact: true }),
  ).toHaveValue('模块窗口');
  await expect(page.getByTestId('design-canvas').locator('.qg-type-button')).toHaveCSS(
    'font-size',
    '22px',
  );
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '数据', exact: true })
    .click();
  await page.getByRole('button', { name: '添加变量', exact: true }).click();
  await page
    .locator('.data-table tbody tr')
    .last()
    .locator('td')
    .nth(1)
    .locator('select')
    .selectOption('string');
  await page
    .locator('.data-table tbody tr')
    .last()
    .locator('td')
    .first()
    .locator('input')
    .fill('childOnly');
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '界面', exact: true })
    .click();
  await page.locator('.qg-design-widget').first().click();
  const inspector = page.locator('.qg-inspector');
  await inspector.locator('.qg-add-binding select').selectOption('text');
  await inspector
    .locator('.qg-add-binding')
    .getByRole('button', { name: '绑定', exact: true })
    .click();
  await inspector
    .getByRole('combobox', { name: '绑定变量', exact: true })
    .selectOption({ label: 'childOnly · string' });
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '数据', exact: true })
    .click();
  await page
    .locator('.data-table tbody tr')
    .last()
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('请先移除该变量的绑定和节点引用');
  await expect(
    page.locator('.data-table tbody tr').last().locator('td').first().locator('input'),
  ).toHaveValue('childOnly');
});

test('previews the selected child and shares one live value across independent windows', async ({
  page,
}) => {
  const id = await addWindow(page, '状态窗口');
  await page.locator('.qg-window-inspector').getByLabel('宽度', { exact: true }).fill('640');
  await page.locator('.qg-window-inspector').getByLabel('高度', { exact: true }).fill('420');
  const widgetId = await addText(page);
  const inspector = page.locator('.qg-inspector');
  await inspector.locator('.qg-add-binding select').selectOption('text');
  await inspector
    .locator('.qg-add-binding')
    .getByRole('button', { name: '绑定', exact: true })
    .click();
  await inspector.getByRole('combobox', { name: '绑定变量', exact: true }).selectOption('cycles');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal'),
    child = preview.locator(`[data-runtime-window-id="${id}"]`);
  await expect(preview.locator('[data-runtime-window-id="main"]')).toBeVisible();
  await expect(child).toBeVisible();
  await expect(child.locator(`[data-widget="${widgetId}"]`)).toHaveText('0');
  const beforeDrag = (await child.boundingBox())!;
  const titleBar = (await child.locator(':scope > header').boundingBox())!;
  await page.mouse.move(titleBar.x + 140, titleBar.y + titleBar.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBar.x + 250, titleBar.y + titleBar.height / 2 + 65, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await child.boundingBox())!.x).toBeGreaterThan(beforeDrag.x + 90);
  await expect.poll(async () => (await child.boundingBox())!.y).toBeGreaterThan(beforeDrag.y + 50);
  await preview.getByRole('button', { name: '打开窗口 泵站控制面板', exact: true }).click();
  await preview
    .locator('[data-runtime-window-id="main"]')
    .getByRole('button', { name: '启动循环', exact: true })
    .click();
  await expect(child.locator(`[data-widget="${widgetId}"]`)).toHaveText('1');
  await preview.getByRole('button', { name: '打开窗口 状态窗口', exact: true }).click();
  await child.getByRole('button', { name: '关闭窗口 状态窗口', exact: true }).click();
  await expect(child).toHaveCount(0);
  await expect(
    preview.locator('[data-runtime-window-id="main"] [data-widget="cycles"]'),
  ).toContainText('1');
  await preview.getByRole('button', { name: '打开窗口 状态窗口', exact: true }).click();
  await expect(child.locator(`[data-widget="${widgetId}"]`)).toHaveText('1');
  await page.screenshot({ path: 'artifacts/multi-window-preview.png', fullPage: true });
});

test('configures real window flow nodes, protects references and opens and closes a child from control events', async ({
  page,
}, info) => {
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: '窗口操作', exact: true })
    .click();
  const windowNode = page.locator('.react-flow__node').filter({ hasText: '窗口操作' });
  const nodeId = (await windowNode.getAttribute('data-id'))!;
  const settings = page.locator('.qg-flow-settings');
  await settings.getByRole('combobox', { name: '目标窗口', exact: true }).selectOption('main');
  await settings.getByRole('combobox', { name: '窗口操作', exact: true }).selectOption('focus');
  const initialEdges = await page.locator('.react-flow__edge').count();
  await page
    .locator('.react-flow__node[data-id="log-cycle"] [data-handleid="output"]')
    .dragTo(windowNode.locator('[data-handleid="input"]'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(initialEdges + 1);
  const upgraded = await exportedProject(page, info, 'window-node-upgrades-schema');
  expect(upgraded.project.schemaVersion).toBe(5);
  expect(upgraded.project.windows).toEqual([]);
  expect(upgraded.project.flows[0].nodes.find((node) => node.id === nodeId)?.config).toEqual({
    action: 'focus',
    windowId: 'main',
  });
  expect(upgraded.project.flows[0].edges).toContainEqual(
    expect.objectContaining({ source: 'log-cycle', target: nodeId }),
  );

  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '界面', exact: true })
    .click();
  const childId = await addWindow(page, '流程目标窗口');
  await page.locator('.qg-window-inspector').getByLabel('宽度', { exact: true }).fill('640');
  await page.locator('.qg-window-inspector').getByLabel('高度', { exact: true }).fill('420');
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
  await settings.getByRole('combobox', { name: '目标窗口', exact: true }).selectOption(childId);
  await settings.getByRole('combobox', { name: '窗口操作', exact: true }).selectOption('open');
  await expect(page.locator('.qg-flow-card.selected')).toContainText(`open · ${childId}`);

  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '界面', exact: true })
    .click();
  await page.getByRole('button', { name: '删除窗口 流程目标窗口', exact: true }).click();
  const deleting = page.getByRole('dialog', { name: '删除窗口', exact: true });
  await deleting.getByRole('button', { name: '删除窗口', exact: true }).click();
  await expect(deleting.getByRole('alert')).toContainText('启动循环');
  await expect(page.locator(`.window-manager-row[data-window-id="${childId}"]`)).toBeVisible();
  await deleting.getByRole('button', { name: '取消', exact: true }).click();
  await selectWindow(page, 'main');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  const child = preview.locator(`[data-runtime-window-id="${childId}"]`);
  await expect(child).toHaveCount(0);
  await preview
    .locator('[data-runtime-window-id="main"]')
    .getByRole('button', { name: '启动循环', exact: true })
    .click();
  await expect(child).toBeVisible();
  await expect(
    preview.locator('[data-runtime-window-id="main"] [data-widget="cycles"]'),
  ).toContainText('1');
  await preview
    .locator(':scope > header')
    .getByRole('button', { name: '关闭', exact: true })
    .click();

  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
  await settings.getByRole('combobox', { name: '窗口操作', exact: true }).selectOption('close');
  const exported = await exportedProject(page, info, 'close-window-node');
  expect(exported.project.schemaVersion).toBe(5);
  expect(exported.project.windows![0].id).toBe(childId);
  expect(exported.project.flows[0].nodes.find((node) => node.id === nodeId)).toMatchObject({
    kind: 'window',
    config: { action: 'close', windowId: childId },
  });
  expect(exported.project.flows[0].edges).toContainEqual(
    expect.objectContaining({ source: 'log-cycle', target: nodeId }),
  );
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(child).toBeVisible();
  await preview
    .locator('[data-runtime-window-id="main"]')
    .getByRole('button', { name: '启动循环', exact: true })
    .click();
  await expect(child).toHaveCount(0);
  await expect(
    preview.locator('[data-runtime-window-id="main"] [data-widget="cycles"]'),
  ).toContainText('2');
});
