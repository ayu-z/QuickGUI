import { openPreviewDebug } from './workspace';
import { expectProjectName } from './workspace';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import type { Project } from '../../src/core/types';
const fixture = JSON.parse(
  readFileSync('crates/quickgui-engine/tests/fixtures/function-blocks.json', 'utf8'),
) as Project;

async function flows(page: Page) {
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
}
async function exported(page: Page, info: TestInfo, label: string): Promise<Project> {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const pending = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const path = info.outputPath(`${label}.qgui`);
  await (await pending).saveAs(path);
  return JSON.parse(strFromU8(unzipSync(new Uint8Array(await readFile(path)))['quickgui.json']));
}
async function openFixture(page: Page) {
  const p = { ...structuredClone(fixture), locale: 'zh-CN' };
  await page.locator('input[accept=".qgui,.json"]').setInputFiles({
    name: 'fb.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(p)),
  });
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expectProjectName(page, p.name);
  await flows(page);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
});

test('USB and serial expose two FBs and USB commands have independent execution inputs', async ({
  page,
}) => {
  await flows(page);
  const palette = page.locator('.qg-node-palette');
  for (const label of ['串口 设备发现', '串口 通信', 'USB 设备发现', 'USB 通信'])
    await expect(palette.getByRole('button', { name: label, exact: true })).toBeVisible();
  await expect(palette.getByRole('button', { name: '扫描串口', exact: true })).toHaveCount(0);
  await palette.getByRole('button', { name: 'USB 通信', exact: true }).click();
  const block = page.locator('.react-flow__node.selected');
  for (const command of ['open', 'close', 'send', 'featureSend', 'featureGet', 'descriptor'])
    await expect(block.locator(`.target[data-handleid="${command}"]`)).toHaveCount(1);
  for (const port of ['rx', 'tx', 'state', 'error'])
    await expect(block.locator(`.source[data-handleid="${port}"]`)).toHaveCount(1);
  const open = await block.locator('[data-handleid="open"]').boundingBox();
  const close = await block.locator('[data-handleid="close"]').boundingBox();
  expect(close!.y - open!.y).toBeGreaterThan(10);
});

test('new projects use current FB ports and node edits undo without downgrading', async ({
  page,
}, info) => {
  const before = await exported(page, info, 'before');
  expect(before.schemaVersion).toBe(5);
  expect(before.flows[0].nodes.every((node) => node.block?.version === 1)).toBe(true);
  await flows(page);
  const node = page.locator('.react-flow__node[data-id="increment"]');
  await node.click();
  await expect(node.locator('.target')).toHaveCount(3);
  await expect(node.locator('.source')).toHaveCount(3);
  await expect(page.getByRole('dialog', { name: '升级工程与控件', exact: true })).toHaveCount(0);
  await page.getByLabel('input-0-name', { exact: true }).fill('LEFT');
  await page.getByRole('button', { name: '应用端口', exact: true }).click();
  const saved = await exported(page, info, 'edited');
  expect(saved.schemaVersion).toBe(5);
  expect(saved.flows[0].edges).toEqual(before.flows[0].edges);
  expect(saved.flows[0].nodes.find((n) => n.id === 'increment')!.block!.inputs[0].name).toBe(
    'LEFT',
  );
  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
  const restored = await exported(page, info, 'undo');
  expect(restored.schemaVersion).toBe(5);
  expect(restored.flows).toEqual(before.flows);
});

