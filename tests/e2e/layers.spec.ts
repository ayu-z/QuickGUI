import { expect, test, type Page } from '@playwright/test';
import { createEmptyProject, createWidget } from '../../src/core/project';
import type { Project, Widget } from '../../src/core/types';

const layer = (page: Page, id: string) => page.locator(`[data-layer-id="${id}"]`);
const item = (page: Page, id: string) => page.locator(`[data-tree-id="${id}"]`);
const row = (page: Page, id: string) => item(page, id).locator(':scope > .qg-tree-row');
const canvas = (page: Page, id: string) => page.locator(`[data-design-widget="${id}"]`);
const recovered = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('quickgui.project.v1')!) as {
        project: Project;
        drafts: Record<string, string>;
      },
  );
const saved = async (page: Page) => (await recovered(page)).project;

function fixture() {
  const project = createEmptyProject('Layer hierarchy');
  const button = (id: string, name: string, x: number, y: number, parentId?: string): Widget => ({
    ...createWidget('button', x, y),
    id,
    name,
    ...(parentId ? { parentId } : {}),
    layout: { x, y, width: 110, height: 36 },
  });
  const panel = {
    ...createWidget('panel', 340, 60),
    id: 'panel',
    name: 'Container',
    layout: { x: 340, y: 60, width: 420, height: 280 },
    props: { enabled: true, visible: true, title: '', overflow: 'visible' },
    style: { ...createWidget('panel').style, borderWidth: 2, padding: 16 },
  };
  const nested = {
    ...createWidget('panel', 20, 30),
    id: 'nested',
    name: 'Nested',
    parentId: 'panel',
    layout: { x: 20, y: 30, width: 200, height: 150 },
    props: { enabled: true, visible: true, title: '', overflow: 'visible' },
  };
  project.widgets = [
    button('alpha', 'Alpha', 30, 50),
    button('beta', 'Beta', 160, 50),
    button('gamma', 'Gamma', 30, 160),
    panel,
    nested,
    button('needle', 'Needle', 10, 20, 'nested'),
    { ...button('locked', 'Locked', 30, 240), editor: { locked: true } },
  ];
  return project;
}
async function open(page: Page, project = fixture(), drafts: Record<string, string> = {}) {
  await page.addInitScript(
    (raw) => localStorage.setItem('quickgui.project.v1', raw),
    JSON.stringify({ project, drafts }),
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.locator('.qg-layer-tree')).toBeVisible();
  return project;
}
async function expectPosition(
  page: Page,
  id: string,
  before: { x: number; y: number; width: number; height: number },
) {
  const after = (await canvas(page, id).boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(Math.abs(after.width - before.width)).toBeLessThan(1);
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);
}

test('collapse controls, search and canvas selection reveal ancestors, with roving focus and range selection', async ({
  page,
}) => {
  await open(page);
  expect(
    await page
      .locator('.qg-layer-tree > [role="treeitem"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-tree-id'))),
  ).toEqual(['locked', 'panel', 'gamma', 'beta', 'alpha']);
  await page.getByRole('button', { name: '收起全部图层', exact: true }).click();
  await expect(item(page, 'panel')).toHaveAttribute('aria-expanded', 'false');
  await expect(layer(page, 'needle')).toHaveCount(0);
  const search = page.getByPlaceholder('查找图层…');
  await search.fill('Needle');
  await expect(layer(page, 'needle')).toBeVisible();
  await expect(item(page, 'panel')).toHaveAttribute('aria-expanded', 'true');
  await expect(layer(page, 'alpha')).toHaveCount(0);
  await search.fill('');
  await expect(layer(page, 'needle')).toHaveCount(0);
  await canvas(page, 'needle').click();
  await expect(layer(page, 'needle')).toBeVisible();
  await expect(item(page, 'nested')).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: '收起全部图层', exact: true }).click();
  await layer(page, 'alpha').click();
  await layer(page, 'gamma').click({ modifiers: ['Shift'] });
  await expect(page.locator('.qg-layer-tree [aria-selected="true"]')).toHaveCount(3);
  await page.keyboard.press('End');
  await expect(item(page, 'alpha')).toBeFocused();
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(item(page, 'gamma')).toBeFocused();
  await expect(page.locator('.qg-layer-tree [aria-selected="true"]')).toHaveCount(3);
  await page.keyboard.press('ArrowUp');
  await expect(item(page, 'panel')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(item(page, 'panel')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(item(page, 'nested')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(item(page, 'needle')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(item(page, 'nested')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(item(page, 'nested')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.qg-layer-tree [role="treeitem"][tabindex="0"]')).toHaveCount(1);
});

test('nonadjacent grouping keeps child IDs, positions, CODE drafts and one undoable change', async ({
  page,
}) => {
  const project = await open(page, fixture(), { alpha: '{ unfinished CODE draft' });
  const alpha = (await canvas(page, 'alpha').boundingBox())!,
    gamma = (await canvas(page, 'gamma').boundingBox())!;
  await layer(page, 'alpha').click();
  await layer(page, 'gamma').click({ modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('ControlOrMeta+g');
  await expect
    .poll(async () => (await saved(page)).widgets.length)
    .toBe(project.widgets.length + 1);
  const grouped = await saved(page),
    group = grouped.widgets.find((widget) => !project.widgets.some((old) => old.id === widget.id))!;
  expect(group.type).toBe('panel');
  expect(grouped.widgets.find((widget) => widget.id === 'alpha')!.parentId).toBe(group.id);
  expect(grouped.widgets.find((widget) => widget.id === 'gamma')!.parentId).toBe(group.id);
  expect(grouped.widgets.find((widget) => widget.id === 'beta')!.parentId).toBeUndefined();
  expect(grouped.widgets.filter((widget) => !widget.parentId).map((widget) => widget.id)).toEqual([
    'beta',
    group.id,
    'panel',
    'locked',
  ]);
  expect(
    await page
      .locator('.qg-layer-tree > [role="treeitem"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-tree-id'))),
  ).toEqual(['locked', 'panel', group.id, 'beta']);
  expect(grouped.revision).toBe(project.revision + 1);
  expect((await recovered(page)).drafts.alpha).toBe('{ unfinished CODE draft');
  await expectPosition(page, 'alpha', alpha);
  await expectPosition(page, 'gamma', gamma);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await saved(page)).widgets).toEqual(project.widgets);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await saved(page)).widgets).toEqual(grouped.widgets);
  await layer(page, group.id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^取消组合/ }).click();
  const flattened = ['beta', 'alpha', 'gamma', 'panel', 'nested', 'needle', 'locked'].map((id) =>
    project.widgets.find((widget) => widget.id === id)!,
  );
  await expect.poll(async () => (await saved(page)).widgets).toEqual(flattened);
  expect((await recovered(page)).drafts.alpha).toBe('{ unfinished CODE draft');
  await expectPosition(page, 'alpha', alpha);
  await expectPosition(page, 'gamma', gamma);
  await expect(item(page, 'alpha')).toHaveAttribute('aria-selected', 'true');
  await expect(item(page, 'gamma')).toHaveAttribute('aria-selected', 'true');
});

