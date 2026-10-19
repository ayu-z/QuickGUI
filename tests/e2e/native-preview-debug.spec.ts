import { expect, test } from '@playwright/test';
import { createEmptyProject, createWidget } from '../../src/core/project';
import { createBlockInterface } from '../../src/core/functionBlocks';
import type { FlowNode } from '../../src/core/types';

type ChildPreviewHarness = {
  attaches: number;
  starts: number;
  stops: number;
  runs: { flowId: string; input: unknown; entryNodeId: string }[];
  resumeSharedSession: () => void;
};

test('a native child debugger attaches to the shared session and cannot restart a stopped session', async ({
  page,
}) => {
  const project = createEmptyProject('Native shared preview');
  project.variables = [{ id: 'counter', name: 'Counter', type: 'number', initial: 0 }];
  const counter = createWidget('number', 40, 40);
  counter.id = 'counter-control';
  counter.bindings.value = { variable: 'counter', mode: 'oneWay' };
  project.windows = [
    {
      id: 'child',
      name: 'Child preview',
      config: { ...project.window, title: 'Child preview' },
      widgets: [counter],
      openOnStart: true,
    },
  ];
  const entry: FlowNode = {
    id: 'manual-entry',
    kind: 'event',
    label: 'Manual shared entry',
    position: { x: 40, y: 40 },
    config: { trigger: 'manual' },
  };
  entry.block = createBlockInterface(entry, project);
  project.flows = [
    { id: 'manual-flow', name: 'Manual shared flow', enabled: true, nodes: [entry], edges: [] },
  ];
  await page.addInitScript(
    (json) => Object.assign(window, { nativePreviewProject: JSON.parse(json) }),
    JSON.stringify(project),
  );
  // Native IPC is controlled here; the production attach-only controller and UI are unchanged.
  await page.route(
    (url) =>
      url.pathname === '/src/native/bridge.ts' && !url.searchParams.has('child-debug-actual'),
    (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
      export * from '/src/native/bridge.ts?child-debug-actual';
      const project = window.nativePreviewProject;
      const harness = window.childPreviewHarness = { attaches: 0, starts: 0, stops: 0, runs: [] };
      let listener;
      let snapshot = { projectId: project.id, revision: project.revision, sequence: 1,
        values: { counter: { value: 0, quality: 'good', timestamp: Date.now() } }, logs: [], activeNodes: [], running: false,
        windowState: { open: ['main', 'child'], focused: 'child', revision: 0 } };
      export const isDesktop = () => true;
      export const getPreviewProject = async () => project;
      export const onProjectUpdated = async () => () => {};
      export const onStorageError = async () => () => {};
      export const onRuntimeSnapshot = async (callback) => { listener = callback; return () => {}; };
      export const attachRuntime = async () => { harness.attaches++; return snapshot; };
      export const runtimeStart = async () => { harness.starts++; throw new Error('A child must never replace the shared runtime'); };
      harness.resumeSharedSession = () => { snapshot = { ...snapshot, sequence: snapshot.sequence + 1, running: true }; listener(snapshot); };
      export const runFlow = async (flowId, input, entryNodeId) => {
        harness.runs.push({ flowId, input, entryNodeId });
        snapshot = { ...snapshot, sequence: snapshot.sequence + 1,
          values: { counter: { value: snapshot.values.counter.value + 1, quality: 'good', timestamp: Date.now() } },
          logs: [...snapshot.logs, { id: 'manual-run', time: Date.now(), level: 'info', message: 'Shared manual entry accepted' }] };
        return snapshot;
      };
      export const stop = async () => { harness.stops++; snapshot = { ...snapshot, sequence: snapshot.sequence + 1, running: false }; return snapshot; };
    `,
      }),
  );
  await page.goto('/?preview=1&windowId=child');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { childPreviewHarness: ChildPreviewHarness }).childPreviewHarness
            ?.attaches,
      ),
    )
    .toBe(1);
  await page.getByRole('button', { name: '预览调试', exact: true }).click();
  const debug = page.locator('.native-preview-debug .console-panel');
  const run = debug.getByRole('button', { name: '运行', exact: true });
  await expect(debug).toContainText('共享会话已停止，请在主预览窗口中恢复运行');
  await expect(run).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { childPreviewHarness: ChildPreviewHarness }).childPreviewHarness
          .starts,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { childPreviewHarness: ChildPreviewHarness }).childPreviewHarness
          .runs,
    ),
  ).toEqual([]);
  await page.evaluate(() =>
    (
      window as unknown as { childPreviewHarness: ChildPreviewHarness }
    ).childPreviewHarness.resumeSharedSession(),
  );
  await expect(run).toBeEnabled();
  await expect(debug).toContainText('运行与停止作用于所有预览窗口的共享会话');
  await run.click();
  await expect(debug.locator('.console-content')).toContainText('Shared manual entry accepted');
  await expect(page.locator('[data-widget="counter-control"] input')).toHaveValue('1.00');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { childPreviewHarness: ChildPreviewHarness }).childPreviewHarness
          .runs,
    ),
  ).toEqual([{ flowId: 'manual-flow', input: null, entryNodeId: 'manual-entry' }]);
  await debug.getByRole('button', { name: '停止', exact: true }).click();
  await expect(run).toBeDisabled();
  await expect(debug).toContainText('共享会话已停止，请在主预览窗口中恢复运行');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { childPreviewHarness: ChildPreviewHarness }).childPreviewHarness
          .stops,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { childPreviewHarness: ChildPreviewHarness }).childPreviewHarness
          .starts,
    ),
  ).toBe(0);
});
