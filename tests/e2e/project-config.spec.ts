import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyProject } from '../../src/core/project';
import { validateProject } from '../../src/core/validation';
import type { Project } from '../../src/core/types';

const configuration = (page: Page) => page.locator('.project-config-panel');
const tabs = (page: Page) => page.locator('.workspace-tabs nav');
const undo = (page: Page) =>
  page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true });
const redo = (page: Page) =>
  page.locator('.workspace-tools').getByRole('button', { name: '重做', exact: true });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

function fixture() {
  const project = createEmptyProject('Project configuration');
  project.window.title = 'Main runtime title';
  project.windows = [
    {
      id: 'child',
      name: 'Child scene',
      config: { ...project.window, title: 'Child runtime title' },
      widgets: [],
      openOnStart: false,
    },
  ];
  return project;
}

async function open(page: Page, project = fixture()) {
  await page.addInitScript(
    (saved) => {
      if (!localStorage.getItem('quickgui.project.v1'))
        localStorage.setItem('quickgui.project.v1', saved);
    },
    JSON.stringify({ project, drafts: {} }),
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  return project;
}

async function settings(page: Page) {
  await tabs(page).getByRole('button', { name: '项目配置', exact: true }).click();
  await expect(configuration(page)).toBeVisible();
}

async function commit(page: Page, label: string, value: string) {
  const input = configuration(page).getByLabel(label, { exact: true });
  await input.fill(value);
  await input.blur();
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
  return JSON.parse(
    strFromU8(unzipSync(new Uint8Array(await readFile(destination)))['quickgui.json']),
  );
}

test('project settings keep publish metadata global while window properties stay scoped and edits survive undo and reload', async ({
  page,
}, info) => {
  const original = await open(page);
  await expect(tabs(page).locator(':scope > button')).toHaveText([
    '界面',
    '应用外观',
    '多语言',
    '流程',
    'C 脚本',
    '项目配置',
  ]);
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('child');
  const window = page.locator('.qg-window-inspector');
  await expect(window.getByLabel('窗口标题', { exact: true })).toHaveValue('Child runtime title');
  await expect(
    window.getByRole('button', { name: '重命名窗口 Child scene', exact: true }),
  ).toBeVisible();
  await window.getByLabel('启动时打开此窗口', { exact: true }).check();
  await expect(window.getByRole('button', { name: '发布', exact: true })).toHaveCount(0);
  await expect(window.getByLabel('应用名称', { exact: true })).toHaveCount(0);
  await expect(page.locator('.window-manager').getByRole('checkbox')).toHaveCount(0);
  await settings(page);
  await commit(page, '应用名称', 'Plant Control');
  await undo(page).click();
  await expect(configuration(page).getByLabel('应用名称', { exact: true })).toHaveValue(
    original.publish.appName,
  );
  await redo(page).click();
  await expect(configuration(page).getByLabel('应用名称', { exact: true })).toHaveValue(
    'Plant Control',
  );
  await commit(page, '应用标识', 'com.example.plantcontrol');
  await commit(page, '版本号', '2.3.4');
  await commit(page, '发布者', 'Plant Engineering');
  await configuration(page).getByLabel('创建桌面快捷方式', { exact: true }).uncheck();
  const version = configuration(page).getByLabel('版本号', { exact: true });
  await version.fill('invalid version');
  await version.blur();
  await expect(configuration(page).getByRole('alert')).toBeVisible();
  const saved = await exported(page, info, 'global-publish');
  expect(saved.publish).toMatchObject({
    appName: 'Plant Control',
    identifier: 'com.example.plantcontrol',
    version: '2.3.4',
    publisher: 'Plant Engineering',
    desktopShortcut: false,
  });
  expect(saved.name).toBe(original.name);
  expect(saved.window).toEqual(original.window);
  expect(saved.windows?.[0]).toMatchObject({
    id: 'child',
    name: 'Child scene',
    config: original.windows![0].config,
    openOnStart: true,
  });
  await version.focus();
  await version.press('Escape');
  await expect(version).toHaveValue('2.3.4');
  await expect(configuration(page).getByRole('alert')).toHaveCount(0);
  await tabs(page).getByRole('button', { name: '界面', exact: true }).click();
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('main');
  await expect(window.getByLabel('窗口标题', { exact: true })).toHaveValue('Main runtime title');
  await expect(window.getByLabel('启动时打开此窗口', { exact: true })).toHaveCount(0);
  await settings(page);
  await expect(configuration(page).getByLabel('应用名称', { exact: true })).toHaveValue(
    'Plant Control',
  );
  await expect(page.locator('.statusbar .save-indicator')).toContainText('已自动保存');
  await page.reload();
  await settings(page);
  await expect(configuration(page).getByLabel('应用标识', { exact: true })).toHaveValue(
    'com.example.plantcontrol',
  );
  await expect(configuration(page).getByLabel('版本号', { exact: true })).toHaveValue('2.3.4');
  expect((await exported(page, info, 'reloaded-publish')).publish).toEqual(saved.publish);
});

test('window, application and desktop shortcut icons use independent assets and removing an icon remains undoable', async ({
  page,
}, info) => {
  await open(page);
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('child');
  const window = page.locator('.qg-window-inspector');
  await window
    .getByLabel('导入窗口图标', { exact: true })
    .setInputFiles({ name: 'child-icon.png', mimeType: 'image/png', buffer: png });
  await expect(window.getByRole('img', { name: 'child-icon.png', exact: true })).toBeVisible();
  await settings(page);
  const app = configuration(page).getByRole('group', { name: '应用图标', exact: true });
  const shortcut = configuration(page).getByRole('group', { name: '快捷方式图标', exact: true });
  await app
    .getByLabel('导入应用图标', { exact: true })
    .setInputFiles({ name: 'application-icon.png', mimeType: 'image/png', buffer: png });
  await expect(app.getByRole('img', { name: 'application-icon.png', exact: true })).toBeVisible();
  await undo(page).click();
  await expect(app.locator('img')).toHaveCount(0);
  const undoneImport = await exported(page, info, 'atomic-app-icon-undone');
  expect(undoneImport.publish.icon).toBeUndefined();
  expect(undoneImport.assets.map((asset) => asset.name)).toEqual(['child-icon.png']);
  expect(undoneImport.windows![0].config.icon).toBe(undoneImport.assets[0].id);
  expect(() => validateProject(undoneImport)).not.toThrow();
  await redo(page).click();
  await expect(app.getByRole('img', { name: 'application-icon.png', exact: true })).toBeVisible();
  const redoneImport = await exported(page, info, 'atomic-app-icon-redone');
  expect(redoneImport.assets.map((asset) => asset.name)).toEqual([
    'child-icon.png',
    'application-icon.png',
  ]);
  expect(redoneImport.publish.icon).toBe(redoneImport.assets[1].id);
  expect(() => validateProject(redoneImport)).not.toThrow();
  await shortcut
    .getByLabel('导入快捷方式图标', { exact: true })
    .setInputFiles({ name: 'shortcut-icon.png', mimeType: 'image/png', buffer: png });
  await expect(shortcut.getByRole('img', { name: 'shortcut-icon.png', exact: true })).toBeVisible();
  const saved = await exported(page, info, 'independent-icons');
  const windowIcon = saved.windows![0].config.icon!;
  expect(new Set([windowIcon, saved.publish.icon, saved.publish.shortcutIcon]).size).toBe(3);
  expect(saved.window.icon).toBeUndefined();
  expect(saved.assets.find((asset) => asset.id === windowIcon)?.name).toBe('child-icon.png');
  expect(saved.assets.find((asset) => asset.id === saved.publish.icon)?.name).toBe(
    'application-icon.png',
  );
  expect(saved.assets.find((asset) => asset.id === saved.publish.shortcutIcon)?.name).toBe(
    'shortcut-icon.png',
  );
  await app.getByRole('button', { name: '移除应用图标', exact: true }).click();
  await expect(app.locator('img')).toHaveCount(0);
  const removed = await exported(page, info, 'removed-app-icon');
  expect(removed.publish.icon).toBeUndefined();
  expect(removed.publish.shortcutIcon).toBe(saved.publish.shortcutIcon);
  expect(removed.windows![0].config.icon).toBe(windowIcon);
  expect(() => validateProject(removed)).not.toThrow();
  await undo(page).click();
  await expect(app.getByRole('img', { name: 'application-icon.png', exact: true })).toBeVisible();
  await app.getByLabel('导入应用图标', { exact: true }).setInputFiles({
    name: 'invalid.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('invalid icon'),
  });
  await expect(app.getByRole('alert')).toBeVisible();
  await expect(app.getByRole('img', { name: 'application-icon.png', exact: true })).toBeVisible();
  await expect(page.locator('.statusbar .save-indicator')).toContainText('已自动保存');
  await page.reload();
  await settings(page);
  await expect(app.getByRole('img', { name: 'application-icon.png', exact: true })).toBeVisible();
  await expect(shortcut.getByRole('img', { name: 'shortcut-icon.png', exact: true })).toBeVisible();
  const restored = await exported(page, info, 'restored-icons');
  expect(restored.publish).toEqual(saved.publish);
  expect(restored.windows![0].config.icon).toBe(windowIcon);
});

test('the merged top bar keeps every section and key action usable across languages, themes and desktop widths', async ({
  page,
}, info) => {
  await open(page);
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 760 });
    for (const theme of ['dark', 'light']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.getByRole('button', { name: 'Theme', exact: true }).click();
      for (const locale of ['zh-CN', 'en']) {
        if ((await page.locator('html').getAttribute('lang')) !== locale)
          await page.getByRole('button', { name: 'Language', exact: true }).click();
        const zh = locale === 'zh-CN';
        const topbar = page.locator('header.topbar');
        await expect(topbar.locator('.workspace-tabs nav')).toBeVisible();
        await expect(page.locator('.workspace-tabs')).toHaveCount(1);
        await expect(page.locator('.app-shell > .workspace-tabs')).toHaveCount(0);
        await expect(page.locator('.workspace-name')).toHaveCount(0);
        const sections = zh
          ? ['界面', '应用外观', '多语言', '流程', 'C 脚本', '项目配置']
          : ['Design', 'Appearance', 'Languages', 'Flows', 'C scripts', 'Project settings'];
        await expect(tabs(page).locator(':scope > button')).toHaveText(sections);
        for (const name of sections) {
          const tab = tabs(page).getByRole('button', { name, exact: true });
          await tab.click();
          await expect(tab).toHaveAttribute('aria-current', 'page');
        }
        await expect(configuration(page)).toBeVisible();
        await expect(page.locator('.console-panel')).toHaveCount(0);
        const geometry = await topbar.evaluate((element) => {
          const header = element.getBoundingClientRect();
          const controls = Array.from(element.querySelectorAll('button'))
            .map((item) => {
              const box = item.getBoundingClientRect();
              return {
                name: item.textContent?.trim() || item.getAttribute('title'),
                x: box.x,
                y: box.y,
                right: box.right,
                bottom: box.bottom,
                width: box.width,
                height: box.height,
              };
            })
            .filter((item) => item.width > 0 && item.height > 0);
          const overlaps = controls.flatMap((a, index) =>
            controls
              .slice(index + 1)
              .filter(
                (b) =>
                  Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 &&
                  Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5,
              )
              .map((b) => [a.name, b.name]),
          );
          return {
            overlaps,
            outside: controls.filter(
              (item) =>
                item.x < header.left ||
                item.right > header.right ||
                item.y < header.top ||
                item.bottom > header.bottom,
            ),
            pageWidth: document.documentElement.scrollWidth,
          };
        });
        expect(geometry.overlaps).toEqual([]);
        expect(geometry.outside).toEqual([]);
        expect(geometry.pageWidth).toBe(width);
        await expect(topbar.locator('.project-menu-wrap')).toHaveCount(0);
        await expect(topbar.locator('.save-indicator')).toHaveCount(0);
        await expect(page.locator('.statusbar .save-indicator')).toBeVisible();
        await expect(topbar.locator('.brand img')).toBeVisible();
        await expect(topbar.locator('.brand strong')).toHaveText('QuickGUI');
        await expect(topbar.locator('.brand').getByText('Studio', { exact: true })).toBeVisible();
        await topbar.locator('.export-menu-wrap > button').click();
        await expect(page.locator('.export-dropdown')).toBeVisible();
        await page.keyboard.press('Escape');
        await topbar.getByRole('button', { name: zh ? '预览' : 'Preview', exact: true }).click();
        const preview = page.locator('.preview-modal');
        await expect(preview).toBeVisible();
        await preview
          .locator(':scope > header')
          .getByRole('button', { name: zh ? '关闭' : 'Close', exact: true })
          .click();
        await page.screenshot({ path: info.outputPath(`topbar-${width}-${theme}-${locale}.png`) });
      }
    }
  }
});

