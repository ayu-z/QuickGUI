import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import type { Project } from '../../src/core/types';
import { validateProject } from '../../src/core/validation';

async function openExample(page: Page) {
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
  await page.getByRole('button', { name: '打开串口助手示例', exact: true }).click();
  await expect(page.locator('.project-switch')).toHaveText('串口助手');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
}
async function section(page: Page, name: string) {
  await page.locator('.workspace-tabs nav').getByRole('button', { name, exact: true }).click();
}
async function exported(page: Page, info: TestInfo, name: string): Promise<Project> {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const pending = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const destination = info.outputPath(`${name}.qgui`);
  await (await pending).saveAs(destination);
  const files = unzipSync(new Uint8Array(await readFile(destination)));
  return validateProject(JSON.parse(strFromU8(files['quickgui.json'])));
}

test('the serial example is an editable v5 project with ordinary controls and safe defaults', async ({
  page,
}, info) => {
  await openExample(page);
  await expect(page.locator('[data-design-widget="traffic_history"]')).toBeVisible();
  await page.locator('[data-design-widget="send_payload"]').click();
  await expect(page.locator('.qg-inspector').getByLabel('多行输入', { exact: true })).toBeChecked();
  const project = await exported(page, info, 'serial-example');
  expect(project.schemaVersion).toBe(5);
  expect(project.scripts).toEqual([]);
  expect(project.modules).toEqual([]);
  expect(
    project.widgets.every((widget) => widget.definitionVersion === 2 && widget.type !== 'module'),
  ).toBe(true);
  expect(project.variables.find((variable) => variable.id === 'serial_settings')?.initial).toEqual({
    portName: '',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    framing: 'raw',
    autoReconnect: false,
  });
  expect(project.variables.find((variable) => variable.id === 'serial_tx')?.initial).toMatchObject({
    periodic: false,
    intervalMs: 1000,
    encoding: 'utf8',
    lineEnding: 'none',
  });
  expect(project.variables.find((variable) => variable.id === 'serial_options')?.initial).toEqual(
    [],
  );
  const append = project.flows
    .flatMap((flow) => flow.nodes)
    .filter((node) => node.kind === 'append');
  expect(append).toHaveLength(2);
  for (const node of append)
    expect(node.config).toMatchObject({
      maxItems: 500,
      maxBytes: 524288,
      droppedPath: ['dropped'],
    });
  expect(project.flows).toHaveLength(1);
  expect(project.flows[0].nodes.find((node) => node.id === 'serial_open_0')?.config.trigger).toBe(
    'manual',
  );
  expect(project.flows[0].nodes.find((node) => node.id === 'serial_send_0')?.config.trigger).toBe(
    'manual',
  );
  await page.screenshot({ path: 'artifacts/serial-assistant-designer.png', fullPage: true });
});

test('browser preview never fabricates ports or traffic and shows the native capability diagnostic', async ({
  page,
}) => {
  await openExample(page);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await expect(preview.locator('[data-widget="baud_rate"] input')).toHaveValue('115200');
  await expect(preview.locator('[data-widget="data_bits"] select')).toHaveValue('3');
  await expect(preview.locator('[data-widget="send_once"] button')).toBeDisabled();
  await expect(preview.locator('[data-widget="periodic_send"] input')).toBeDisabled();
  await expect(preview.locator('[data-widget="auto_reconnect"] input')).not.toBeChecked();
  await expect(preview.locator('[data-widget="traffic_history"] tbody tr')).toHaveCount(0);
  await preview.locator('[data-widget="scan_ports"] button').click();
  await expect(preview.locator('[data-widget="error_message"]')).toContainText(
    /desktop|原生|桌面/i,
  );
  await expect(preview.locator('[data-widget="serial_port_select"] option')).toHaveCount(1);
  await expect(preview.locator('[data-widget="traffic_history"] tbody tr')).toHaveCount(0);
  await expect(preview.locator('[data-widget="tx_bytes"] input')).toHaveValue('0');
  await expect(preview.locator('[data-widget="rx_bytes"] input')).toHaveValue('0');
  await preview.locator('[data-widget="send_payload"] textarea').fill('01 A0 FF');
  await preview.locator('[data-widget="send_encoding"] select').selectOption({ label: 'HEX' });
  await expect(preview.locator('[data-widget="send_once"] button')).toBeDisabled();
  await preview.locator('[data-widget="clear_history"] button').click();
  await expect(preview.locator('[data-widget="dropped_records"] input')).toHaveValue('0');
  await page.screenshot({
    path: 'artifacts/serial-assistant-browser-diagnostic.png',
    fullPage: true,
  });
});

