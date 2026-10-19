import { expect, test, type Page } from '@playwright/test';

type BuildHarness = {
  emit: (stage: string, message: string) => void;
  finish: (result: unknown) => void;
  fail: (error: string) => void;
  refreshRuntime: () => void;
  listeners: number;
  builds: number;
};
declare global {
  interface Window {
    buildHarness: BuildHarness;
  }
}

// Exercise designer rendering with controlled native events; real process capture
// is covered separately by the Rust build_runtime tests.
test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.pathname === '/src/native/bridge.ts' && !url.searchParams.has('build-test-actual'),
    (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
        export * from '/src/native/bridge.ts?build-test-actual';
        const harness = window.buildHarness = { listeners: 0, builds: 0 };
        export const isDesktop = () => true;
        export const setDesignerTheme = async () => {};
        export const onPreviewClosed = async () => () => {};
        export const onStorageError = async () => () => {};
        let runtime, snapshotListener;
        export const onRuntimeSnapshot = async (listener) => { snapshotListener = listener; return () => {}; };
        export const runtimeStart = async (project) => runtime = {
          projectId: project.id, revision: project.revision, sequence: 1,
          values: Object.fromEntries(project.variables.map(v => [v.id, { value: v.initial, quality: 'good', timestamp: Date.now() }])),
          logs: [], activeNodes: [], running: false,
        };
        harness.refreshRuntime = () => snapshotListener({ ...runtime, sequence: ++runtime.sequence, logs: [{ id: 'native-log', time: Date.now(), level: 'info', message: 'native runtime refreshed' }] });
        export const onBuildProgress = async (listener) => {
          harness.listeners++;
          harness.emit = (stage, message) => listener({ stage, message });
          return () => { harness.listeners--; };
        };
        export const buildRuntime = () => {
          harness.builds++;
          return new Promise((resolve, reject) => {
            harness.finish = resolve;
            harness.fail = (message) => reject(new Error(message));
          });
        };
        export const cancelBuild = async () => harness.fail('Build cancelled');
      `,
      }),
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
});

async function startBuild(page: Page) {
  await page.locator('.export-menu-wrap > button').click();
  await page.getByRole('button', { name: /独立运行应用/ }).click();
  await expect(page.locator('.build-progress')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.buildHarness.listeners)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.buildHarness.builds)).toBeGreaterThan(0);
}

test('live build output opens the console and survives native snapshots and completion', async ({
  page,
}) => {
  await page.locator('.console-panel > header > button').click();
  await expect(page.locator('.console-panel')).toHaveCount(0);
  await startBuild(page);
  const output = page.locator('.console-content');
  await expect(output).toContainText('准备构建');
  await page.evaluate(() =>
    window.buildHarness.emit('dependencies', 'npm ci: installing dependencies'),
  );
  await expect(output).toContainText('npm ci: installing dependencies');
  await page.evaluate(() =>
    window.buildHarness.emit('package', 'compiler stdout\ncompiler stderr diagnostic'),
  );
  await expect(output).toContainText('compiler stderr diagnostic');
  await page.evaluate(() => window.buildHarness.refreshRuntime());
  await expect(output).toContainText('native runtime refreshed');
  await expect(output).toContainText('npm ci: installing dependencies');
  await page.evaluate(() =>
    window.buildHarness.finish({
      sourceDir: 'C:/export/source',
      artifactDir: 'C:/export/bundle',
      artifacts: ['C:/export/bundle/app.exe'],
      signingStatus: 'not-verified',
    }),
  );
  await expect(page.locator('.build-progress')).toHaveCount(0);
  await expect(output).toContainText('compiler stderr diagnostic');
  await expect.poll(() => page.evaluate(() => window.buildHarness.listeners)).toBe(0);
});

test('failed and cancelled builds keep diagnostics and release the listener', async ({ page }) => {
  await startBuild(page);
  await page.evaluate(() => {
    window.buildHarness.emit('package', 'final compiler diagnostic');
    window.buildHarness.emit('error', 'package failed (exit code: 7)');
    window.buildHarness.fail('package failed (exit code: 7)');
  });
  const output = page.locator('.console-content');
  await expect(page.locator('.build-progress')).toHaveCount(0);
  await expect(output).toContainText('final compiler diagnostic');
  await expect(output.locator('.log-row.error')).toHaveCount(1);
  await expect(output.locator('.log-row.error')).toContainText('package failed');
  await expect.poll(() => page.evaluate(() => window.buildHarness.listeners)).toBe(0);
  await startBuild(page);
  await page.getByRole('button', { name: '取消构建', exact: true }).click();
  await expect(page.locator('.build-progress')).toHaveCount(0);
  await expect(output).toContainText('Build cancelled');
  await expect.poll(() => page.evaluate(() => window.buildHarness.listeners)).toBe(0);
  await page.locator('.console-panel').getByTitle('清空', { exact: true }).click();
  await expect(output.locator('.log-row')).toHaveCount(0);
});