test('project configuration scrolls within the page at a short desktop size in both designer themes', async ({
  page,
}, info) => {
  await open(page);
  await page.setViewportSize({ width: 1100, height: 520 });
  await settings(page);
  const scroll = configuration(page).locator('.project-config-scroll');
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(page.locator('.console-panel')).toHaveCount(0);
    expect(await scroll.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
      await scroll.evaluate((element) => element.clientHeight),
    );
    await scroll.evaluate((element) => element.scrollTo(0, 0));
    const headingY = (await configuration(page).locator('.resource-heading').boundingBox())!.y;
    await scroll.hover();
    await page.mouse.wheel(0, 700);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await configuration(page).locator('.resource-heading').boundingBox())!.y).toBe(
      headingY,
    );
    await configuration(page).getByLabel('创建桌面快捷方式', { exact: true }).focus();
    await expect(configuration(page).getByLabel('创建桌面快捷方式', { exact: true })).toBeFocused();
    expect(
      await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      })),
    ).toEqual({ width: 1100, height: 520 });
    await page.screenshot({ path: info.outputPath(`project-config-scroll-${theme}.png`) });
  }
});

test('finishing a delayed icon read after switching windows or pages does not mutate the active project', async ({
  page,
}, info) => {
  // Delay only the browser file-read boundary, then let the original FileReader finish for real.
  await page.addInitScript(() => {
    const read = FileReader.prototype.readAsDataURL;
    const pending: { reader: FileReader; file: Blob }[] = [];
    let completed = 0;
    FileReader.prototype.readAsDataURL = function (file) {
      pending.push({ reader: this, file });
    };
    Object.assign(window, {
      iconReadHarness: {
        get pending() {
          return pending.length;
        },
        get completed() {
          return completed;
        },
        async releaseNext() {
          const next = pending.shift();
          if (!next) throw new Error('No pending icon read');
          await new Promise<void>((resolve, reject) => {
            next.reader.addEventListener(
              'loadend',
              () => {
                completed++;
                if (next.reader.error) reject(next.reader.error);
                else resolve();
              },
              { once: true },
            );
            read.call(next.reader, next.file);
          });
        },
      },
    });
  });
  const original = await open(page);
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('child');
  await page
    .locator('.qg-window-inspector')
    .getByLabel('导入窗口图标', { exact: true })
    .setInputFiles({ name: 'late-window.png', mimeType: 'image/png', buffer: png });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { iconReadHarness: { pending: number } }).iconReadHarness.pending,
      ),
    )
    .toBe(1);
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('main');
  await expect(
    page.locator('.qg-window-inspector').getByLabel('窗口标题', { exact: true }),
  ).toHaveValue('Main runtime title');
  await page.evaluate(() =>
    (
      window as unknown as { iconReadHarness: { releaseNext: () => Promise<void> } }
    ).iconReadHarness.releaseNext(),
  );
  const switchedWindow = await exported(page, info, 'cancelled-window-icon');
  expect(switchedWindow.assets).toEqual(original.assets);
  expect(switchedWindow.window).toEqual(original.window);
  expect(switchedWindow.windows).toEqual(original.windows);
  await settings(page);
  await configuration(page)
    .getByLabel('导入应用图标', { exact: true })
    .setInputFiles({ name: 'late-app.png', mimeType: 'image/png', buffer: png });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { iconReadHarness: { pending: number } }).iconReadHarness.pending,
      ),
    )
    .toBe(1);
  await tabs(page).getByRole('button', { name: '界面', exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { iconReadHarness: { releaseNext: () => Promise<void> } }
    ).iconReadHarness.releaseNext(),
  );
  const switchedPage = await exported(page, info, 'cancelled-application-icon');
  expect(switchedPage.assets).toEqual(original.assets);
  expect(switchedPage.publish).toEqual(original.publish);
  expect(switchedPage.window).toEqual(original.window);
  expect(switchedPage.windows).toEqual(original.windows);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { iconReadHarness: { completed: number } }).iconReadHarness.completed,
    ),
  ).toBe(2);
  await expect(undo(page)).toBeDisabled();
});

