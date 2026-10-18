import { expect, test, type Page } from '@playwright/test';
import { createProject, createWidget } from '../../src/core/project';
import { upgradeProject } from '../../src/core/migration';

async function openFixture(page: Page) {
  const project = upgradeProject(createProject());
  project.widgets = ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({
    ...createWidget('button', 40 + index * 180, 80 + index * 80),
    id: name.toLowerCase(),
    name,
    props: { text: name, enabled: true, visible: true },
    layout: { x: 40 + index * 180, y: 80 + index * 80, width: 120, height: 40 },
  }));
  await page.goto('/');
  await page.locator('input[accept=".qgui,.json"]').setInputFiles({
    name: 'interactions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.locator('[data-design-widget]')).toHaveCount(3);
  return project;
}
const widget = (page: Page, id: string) => page.locator(`[data-design-widget="${id}"]`);

test('wheel keeps the pointer anchor, pan is local and viewport survives reload', async ({
  page,
}) => {
  const project = await openFixture(page),
    canvas = page.getByTestId('design-canvas'),
    viewport = page.locator('.qg-canvas-viewport');
  const rect = (await canvas.boundingBox())!,
    scale = await canvas.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  const cursor = { x: Math.round(rect.x + 200 * scale), y: Math.round(rect.y + 150 * scale) };
  const anchor = { x: (cursor.x - rect.x) / scale, y: (cursor.y - rect.y) / scale };
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.wheel(0, -120);
  await expect
    .poll(() => canvas.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a))
    .toBeGreaterThan(scale);
  const changed = (await canvas.boundingBox())!,
    next = await canvas.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  expect((cursor.x - changed.x) / next).toBeCloseTo(anchor.x, 1);
  expect((cursor.y - changed.y) / next).toBeCloseTo(anchor.y, 1);
  await viewport.focus();
  await page.keyboard.down('Space');
  const bounds = (await viewport.boundingBox())!;
  await page.mouse.move(bounds.x + 40, bounds.y + 35);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 130, bounds.y + 95, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const moved = (await canvas.boundingBox())!;
  expect(moved.x).toBeCloseTo(changed.x + 90, 0);
  expect(moved.y).toBeCloseTo(changed.y + 60, 0);
  const key = `quickgui.canvas-view.v1/${project.id}/window/main`;
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.zoom, key))
    .toBeCloseTo(next, 4);
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.x, key))
    .toBeCloseTo(moved.x - bounds.x, 0);
  await page.reload();
  await expect(canvas).toBeVisible();
  expect((await canvas.boundingBox())!.x).toBeCloseTo(moved.x, 0);
  expect((await canvas.boundingBox())!.y).toBeCloseTo(moved.y, 0);
  await expect(
    page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }),
  ).toBeDisabled();
  const reloadedViewport = (await viewport.boundingBox())!;
  await page.mouse.move(reloadedViewport.x + 80, reloadedViewport.y + 60);
  for (let index = 0; index < 8; index++) await page.mouse.wheel(0, -250);
  await expect
    .poll(() => canvas.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a))
    .toBe(8);
  for (let index = 0; index < 12; index++) await page.mouse.wheel(0, 250);
  await expect
    .poll(() => canvas.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a))
    .toBe(0.1);
  const beforeMiddle = (await canvas.boundingBox())!;
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(reloadedViewport.x + 120, reloadedViewport.y + 90, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  expect((await canvas.boundingBox())!.x).toBeCloseTo(beforeMiddle.x + 40, 0);
  expect((await canvas.boundingBox())!.y).toBeCloseTo(beforeMiddle.y + 30, 0);
});

test('one pointer drag creates one undo and Escape rolls back an unfinished gesture', async ({
  page,
}) => {
  await openFixture(page);
  const alpha = widget(page, 'alpha'),
    before = await alpha.evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    }));
  const box = (await alpha.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 130, box.y + box.height / 2 + 70, { steps: 25 });
  await page.mouse.up();
  const after = await alpha.evaluate((el) => ({
    left: (el as HTMLElement).style.left,
    top: (el as HTMLElement).style.top,
  }));
  expect(after).not.toEqual(before);
  await page.keyboard.press('ControlOrMeta+z');
  expect(
    await alpha.evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    })),
  ).toEqual(before);
  await expect(
    page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  const current = (await alpha.boundingBox())!;
  await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2);
  await page.mouse.down();
  await page.mouse.move(current.x + current.width / 2 + 60, current.y + current.height / 2 + 30, {
    steps: 8,
  });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(
    await alpha.evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    })),
  ).toEqual(after);
});

