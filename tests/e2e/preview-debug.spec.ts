import { expect, test } from '@playwright/test';
import { createEmptyProject, createWidget } from '../../src/core/project';
import { createBlockInterface } from '../../src/core/functionBlocks';
import type { FlowNode } from '../../src/core/types';
import { closePreview, openPreviewDebug } from './workspace';

test('preview debugging retains automatic logs and supports running, simulation, filtering, copy and clearing', async ({
  page,
}, info) => {
  const project = createEmptyProject('Preview debugging');
  project.variables = [
    { id: 'temperature', name: 'Temperature', type: 'number', initial: 0, alarm: { max: 10 } },
  ];
  const number = createWidget('number', 40, 40);
  number.id = 'temperature-display';
  number.bindings.value = { variable: 'temperature', mode: 'oneWay' };
  project.widgets = [number];
  project.flows = ['manual', 'startup'].map((trigger) => {
    const nodes: FlowNode[] = [
      {
        id: `${trigger}-entry`,
        kind: 'event',
        label: `${trigger} entry`,
        position: { x: 60, y: 60 },
        config: { trigger },
      },
      {
        id: `${trigger}-log`,
        kind: 'log',
        label: `${trigger} log`,
        position: { x: 360, y: 60 },
        config: {
          message: trigger === 'manual' ? 'Manual debugger entry' : 'Automatic debugger entry',
        },
      },
    ];
    for (const node of nodes) node.block = createBlockInterface(node, project);
    return {
      id: trigger,
      name: trigger,
      enabled: true,
      nodes,
      edges: [{ id: `${trigger}-wire`, source: nodes[0].id, target: nodes[1].id }],
    };
  });
  await page.addInitScript(
    (saved) => {
      localStorage.setItem('quickgui.project.v1', saved);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          async writeText(text: string) {
            Object.assign(window, { copiedDebugLogs: text });
          },
        },
      });
    },
    JSON.stringify({ project, drafts: {} }),
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('.workspace-body .console-panel')).toHaveCount(0);
  await page.locator('.statusbar').getByRole('button', { name: '预览调试', exact: true }).click();
  const debug = await openPreviewDebug(page);
  const output = debug.locator('.console-content');
  await expect(output).toContainText('Automatic debugger entry');
  await debug.getByRole('button', { name: '运行', exact: true }).click();
  await expect(output).toContainText('Manual debugger entry');
  const simulation = debug.getByRole('checkbox', { name: /模拟数据/ });
  await simulation.check();
  await expect
    .poll(async () =>
      Number(
        await page.locator('.preview-modal [data-widget="temperature-display"] input').inputValue(),
      ),
    )
    .toBeGreaterThan(10);
  await expect(output).toContainText('Alarm: Temperature');
  await simulation.uncheck();
  await debug.getByLabel('日志级别', { exact: true }).selectOption('warning');
  await expect(output.locator('.log-row')).toHaveCount(1);
  await expect(output.locator('.log-row').first()).toHaveClass(/warning/);
  await debug.getByLabel('日志级别', { exact: true }).selectOption('info');
  await debug.getByLabel('搜索日志', { exact: true }).fill('Manual debugger entry');
  await expect(output).toContainText('Manual debugger entry');
  await expect(output).not.toContainText('Automatic debugger entry');
  await debug.getByRole('button', { name: '复制日志', exact: true }).click();
  expect(
    await page.evaluate(() => (window as unknown as { copiedDebugLogs: string }).copiedDebugLogs),
  ).toContain('Manual debugger entry');
  expect(
    await page.evaluate(() => (window as unknown as { copiedDebugLogs: string }).copiedDebugLogs),
  ).not.toContain('Automatic debugger entry');
  const follow = debug.getByRole('button', { name: '自动滚动', exact: true });
  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await debug.getByRole('button', { name: '关闭日志', exact: true }).click();
  await expect(page.locator('.preview-modal')).toBeVisible();
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await openPreviewDebug(page);
  await expect(output).toContainText('Automatic debugger entry');
  await expect(output).toContainText('Manual debugger entry');
  await closePreview(page);
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await openPreviewDebug(page);
  await expect(output).toContainText('Manual debugger entry');
  await debug.getByTitle('清空', { exact: true }).click();
  await expect(output.locator('.log-row')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('preview-debug-cleared.png') });
  await closePreview(page);
});
