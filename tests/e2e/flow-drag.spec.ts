import { openPreviewDebug, closePreview } from './workspace';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { FlowNode, Project } from '../../src/core/types';
import { createBlockInterface } from '../../src/core/functionBlocks';

const fixture = JSON.parse(
  readFileSync('crates/quickgui-engine/tests/fixtures/function-blocks.json', 'utf8'),
) as Project;
const storageKey = 'quickgui.project.v1';

async function openFixture(page: Page, withActivity = false) {
  const project = structuredClone(fixture);
  project.locale = 'zh-CN';
  project.flows.push({
    id: 'other-flow',
    name: '另一个流程',
    enabled: true,
    nodes: [{ ...structuredClone(project.flows[0].nodes[0]), id: 'other-entry' }],
    edges: [],
  });
  if (withActivity) {
    const nodes: FlowNode[] = [
      {
        id: 'background-timer',
        kind: 'event',
        label: '后台定时',
        config: { trigger: 'interval', intervalMs: 100 },
        position: { x: 0, y: 0 },
      },
      {
        id: 'background-delay',
        kind: 'delay',
        label: '后台等待',
        config: { ms: 80 },
        position: { x: 300, y: 0 },
      },
      {
        id: 'background-log',
        kind: 'log',
        label: '后台完成',
        config: { message: 'Background activity tick' },
        position: { x: 600, y: 0 },
      },
    ];
    for (const node of nodes) node.block = createBlockInterface(node, project);
    project.flows.push({
      id: 'background-flow',
      name: 'Background activity',
      enabled: true,
      nodes,
      edges: [
        { id: 'background-start', source: 'background-timer', target: 'background-delay' },
        { id: 'background-end', source: 'background-delay', target: 'background-log' },
      ],
    });
  }
  await page.addInitScript(
    ({ recovery, storageKey }) => {
      localStorage.setItem(storageKey, recovery);
      type Fiber = {
        type?: { name?: string; displayName?: string };
        flags: number;
        child?: Fiber;
        sibling?: Fiber;
        dependencies?: {
          firstContext?: {
            memoizedValue?: unknown;
            next?: { memoizedValue?: unknown };
          };
        };
      };
      const counts: Record<string, number> = {};
      const activityStates: string[] = [];
      let previous = new Set<Fiber>();
      const hook = {
        supportsFiber: true,
        renderers: new Map<number, unknown>(),
        inject(renderer: unknown) {
          const id = this.renderers.size + 1;
          this.renderers.set(id, renderer);
          return id;
        },
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          const current = new Set<Fiber>();
          const visit = (fiber?: Fiber) => {
            if (!fiber) return;
            current.add(fiber);
            const rawName = fiber.type?.displayName ?? fiber.type?.name;
            // esbuild disambiguates the named function inside memo() as FlowEditor2.
            const name = rawName?.replace(/^(FlowEditor|FlowCanvas|FunctionBlockEditor)\d+$/, '$1');
            // A bailed-out subtree retains old flags. Count only newly committed fibers.
            if (name && !previous.has(fiber) && fiber.flags & 1)
              counts[name] = (counts[name] ?? 0) + 1;
            if (name === 'FlowCanvas') {
              const active = fiber.dependencies?.firstContext?.memoizedValue;
              if (Array.isArray(active) && active.every((id) => typeof id === 'string')) {
                const state = JSON.stringify(active);
                if (activityStates.at(-1) !== state) activityStates.push(state);
              }
            }
            visit(fiber.child);
            visit(fiber.sibling);
          };
          visit(root.current);
          previous = current;
        },
        onCommitFiberUnmount() {},
      };
      Object.assign(window, {
        __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
        __qgFlowRenderCounts: counts,
        __qgFlowActivityStates: activityStates,
      });
    },
    { recovery: JSON.stringify({ project, drafts: {} }), storageKey },
  );
  await page.goto('/');
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  await expect(page.locator('.react-flow__node')).toHaveCount(project.flows[0].nodes.length);
  return project;
}

const targetNode = (page: Page) => page.locator('.react-flow__node[data-id="add"]');
const revision = async (page: Page) =>
  Number((await page.locator('.statusbar').textContent())!.match(/rev (\d+)/)![1]);