test('project management shows stable identity and opens, renames and saves projects from the configuration page', async ({
  page,
}, info) => {
  const original = await open(page);
  await settings(page);
  const management = configuration(page).getByRole('region', { name: '工程管理', exact: true });
  await expect(management.getByTestId('project-name')).toHaveText(original.name);
  await expect(management.getByTestId('project-id')).toHaveText(original.id);
  await expect(management.getByRole('button')).toHaveText([
    '新建工程',
    '打开工程',
    '重命名工程',
    '保存工程',
    '关闭工程',
  ]);
  await expect(page.locator('.topbar .project-menu-wrap')).toHaveCount(0);
  await management.getByRole('button', { name: '重命名工程', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名工程', exact: true });
  await rename.getByLabel('工程名称', { exact: true }).fill('Managed plant project');
  await rename.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(management.getByTestId('project-name')).toHaveText('Managed plant project');
  await expect(management.getByTestId('project-id')).toHaveText(original.id);
  const pendingDownload = page.waitForEvent('download');
  await management.getByRole('button', { name: '保存工程', exact: true }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('Managed plant project.qgui');
  const savedPath = info.outputPath('management-save.qgui');
  await download.saveAs(savedPath);
  const saved = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(await readFile(savedPath)))['quickgui.json']),
  ) as Project;
  expect(saved.id).toBe(original.id);
  expect(saved.name).toBe('Managed plant project');
  expect(saved.publish).toEqual(original.publish);
  await expect(page.locator('.statusbar .save-indicator')).toContainText('已自动保存');
  const incoming = createEmptyProject('Opened via project management');
  const chooser = page.waitForEvent('filechooser');
  await management.getByRole('button', { name: '打开工程', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'incoming.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(incoming)),
  });
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await settings(page);
  await expect(management.getByTestId('project-name')).toHaveText(incoming.name);
  await expect(management.getByTestId('project-id')).toHaveText(incoming.id);
  await management.getByRole('button', { name: '关闭工程', exact: true }).click();
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expect(management.getByTestId('project-name')).toHaveText(incoming.name);
});
