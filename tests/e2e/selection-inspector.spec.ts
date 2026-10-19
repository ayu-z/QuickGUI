import { expect, test, type Page } from '@playwright/test';
import { createEmptyProject, createWidget } from '../../src/core/project';
import type { Project } from '../../src/core/types';

function fixture() {
  const project = createEmptyProject('Selection inspector');
  project.window.title = 'Main inspector window';
  project.widgets = ['Alpha', 'Beta'].map((name, index) => ({
    ...createWidget('button', 40 + index * 160, 60),
    id: name.toLowerCase(),
    name,
    layout: { x: 40 + index * 160, y: 60, width: 120, height: 40 },
  }));
  return project;
}
async function open(page: Page, project: Project) {
  await page.addInitScript(
    (recovery) => {
      localStorage.setItem('quickgui.project.v1', recovery);
    },
    JSON.stringify({ project, drafts: {} }),
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
}
const widget = (page: Page, id: string) => page.locator(`[data-design-widget="${id}"]`);
const blank = async (page: Page) => {
  await page.getByTestId('design-canvas').click({ position: { x: 420, y: 260 } });
};
const windowTitle = (page: Page) =>
  page.locator('.qg-window-inspector').getByLabel('窗口标题', { exact: true });

test('blank canvas, Escape and deleting the selection show the current window properties', async ({
  page,
}) => {
  await open(page, fixture());
  await widget(page, 'alpha').click();
  await expect(page.locator('.qg-inspector')).toBeVisible();
  await blank(page);
  await expect(windowTitle(page)).toHaveValue('Main inspector window');
  await expect(page.locator('.qg-design-widget.is-selected')).toHaveCount(0);

  await widget(page, 'beta').click();
  await expect(page.locator('.qg-inspector').getByLabel('名称', { exact: true })).toHaveValue(
    'Beta',
  );
  await page.keyboard.press('Escape');
  await expect(windowTitle(page)).toHaveValue('Main inspector window');

  await widget(page, 'alpha').click();
  await page.keyboard.press('Delete');
  await expect(widget(page, 'alpha')).toHaveCount(0);
  await expect(windowTitle(page)).toHaveValue('Main inspector window');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(widget(page, 'alpha')).toBeVisible();
  await expect(windowTitle(page)).toHaveValue('Main inspector window');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(widget(page, 'alpha')).toHaveCount(0);
  await expect(windowTitle(page)).toHaveValue('Main inspector window');
});

test('property input blur and multi-selection keep widget properties until selection is explicitly cleared', async ({
  page,
}) => {
  await open(page, fixture());
  await widget(page, 'alpha').click();
  const inspector = page.locator('.qg-inspector'),
    name = inspector.getByLabel('名称', { exact: true });
  await name.fill('Renamed Alpha');
  await name.press('Tab');
  await expect(name).toHaveValue('Renamed Alpha');
  await expect(widget(page, 'alpha')).toHaveClass(/is-selected/);
  await expect(page.locator('.qg-window-inspector')).toHaveCount(0);
  await inspector.locator('.qg-inspector-heading').click();
  await expect(widget(page, 'alpha')).toHaveClass(/is-selected/);
  await widget(page, 'beta').click({ modifiers: ['Shift'] });
  await expect(page.locator('.qg-design-widget.is-selected')).toHaveCount(2);
  await expect(inspector).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.qg-design-widget.is-selected')).toHaveCount(0);
  await expect(windowTitle(page)).toHaveValue('Main inspector window');
});

test('canceling module selection shows module metadata and keeps canonical window properties independent', async ({
  page,
}) => {
  const project = fixture();
  project.modules = [
    {
      id: 'editable_module',
      name: 'Editable module',
      version: '1.0.0',
      width: 640,
      height: 400,
      widgets: [{ ...createWidget('button', 32, 32), id: 'module_button' }],
      exposedProps: {},
    },
  ];
  await open(page, project);
  await page.locator('.left-tabs').getByRole('button', { name: '模块', exact: true }).click();
  await page.locator('.module-card').getByRole('button', { name: '编辑定义', exact: true }).click();
  await expect(widget(page, 'module_button')).toBeVisible();
  await widget(page, 'module_button').click();
  await blank(page);
  const metadata = page.locator('.qg-module-inspector');
  await expect(metadata.getByLabel('模块名称', { exact: true })).toHaveValue('Editable module');
  await expect(page.locator('.qg-window-inspector')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '退出模块定义', exact: true })).toBeVisible();
  await metadata.getByLabel('模块名称', { exact: true }).fill('Renamed module');
  await metadata.getByLabel('模块名称', { exact: true }).blur();
  await widget(page, 'module_button').click();
  await expect(page.locator('.qg-inspector')).toBeVisible();
  await expect(page.locator('.canvas-heading')).toContainText('Renamed module');
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('quickgui.project.v1')!).project.window.title,
      ),
    )
    .toBe('Main inspector window');
  await page
    .locator('.workspace-tools')
    .getByRole('button', { name: '窗口属性', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '退出模块定义', exact: true })).toHaveCount(0);
  await expect(windowTitle(page)).toHaveValue('Main inspector window');
  await windowTitle(page).fill('Canonical window title');
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('quickgui.project.v1')!).project.window.title,
      ),
    )
    .toBe('Canonical window title');
});

test('empty projects and empty auxiliary windows open directly on their own window properties', async ({
  page,
}) => {
  const project = createEmptyProject('Empty inspector');
  project.windows = [
    {
      id: 'child',
      name: 'Child inspector',
      config: { ...project.window, title: 'Child title' },
      widgets: [],
      openOnStart: false,
    },
  ];
  await open(page, project);
  await expect(windowTitle(page)).toHaveValue(project.window.title);
  await page.getByRole('combobox', { name: '选择窗口', exact: true }).selectOption('child');
  await expect(windowTitle(page)).toHaveValue('Child title');
});
