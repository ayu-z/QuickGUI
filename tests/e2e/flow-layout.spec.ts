import { expect, test, type Locator, type Page } from '@playwright/test';
import { createEmptyProject, createWidget } from '../../src/core/project';
import { createBlockInterface } from '../../src/core/functionBlocks';
import type { FlowNode } from '../../src/core/types';

const storageKey = 'quickgui.project.v1';

async function openFixture(page: Page, theme: 'light' | 'dark' = 'dark') {
  const project = createEmptyProject('流程布局回归');
  project.theme.mode = theme === 'dark' ? 'light' : 'dark';
  project.widgets = [createWidget('button', 40, 40)];
  const nodes: FlowNode[] = [
    {
      id: 'layout-entry',
      kind: 'event',
      label: '采集入口',
      config: { trigger: 'manual' },
      position: { x: 80, y: 100 },
    },
    {
      id: 'layout-math',
      kind: 'math',
      label: '数据计算',
      config: { operation: 'add', operand: 1 },
      position: { x: 400, y: 100 },
    },
  ];
  for (const node of nodes) node.block = createBlockInterface(node, project);
  project.flows = [
    {
      id: 'layout-main',
      name: 'A · 采集与处理',
      enabled: false,
      nodes,
      edges: [{ id: 'layout-edge', source: 'layout-entry', target: 'layout-math' }],
    },
    {
      id: 'layout-alarm',
      name: 'B · 告警流程',
      enabled: false,
      nodes: [{ ...structuredClone(nodes[0]), id: 'layout-alarm-entry', label: '告警入口' }],
      edges: [],
    },
  ];
  await page.addInitScript(
    ({ recovery, storageKey, theme }) => {
      localStorage.setItem(storageKey, recovery);
      localStorage.setItem('quickgui.theme', theme);
    },
    { recovery: JSON.stringify({ project, drafts: {} }), storageKey, theme },
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  return project;
}

async function openFlows(page: Page) {
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
}

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

const surfaceColor = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).backgroundColor);