test('layer drag reorders and reparents without canvas jumps, and rejects cycles and locked movement', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('[data-layer-root-drop]')).toBeVisible();
  await row(page, 'gamma').dragTo(row(page, 'alpha'), { targetPosition: { x: 75, y: 2 } });
  await expect
    .poll(async () =>
      (await saved(page)).widgets.filter((widget) => !widget.parentId).map((widget) => widget.id),
    )
    .toEqual(['alpha', 'gamma', 'beta', 'panel', 'locked']);
  await row(page, 'gamma').dragTo(row(page, 'alpha'), { targetPosition: { x: 75, y: 29 } });
  await expect
    .poll(async () =>
      (await saved(page)).widgets.filter((widget) => !widget.parentId).map((widget) => widget.id),
    )
    .toEqual(['gamma', 'alpha', 'beta', 'panel', 'locked']);
  const before = (await canvas(page, 'alpha').boundingBox())!;
  await row(page, 'alpha').dragTo(row(page, 'panel'), { targetPosition: { x: 75, y: 15 } });
  await expect
    .poll(async () => (await saved(page)).widgets.find((widget) => widget.id === 'alpha')?.parentId)
    .toBe('panel');
  await expectPosition(page, 'alpha', before);
  await row(page, 'alpha').dragTo(page.locator('[data-layer-root-drop]'));
  await expect
    .poll(async () => (await saved(page)).widgets.find((widget) => widget.id === 'alpha')?.parentId)
    .toBeUndefined();
  await expectPosition(page, 'alpha', before);
  const stable = await saved(page);
  await row(page, 'panel').dragTo(row(page, 'nested'), { targetPosition: { x: 75, y: 15 } });
  await expect.poll(async () => (await saved(page)).revision).toBe(stable.revision);
  expect((await saved(page)).widgets).toEqual(stable.widgets);
  await expect(row(page, 'locked')).toHaveAttribute('draggable', 'false');
});

test('layer rename supports F2, Enter and Escape without replacing IDs or disturbing hierarchy', async ({
  page,
}) => {
  await open(page);
  await layer(page, 'needle').click();
  await page.keyboard.press('F2');
  const name = page.getByRole('textbox', { name: '图层名称', exact: true });
  await expect(name).toHaveValue('Needle');
  await name.fill('Sensor input');
  await name.press('Enter');
  await expect(layer(page, 'needle')).toHaveText('Sensor input');
  await expect
    .poll(async () => (await saved(page)).widgets.find((widget) => widget.id === 'needle')?.name)
    .toBe('Sensor input');
  expect((await saved(page)).widgets.find((widget) => widget.id === 'needle')?.parentId).toBe(
    'nested',
  );
  await page.keyboard.press('F2');
  await name.fill('Discard rename');
  await name.press('Escape');
  await expect(layer(page, 'needle')).toHaveText('Sensor input');
  await page.keyboard.press('F2');
  await name.fill('');
  await name.press('Enter');
  await expect(page.locator('.qg-layer-status')).toContainText('图层名称应为');
  expect((await saved(page)).widgets.find((widget) => widget.id === 'needle')?.name).toBe(
    'Sensor input',
  );
  await name.press('Escape');
  await layer(page, 'locked').dblclick();
  await expect(name).toHaveCount(0);
});
