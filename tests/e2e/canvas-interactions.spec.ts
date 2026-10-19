import { expect, test, type Page } from '@playwright/test';
import { createProject, createWidget } from '../../src/core/project';
import { upgradeProject } from '../../src/core/migration';
import { createSerialAssistantProject } from '../../src/examples/serialAssistant';

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
const revision = async (page: Page) =>
  Number((await page.locator('.statusbar').textContent())!.match(/rev (\d+)/)![1]);

test('dragging the 64-widget demo keeps model work out of pointer moves and saves one final edit', async ({
  page,
}) => {
  const project = createSerialAssistantProject();
  await page.addInitScript(
    (recovery) => {
      localStorage.setItem('quickgui.project.v1', recovery);
    },
    JSON.stringify({ project, drafts: {} }),
  );
  await page.goto('/');
  await expect(page.locator('[data-design-widget]')).toHaveCount(64);
  const target = widget(page, 'scan_ports');
  await target.click();
  const before = (await target.boundingBox())!,
    initialRevision = await revision(page),
    start = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 100, start.y + 50, { steps: 35 });
  await expect.poll(async () => (await target.boundingBox())!.x).toBeGreaterThan(before.x + 80);
  expect(await revision(page)).toBe(initialRevision);
  const savedDuringDrag = await page.evaluate(
    () => JSON.parse(localStorage.getItem('quickgui.project.v1')!).project,
  );
  expect(
    savedDuringDrag.widgets.find((widget: { id: string }) => widget.id === 'scan_ports').layout,
  ).toEqual(project.widgets.find((widget) => widget.id === 'scan_ports')!.layout);
  await page.mouse.up();
  await expect.poll(() => revision(page)).toBe(initialRevision + 1);
  const finalLayout = await target.evaluate((element) => ({
    x: parseFloat((element as HTMLElement).style.left),
    y: parseFloat((element as HTMLElement).style.top),
  }));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('quickgui.project.v1')!).project.widgets.find(
            (widget: { id: string }) => widget.id === 'scan_ports',
          ).layout.x,
      ),
    )
    .toBe(finalLayout.x);
  await page.keyboard.press('ControlOrMeta+z');
  expect((await target.boundingBox())!.x).toBeCloseTo(before.x, 0);
  await expect(
    page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await target.evaluate((element) => parseFloat((element as HTMLElement).style.left))).toBe(
    finalLayout.x,
  );
});

test('release commits the latest pointer coordinate and cancellation discards queued move and resize frames', async ({
  page,
}) => {
  await openFixture(page);
  const alpha = widget(page, 'alpha'),
    initialRevision = await revision(page),
    zoom = await page
      .getByTestId('design-canvas')
      .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  const startPointer = async (target = alpha) => {
    await target.evaluate((element) =>
      element.addEventListener(
        'pointerdown',
        (event) => {
          (element as HTMLElement).dataset.testPointer = String((event as PointerEvent).pointerId);
        },
        { once: true, capture: true },
      ),
    );
    const box = (await target.boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    return start;
  };
  let start = await startPointer();
  await alpha.evaluate(
    (element, point) => {
      element.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: Number((element as HTMLElement).dataset.testPointer),
          clientX: point.x,
          clientY: point.y,
        }),
      );
    },
    { x: start.x + 56 * zoom, y: start.y + 24 * zoom },
  );
  await page.mouse.up();
  expect(
    await alpha.evaluate((element) => [
      (element as HTMLElement).style.left,
      (element as HTMLElement).style.top,
    ]),
  ).toEqual(['96px', '104px']);
  expect(await revision(page)).toBe(initialRevision + 1);
  const committed = await alpha.getAttribute('style');
  for (const kind of ['move', 'resize'] as const) {
    const target = kind === 'move' ? alpha : alpha.locator('.qg-resize-nw');
    start = await startPointer(target);
    await target.evaluate(
      (element, point) => {
        const pointerId = Number((element as HTMLElement).dataset.testPointer);
        element.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId,
            clientX: point.x,
            clientY: point.y,
          }),
        );
        element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId }));
      },
      { x: start.x + 30 * zoom, y: start.y + 16 * zoom },
    );
    await page.mouse.up();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await alpha.getAttribute('style')).toBe(committed);
    expect(await revision(page)).toBe(initialRevision + 1);
  }
  for (const kind of ['move', 'resize'] as const) {
    const target = kind === 'move' ? alpha : alpha.locator('.qg-resize-nw');
    start = await startPointer(target);
    // Another touch must neither replace nor cancel the active mouse gesture.
    await target.evaluate((element) => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 73,
          pointerType: 'touch',
          button: 0,
        }),
      );
      element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 73 }));
    });
    await page.mouse.move(start.x + 30, start.y + 15, { steps: 4 });
    await expect(alpha).not.toHaveAttribute('style', committed!);
    expect(await revision(page)).toBe(initialRevision + 1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    expect(await alpha.getAttribute('style')).toBe(committed);
    expect(await revision(page)).toBe(initialRevision + 1);
  }
  start = await startPointer();
  await page.mouse.move(start.x + 40, start.y + 20, { steps: 4 });
  await page.keyboard.press('ControlOrMeta+z');
  await page.mouse.up();
  expect(await alpha.getAttribute('style')).toBe(committed);
  expect(await revision(page)).toBe(initialRevision + 1);
});

test('flow block positions stay local during dragging and commit as one undoable edit', async ({
  page,
}) => {
  const project = createSerialAssistantProject();
  await page.addInitScript(
    (recovery) => {
      localStorage.setItem('quickgui.project.v1', recovery);
    },
    JSON.stringify({ project, drafts: {} }),
  );
  await page.goto('/');
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '流程', exact: true })
    .click();
  const target = page.locator('.react-flow__node[data-id="serial_scan_0"]'),
    header = target.locator('.qg-flow-card-header');
  await header.click();
  const before = await target.getAttribute('style'),
    box = (await header.boundingBox())!,
    initialRevision = await revision(page),
    start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y + 40, { steps: 30 });
  await expect(target).not.toHaveAttribute('style', before!);
  expect(await revision(page)).toBe(initialRevision);
  await page.mouse.up();
  await expect.poll(() => revision(page)).toBe(initialRevision + 1);
  const after = await target.getAttribute('style');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(target).toHaveAttribute('style', before!);
  await expect(
    page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(target).toHaveAttribute('style', after!);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const project = JSON.parse(localStorage.getItem('quickgui.project.v1')!).project;
        return project.flows[0].nodes.find((node: { id: string }) => node.id === 'serial_scan_0')
          .position;
      }),
    )
    .not.toEqual(project.flows[0].nodes.find((node) => node.id === 'serial_scan_0')!.position);
});

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
  await expect(page.locator('.statusbar .save-indicator')).toContainText('已自动保存');
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