test('serial flow ports and value sources remain editable and existing connection profiles remain referenceable', async ({
  page,
}, info) => {
  await openExample(page);
  await section(page, '流程');
  await page.screenshot({ path: 'artifacts/serial-integrated-flow.png', fullPage: true });
  const scan = page.locator('.react-flow__node[data-id="serial_scan_1"]');
  await scan.click();
  await expect(scan.locator('.react-flow__handle[data-handleid="success"]')).toHaveCount(1);
  await expect(scan.locator('.react-flow__handle[data-handleid="error"]')).toHaveCount(1);
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: '串口 设备发现', exact: true })
    .click();
  const selectedId = await page.locator('.react-flow__node.selected').getAttribute('data-id');
  const settings = page.locator('.qg-flow-settings');
  await settings.getByLabel('VID 来源', { exact: true }).selectOption('variable');
  await settings.getByLabel('VID 变量', { exact: true }).selectOption('serial_filters');
  await settings.getByLabel('VID 路径', { exact: true }).fill('["vid"]');
  await settings.getByLabel('VID 路径', { exact: true }).press('Tab');
  const project = await exported(page, info, 'serial-value-source');
  expect(project.flows[0].nodes.find((node) => node.id === selectedId)?.config.vid).toEqual({
    source: 'variable',
    variable: 'serial_filters',
    path: ['vid'],
  });
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: '串口 通信', exact: true })
    .click();
  const communicationId = await page.locator('.react-flow__node.selected').getAttribute('data-id');
  const serialConnection = settings.getByRole('combobox', { name: '串口连接', exact: true });
  await expect(serialConnection.locator('option[value="serial_port"]')).toHaveText('助手串口');
  await serialConnection.selectOption('serial_port');
  await expect(serialConnection).toHaveValue('serial_port');
  await page
    .locator('.qg-node-palette')
    .getByRole('button', { name: '设备请求', exact: true })
    .click();
  const requestId = await page.locator('.react-flow__node.selected').getAttribute('data-id');
  const requestConnection = settings.getByRole('combobox', { name: '设备或服务连接', exact: true });
  await expect(requestConnection.locator('option[value="serial_port"]')).toHaveText(
    '助手串口 · SERIAL',
  );
  await requestConnection.selectOption('serial_port');
  await expect(requestConnection).toHaveValue('serial_port');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('quickgui.project.v1')!).project.connections,
      ),
    )
    .toEqual(project.connections);
  const saved = await exported(page, info, 'serial-profile-references');
  expect(saved.connections).toEqual(project.connections);
  const nodes = saved.flows.flatMap((flow) => flow.nodes);
  expect(nodes.find((node) => node.id === communicationId)?.config).toMatchObject({
    action: 'communicate',
    connectionId: 'serial_port',
  });
  expect(nodes.find((node) => node.id === requestId)?.config.connectionId).toBe('serial_port');
  expect(nodes.find((node) => node.id === selectedId)?.config.vid).toEqual({
    source: 'variable',
    variable: 'serial_filters',
    path: ['vid'],
  });
  for (const original of project.flows
    .flatMap((flow) => flow.nodes)
    .filter((node) => node.config.connectionId))
    expect(nodes.find((node) => node.id === original.id)?.config).toEqual(original.config);
  await page.screenshot({ path: 'artifacts/serial-connection-profile.png', fullPage: true });
});

test('adding a serial node immediately uses FB ports and remains reversible', async ({
  page,
}, info) => {
  await page.goto('/');
  await section(page, '流程');
  const before = await page.locator('.react-flow__node').count();
  const add = page
    .locator('.qg-node-palette')
    .getByRole('button', { name: '串口 设备发现', exact: true });
  await add.click();
  const dialog = page.getByRole('dialog', { name: '升级工程与控件', exact: true });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
  expect((await exported(page, info, 'serial-v4-upgrade')).schemaVersion).toBe(5);
  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
  const undone = await exported(page, info, 'serial-v4-upgrade-undone');
  expect(undone.schemaVersion).toBe(5);
  expect(undone.flows.flatMap((flow) => flow.nodes).some((node) => node.kind === 'serial')).toBe(
    false,
  );
});