const recoveredProject = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).project as Project, storageKey);
const position = async (page: Page) => {
  const project = await recoveredProject(page);
  return project.flows[0].nodes.find((node) => node.id === 'add')!.position;
};
const renderCounts = (page: Page) =>
  page.evaluate(
    () =>
      ({
        ...(window as unknown as { __qgFlowRenderCounts: Record<string, number> })
          .__qgFlowRenderCounts,
      }) as Record<string, number>,
  );

test('flow dragging keeps model and settings work off pointer frames and commits one stable edit', async ({
  page,
}, info) => {
  const project = await openFixture(page);
  const target = targetNode(page);
  const header = target.locator('.qg-flow-card-header');
  await header.click();
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('add');
  // Wait for React Flow's initial measurements before observing drag-only commits.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const initialRevision = await revision(page);
  const initialPosition = project.flows[0].nodes.find((node) => node.id === 'add')!.position;
  const before = (await target.boundingBox())!;
  const bounds = (await header.boundingBox())!;
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const beforeRenders = await renderCounts(page);
  const beforeStyle = await target.getAttribute('style');
  const edge = page.locator('.react-flow__edge[data-id="e7"] .react-flow__edge-path');
  const edgeBefore = await edge.getAttribute('d');
  await page.mouse.move(start.x + 96, start.y + 48, { steps: 45 });
  await expect(target).not.toHaveAttribute('style', beforeStyle!);
  await expect(edge).not.toHaveAttribute('d', edgeBefore!);
  const duringRenders = await renderCounts(page);
  await info.attach('flow-drag-render-counts.json', {
    body: JSON.stringify(
      { pointerSteps: 45, before: beforeRenders, during: duringRenders },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect(beforeRenders.FlowEditor).toBeGreaterThan(0);
  expect(beforeRenders.FunctionBlockEditor).toBeGreaterThan(0);
  // Selection is settled before dragging: neither editor nor port settings should render per frame.
  expect(duringRenders.FlowEditor).toBe(beforeRenders.FlowEditor);
  expect(duringRenders.FunctionBlockEditor).toBe(beforeRenders.FunctionBlockEditor);
  expect(await revision(page)).toBe(initialRevision);
  expect(await position(page)).toEqual(initialPosition);
  const moved = (await target.boundingBox())!;
  expect(moved.x).toBeGreaterThan(before.x + 64);
  await page.mouse.up();
  await expect.poll(() => revision(page)).toBe(initialRevision + 1);
  await expect.poll(() => position(page)).not.toEqual(initialPosition);
  const committedPosition = await position(page);
  const committedStyle = await target.getAttribute('style');
  const committedTransform = await target.evaluate(
    (element) => (element as HTMLElement).style.transform,
  );
  await page.keyboard.press('ControlOrMeta+z');
  await expect(target).toHaveAttribute('style', beforeStyle!);
  await expect(
    page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(target).toHaveAttribute('style', committedStyle!);
  await expect.poll(() => position(page)).toEqual(committedPosition);
  await page.getByLabel('选择流程', { exact: true }).selectOption('other-flow');
  await expect(target).toHaveCount(0);
  await page.getByLabel('选择流程', { exact: true }).selectOption('fb');
  await expect
    .poll(() => target.evaluate((element) => (element as HTMLElement).style.transform))
    .toBe(committedTransform);
  expect(await position(page)).toEqual(committedPosition);
});

test('background runtime highlights keep changing during drag without rendering the node settings', async ({
  page,
}, info) => {
  const project = await openFixture(page, true);
  const activityStates = () =>
    page.evaluate(() => [
      ...(window as unknown as { __qgFlowActivityStates: string[] }).__qgFlowActivityStates,
    ]);
  await expect
    .poll(async () => (await activityStates()).some((state) => state.includes('background-delay')))
    .toBe(true);
  await openPreviewDebug(page);
  const completed = page
    .locator('.preview-modal .console-content .log-row')
    .filter({ hasText: 'Completed: Background activity' });
  const completedBefore = await completed.count();
  await closePreview(page);
  const target = targetNode(page);
  await target.locator('.qg-flow-card-header').click();
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('add');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const initialRevision = await revision(page);
  const initialPosition = project.flows[0].nodes.find((node) => node.id === 'add')!.position;
  const header = (await target.locator('.qg-flow-card-header').boundingBox())!;
  const start = { x: header.x + header.width / 2, y: header.y + header.height / 2 };
  const before = (await target.boundingBox())!;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const beforeRenders = await renderCounts(page);
  const initialStates = (await activityStates()).length;
  await page.mouse.move(start.x + 96, start.y + 48, { steps: 60 });
  await expect.poll(async () => (await activityStates()).length).toBeGreaterThan(initialStates);
  const duringRenders = await renderCounts(page);
  const duringStates = (await activityStates())
    .slice(initialStates)
    .map((state) => JSON.parse(state));
  await info.attach('flow-drag-background-activity.json', {
    body: JSON.stringify(
      {
        pointerSteps: 60,
        before: beforeRenders,
        during: duringRenders,
        activeStates: duringStates,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect(duringStates.length).toBeGreaterThan(2);
  expect(duringStates.some((state: string[]) => state.includes('background-delay'))).toBe(true);
  expect(duringStates.some((state: string[]) => !state.includes('background-delay'))).toBe(true);
  expect(duringRenders.FlowCanvas).toBeGreaterThan(beforeRenders.FlowCanvas);
  expect(duringRenders.FlowEditor).toBe(beforeRenders.FlowEditor);
  expect(duringRenders.FunctionBlockEditor).toBe(beforeRenders.FunctionBlockEditor);
  expect(await revision(page)).toBe(initialRevision);
  expect(await position(page)).toEqual(initialPosition);
  expect((await target.boundingBox())!.x).toBeGreaterThan(before.x + 64);
  await page.mouse.up();
  await expect.poll(() => revision(page)).toBe(initialRevision + 1);
  await expect.poll(() => position(page)).not.toEqual(initialPosition);
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('add');
  await openPreviewDebug(page);
  await expect.poll(() => completed.count()).toBeGreaterThan(completedBefore);
  await closePreview(page);
});

test('property and named-port edits remain live while connected edges follow repeated drags', async ({
  page,
}) => {
  await openFixture(page);
  const target = targetNode(page);
  await target.locator('.qg-flow-card-header').click();
  await page.getByLabel('节点名称', { exact: true }).fill('参数计算');
  await expect(target.locator('.qg-flow-card-header')).toContainText('参数计算');
  await page.getByLabel('input-0-name', { exact: true }).fill('LEFT');
  await page.getByRole('button', { name: '应用端口', exact: true }).click();
  const input = target.locator('[data-handleid="data-in:a"]');
  await expect(input).toHaveAttribute('title', /LEFT/);
  await expect(page.locator('.react-flow__edge')).toHaveCount(fixture.flows[0].edges.length);
  for (const delta of [
    { x: 64, y: 32 },
    { x: -32, y: 48 },
  ]) {
    const initialRevision = await revision(page);
    const edge = page.locator('.react-flow__edge[data-id="e5"] .react-flow__edge-path');
    const before = await edge.getAttribute('d');
    const header = (await target.locator('.qg-flow-card-header').boundingBox())!;
    const start = { x: header.x + header.width / 2, y: header.y + header.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 20 });
    await expect(edge).not.toHaveAttribute('d', before!);
    expect(await revision(page)).toBe(initialRevision);
    await page.mouse.up();
    await expect.poll(() => revision(page)).toBe(initialRevision + 1);
    await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('参数计算');
    await expect(page.getByLabel('input-0-name', { exact: true })).toHaveValue('LEFT');
  }
  await expect
    .poll(async () => {
      const project = await recoveredProject(page);
      return project.flows[0];
    })
    .toMatchObject({
      edges: fixture.flows[0].edges,
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'add',
          label: '参数计算',
          block: expect.objectContaining({
            inputs: expect.arrayContaining([expect.objectContaining({ id: 'a', name: 'LEFT' })]),
          }),
        }),
      ]),
    });
});