for (const width of [1440, 1100]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} flow layout at ${width}px aligns with the interface workspace and keeps console in the canvas column`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await openFixture(page, theme);
      const design = {
        left: await bounds(page.locator('.left-panel')),
        right: await bounds(page.locator('.right-panel')),
        heading: await bounds(page.locator('.canvas-heading')),
        status: await bounds(page.locator('.qg-canvas-status')),
        console: await bounds(page.locator('.console-panel')),
        leftColor: await surfaceColor(page.locator('.left-panel')),
        rightColor: await surfaceColor(page.locator('.right-panel')),
        headingColor: await surfaceColor(page.locator('.canvas-heading')),
      };
      await openFlows(page);
      const left = await bounds(page.locator('.qg-flow-sidebar'));
      const right = await bounds(page.locator('.qg-flow-settings'));
      const heading = await bounds(page.locator('.qg-flow-workspace .canvas-heading'));
      const status = await bounds(page.locator('.qg-flow-workspace .qg-canvas-status'));
      const console = await bounds(page.locator('.console-panel'));
      for (const [actual, expected] of [
        [left, design.left],
        [right, design.right],
        [heading, design.heading],
        [status, design.status],
        [console, design.console],
      ]) {
        for (const key of ['x', 'y', 'width', 'height'] as const)
          expect(actual[key], key).toBeCloseTo(expected[key], 0);
      }
      expect(left.width).toBe(width > 1200 ? 224 : 190);
      expect(right.width).toBe(width > 1200 ? 304 : 280);
      expect(heading.height).toBe(43);
      expect(status.height).toBe(29);
      expect(console.x).toBeCloseTo(left.x + left.width, 0);
      expect(console.x + console.width).toBeCloseTo(right.x, 0);
      expect(status.y + status.height).toBeCloseTo(console.y, 0);
      expect(left.y + left.height).toBeCloseTo(console.y + console.height, 0);
      expect(right.y + right.height).toBeCloseTo(console.y + console.height, 0);
      expect(await surfaceColor(page.locator('.qg-flow-sidebar'))).toBe(design.leftColor);
      expect(await surfaceColor(page.locator('.qg-flow-settings'))).toBe(design.rightColor);
      expect(await surfaceColor(page.locator('.qg-flow-workspace .canvas-heading'))).toBe(
        design.headingColor,
      );
      // The project deliberately has the opposite runtime theme.
      await expect(page.locator('.react-flow')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      expect(
        await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        })),
      ).toEqual({ width, height: 1000 });
      await page.screenshot({ path: info.outputPath('flow-layout.png') });
    });
  }
}

test('node library search, keyboard flow selection and long node settings remain usable', async ({
  page,
}) => {
  await openFixture(page);
  await openFlows(page);
  const palette = page.locator('.qg-node-palette');
  const cards = palette.locator('.qg-library-item');
  const search = page.getByLabel('搜索节点', { exact: true });
  const count = await cards.count();
  expect(count).toBeGreaterThan(10);
  await search.fill('USB');
  await expect(cards).toHaveCount(2);
  await palette.getByRole('button', { name: 'USB 通信', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('USB 通信');
  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(cards).toHaveCount(count);
  await search.fill('不存在的节点');
  await expect(cards).toHaveCount(0);
  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  await expect(cards).toHaveCount(count);

  const settings = page.locator('.qg-flow-settings');
  const heading = settings.locator('.qg-inspector-heading');
  const headingBefore = await bounds(heading);
  const body = settings.locator('.qg-flow-settings-body');
  expect(await body.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await body.evaluate((element) => element.clientHeight),
  );
  await body.hover();
  await page.mouse.wheel(0, 1800);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await bounds(heading)).y).toBe(headingBefore.y);
  await settings.getByRole('button', { name: '应用端口', exact: true }).focus();
  await expect(settings.getByRole('button', { name: '应用端口', exact: true })).toBeFocused();
  expect((await bounds(heading)).y).toBe(headingBefore.y);

  const select = page.getByLabel('选择流程', { exact: true });
  await select.focus();
  await page.keyboard.press('b');
  await expect(select).toHaveValue('layout-alarm');
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(settings.getByLabel('节点名称', { exact: true })).toHaveCount(0);
  await select.selectOption('layout-main');
  await expect(select).toHaveValue('layout-main');
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
});

test('flow heading tools control zoom, fit, grid and snapping without changing the flow model', async ({
  page,
}) => {
  await openFixture(page);
  await openFlows(page);
  const tools = page.getByRole('toolbar', { name: '流程画布工具', exact: true });
  const viewport = page.locator('.react-flow__viewport');
  const zoom = () =>
    viewport.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  const recoveredFlow = () =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).project.flows[0], storageKey);
  const initialFlow = await recoveredFlow();
  const initialZoom = await zoom();
  await tools.getByRole('button', { name: '放大', exact: true }).click();
  await expect.poll(zoom).toBeGreaterThan(initialZoom);
  const zoomed = await zoom();
  await tools.getByRole('button', { name: '缩小', exact: true }).click();
  await expect.poll(zoom).toBeLessThan(zoomed);
  await tools.getByRole('button', { name: '适应画布', exact: true }).click();
  await expect.poll(zoom).toBeCloseTo(initialZoom, 2);

  const grid = tools.getByRole('button', { name: '切换网格', exact: true });
  await expect(grid).toHaveAttribute('aria-pressed', 'true');
  await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.react-flow__background')).toHaveCount(0);
  await grid.click();
  await expect(page.locator('.react-flow__background')).toBeVisible();
  const snap = tools.getByRole('button', { name: '切换吸附', exact: true });
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  await snap.click();
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await snap.click();
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  expect(await recoveredFlow()).toEqual(initialFlow);
  await expect(page.locator('.react-flow__controls')).toHaveCount(0);
});