test('multi-selection, alignment, eight resize grips and persistent editor visibility share commands', async ({
  page,
}) => {
  await openFixture(page);
  await widget(page, 'alpha').click();
  await widget(page, 'beta').click({ modifiers: ['Shift'] });
  await widget(page, 'gamma').click({ modifiers: ['Shift'] });
  await expect(page.locator('.qg-design-widget.is-selected')).toHaveCount(3);
  const starts = await page.locator('[data-design-widget]').evaluateAll((elements) =>
    elements.map((element) => ({
      x: parseFloat((element as HTMLElement).style.left),
      y: parseFloat((element as HTMLElement).style.top),
    })),
  );
  const groupHandle = (await widget(page, 'beta').boundingBox())!;
  await page.mouse.move(
    groupHandle.x + groupHandle.width / 2,
    groupHandle.y + groupHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    groupHandle.x + groupHandle.width / 2 + 40,
    groupHandle.y + groupHandle.height / 2 + 24,
    { steps: 8 },
  );
  await page.mouse.up();
  const ends = await page.locator('[data-design-widget]').evaluateAll((elements) =>
    elements.map((element) => ({
      x: parseFloat((element as HTMLElement).style.left),
      y: parseFloat((element as HTMLElement).style.top),
    })),
  );
  const shifts = ends.map((point, index) => ({
    x: point.x - starts[index].x,
    y: point.y - starts[index].y,
  }));
  expect(shifts[0].x).toBeGreaterThan(0);
  expect(shifts[1]).toEqual(shifts[0]);
  expect(shifts[2]).toEqual(shifts[0]);
  await page.keyboard.press('ControlOrMeta+z');
  await widget(page, 'beta').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '顶部对齐', exact: true }).click();
  expect(
    await page
      .locator('[data-design-widget]')
      .evaluateAll((elements) => elements.map((el) => (el as HTMLElement).style.top)),
  ).toEqual(['80px', '80px', '80px']);
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('[data-design-widget]')).toHaveCount(6);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('[data-design-widget]')).toHaveCount(3);
  await page.locator('[data-layer-id="alpha"]').click();
  await expect(widget(page, 'alpha').locator('.qg-resize-grip')).toHaveCount(8);
  await page.getByRole('button', { name: '锁定 Alpha', exact: true }).click();
  await expect(widget(page, 'alpha')).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: '解锁 Alpha', exact: true }).click();
  await expect(widget(page, 'alpha')).toHaveAttribute('aria-disabled', 'false');
  await page.getByRole('button', { name: '隐藏 Alpha', exact: true }).click();
  await expect(widget(page, 'alpha')).toHaveCount(0);
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await expect(widget(page, 'alpha')).toHaveCount(0);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(
    page.locator('.preview-modal').getByRole('button', { name: 'Alpha', exact: true }),
  ).toBeVisible();
  await page
    .locator('.preview-modal > header')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '显示 Alpha', exact: true }).click();
  await expect(widget(page, 'alpha')).toBeVisible();
  const grip = (await widget(page, 'alpha').locator('.qg-resize-se').boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(
    await widget(page, 'alpha').evaluate(
      (element) =>
        parseFloat((element as HTMLElement).style.width) /
        parseFloat((element as HTMLElement).style.height),
    ),
  ).toBeCloseTo(3, 4);
  await page.keyboard.press('ControlOrMeta+z');
  const canvas = page.getByTestId('design-canvas'),
    r = (await canvas.boundingBox())!,
    z = await canvas.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  await page.mouse.move(r.x + 20 * z, r.y + 60 * z);
  await page.mouse.down();
  await page.mouse.move(r.x + 550 * z, r.y + 150 * z, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.qg-design-widget.is-selected')).toHaveCount(3);
});