test('named ports remain distinct, data wires can fan out and reject execution/type mismatches', async ({
  page,
}, info) => {
  await openFixture(page);
  const source = page.locator('.react-flow__node[data-id="add"] [data-handleid="data-out:q"]');
  const inputA = page.locator('.react-flow__node[data-id="add"] [data-handleid="data-in:a"]');
  const inputB = page.locator('.react-flow__node[data-id="add"] [data-handleid="data-in:b"]');
  const a = await inputA.boundingBox(),
    b = await inputB.boundingBox();
  expect(a).toBeTruthy();
  expect(b!.y - a!.y).toBeGreaterThan(10);
  const count = await page.locator('.react-flow__edge').count();
  await source.dragTo(page.locator('.react-flow__node[data-id="save"] [data-handleid="input"]'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(count);
  await page.locator('.react-flow__node[data-id="add"]').click();
  await page.getByLabel('input-0-name', { exact: true }).fill('LEFT');
  await page.getByRole('button', { name: '应用端口', exact: true }).click();
  await expect(inputA).toHaveAttribute('title', /LEFT/);
  const saved = await exported(page, info, 'renamed');
  const renamed = saved.flows[0].nodes.find((n) => n.id === 'add')!;
  expect(renamed.block!.inputs[0]).toMatchObject({ id: 'a', name: 'LEFT' });
  expect(saved.flows[0].edges).toEqual(fixture.flows[0].edges);
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: '写入变量', exact: true })
    .click();
  const fresh = page.locator('.react-flow__node').last();
  await source.dragTo(fresh.locator('[data-handleid="data-in:in"]'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(count + 1);
  const next = await exported(page, info, 'fanout');
  expect(next.flows[0].edges.filter((e) => e.source === 'add' && e.kind === 'data')).toHaveLength(
    3,
  );
});

test('pump demo exposes a wired two-input/two-output FB and calculates current UI parameters', async ({
  page,
}, info) => {
  await flows(page);
  await page
    .getByRole('combobox', { name: '选择流程', exact: true })
    .selectOption('calculate-speed');
  const result = page.locator('.react-flow__node[data-id="speed-results"]');
  await expect(result.locator('[data-handleid^="data-in:"]')).toHaveCount(2);
  await expect(result.locator('[data-handleid^="data-out:"]')).toHaveCount(2);
  const project = await exported(page, info, 'pump-fb-demo');
  const flow = project.flows.find((flow) => flow.id === 'calculate-speed')!;
  expect(
    flow.edges.filter(
      (edge) =>
        edge.kind === 'data' &&
        edge.source === 'speed-results' &&
        edge.sourceHandle === 'data-out:rpm',
    ),
  ).toHaveLength(2);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await preview.getByRole('button', { name: '计算转速', exact: true }).click();
  await expect(preview.locator('[data-widget="target_rpm_value"]')).toHaveText(/1[,\s]?950/);
  await expect(preview.locator('[data-widget="speed_margin_value"]')).toContainText('35');
  await preview.locator('[data-widget="rated_rpm_input"] input').fill('4500');
  await preview.locator('[data-widget="rated_rpm_input"] input').press('Tab');
  const slider = preview.locator('[data-widget="speed"] input');
  await slider.press('Home');
  for (let step = 0; step < 20; step++) await slider.press('ArrowRight');
  await preview.getByRole('button', { name: '计算转速', exact: true }).click();
  await expect(preview.locator('[data-widget="target_rpm_value"]')).toContainText('900');
  await expect(preview.locator('[data-widget="speed_margin_value"]')).toContainText('80');
  await openPreviewDebug(page);
  await expect(page.locator('.console-content')).toContainText('900');
  await page.screenshot({ path: 'artifacts/pump-fb-demo.png', fullPage: true });
});

test('C blocks accept multiple named inputs and outputs and invalid drafts do not alter applied ports', async ({
  page,
}) => {
  await openFixture(page);
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: 'C 脚本', exact: true })
    .click();
  await page.getByRole('button', { name: '添加数据输入', exact: true }).click();
  await page.getByRole('button', { name: '添加数据输出', exact: true }).click();
  await page.getByLabel('output-1-name', { exact: true }).fill('DIFF');
  await page.getByLabel('output-1-path', { exact: true }).fill('["difference"]');
  await page.getByLabel('output-1-path', { exact: true }).blur();
  await page.getByRole('button', { name: '应用端口', exact: true }).click();
  const card = page.locator('.qg-flow-card.selected');
  await expect(card.locator('.target')).toHaveCount(3);
  await expect(card.locator('.source')).toHaveCount(4);
  await page.getByLabel('input-1-name', { exact: true }).fill('IN');
  await page.getByRole('button', { name: '应用端口', exact: true }).click();
  await expect(page.locator('.qg-fb-editor').getByRole('alert')).toContainText('Duplicate');
  await expect(card.locator('.target[data-handleid^="data-in:"]').nth(1)).toHaveAttribute(
    'title',
    /IN2/,
  );
});
