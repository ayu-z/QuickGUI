import { expect, test, type Page } from '@playwright/test';
import { createEmptyProject, createWidget } from '../../src/core/project';

function fixture() {
  const project = createEmptyProject('下拉菜单回归');
  const input = createWidget('input', 40, 40, 2);
  input.id = 'input';
  const select = createWidget('select', 40, 120, 2);
  select.id = 'runtime-select';
  select.layout.height = 58;
  select.style.padding = 0;
  select.style.borderWidth = 0;
  project.widgets = [input, select];
  project.variables = [{ id: 'number', name: 'Number', type: 'number', initial: 1 }];
  project.flows = [
    {
      id: 'manual',
      name: '手动流程',
      enabled: false,
      nodes: [
        {
          id: 'event',
          label: '手动事件',
          kind: 'event',
          position: { x: 100, y: 100 },
          config: { trigger: 'manual' },
        },
      ],
      edges: [],
    },
  ];
  project.connections = [
    {
      id: 'service',
      name: 'HTTP Service',
      protocol: 'http',
      config: { url: 'http://127.0.0.1:8080' },
    },
  ];
  return project;
}

async function consistentSelects(page: Page) {
  const controls = await page.locator('select').evaluateAll((elements) =>
    elements
      .filter((element): element is HTMLSelectElement => element instanceof HTMLSelectElement)
      .filter(
        (element) =>
          !element.closest('.qg-widget,.qg-scene') &&
          !element.multiple &&
          !element.hasAttribute('size') &&
          element.getBoundingClientRect().width > 0,
      )
      .map((element) => ({
        height: element.getBoundingClientRect().height,
        text: element.selectedOptions[0]?.textContent,
      })),
  );
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.filter((control) => control.height !== 32)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (saved) => {
      localStorage.setItem('quickgui.project.v1', saved);
    },
    JSON.stringify({ project: fixture(), drafts: {} }),
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
});

for (const theme of ['dark', 'light']) {
  test(`${theme} designer selects use one height without overriding runtime widget dimensions`, async ({
    page,
  }) => {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await consistentSelects(page);
    const designed = page.locator('[data-design-widget="runtime-select"]');
    expect((await designed.locator('select').boundingBox())!.height).toBeCloseTo(
      (await designed.boundingBox())!.height,
      2,
    );
    await page.getByRole('button', { name: '流程', exact: true }).click();
    await page
      .locator('.qg-flow-library-tabs')
      .getByRole('button', { name: '参数', exact: true })
      .click();
    await page
      .locator('.qg-parameter-library')
      .getByRole('button', { name: '编辑参数 Number', exact: true })
      .click();
    await consistentSelects(page);
    await page.getByRole('button', { name: '流程', exact: true }).click();
    await page
      .locator('.qg-flow-library-tabs')
      .getByRole('button', { name: '节点', exact: true })
      .click();
    await page.locator('.qg-flow-card').first().click();
    await consistentSelects(page);
    await page
      .locator('.qg-node-palette')
      .getByRole('button', { name: '设备请求', exact: true })
      .click();
    const connection = page.locator('.qg-flow-settings').getByRole('combobox', {
      name: '设备或服务连接',
      exact: true,
    });
    await expect(connection).toHaveValue('service');
    await connection.selectOption('service');
    await consistentSelects(page);
    await page.getByRole('button', { name: '界面', exact: true }).click();
    await page.getByRole('button', { name: '预览', exact: true }).click();
    const runtime = page.locator('.preview-modal [data-widget="runtime-select"] select');
    await expect(runtime).toBeVisible();
    expect((await runtime.boundingBox())!.height).toBe(58);
    expect(await runtime.locator('option').count()).toBeGreaterThan(0);
  });
}

test('project and export popups dismiss outside, preserve internal focus and remain mutually exclusive', async ({
  page,
}) => {
  const project = page.locator('.project-switch');
  const exported = page.locator('.export-menu-wrap > button');
  const projectMenu = page.locator('.project-dropdown');
  const exportMenu = page.locator('.export-dropdown');
  await project.click();
  await expect(project).toHaveAttribute('aria-expanded', 'true');
  await projectMenu.locator('button').first().focus();
  await expect(projectMenu).toBeVisible();
  await page.getByTitle('Theme', { exact: true }).focus();
  await expect(projectMenu).toHaveCount(0);
  await expect(page.getByTitle('Theme', { exact: true })).toBeFocused();
  await project.click();
  await exported.click();
  await expect(projectMenu).toHaveCount(0);
  await expect(exportMenu).toBeVisible();
  await project.click();
  await expect(exportMenu).toHaveCount(0);
  await expect(projectMenu).toBeVisible();
  await page.locator('.brand strong').click();
  await expect(projectMenu).toHaveCount(0);
  await exported.click();
  await exportMenu.locator('button').last().focus();
  await expect(exportMenu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(exportMenu).toHaveCount(0);
  await expect(exported).toHaveAttribute('aria-expanded', 'false');
});

test('menu Escape returns to its trigger, item actions still work and window blur dismisses', async ({
  page,
}) => {
  const project = page.locator('.project-switch');
  const exported = page.locator('.export-menu-wrap > button');
  const selection = page.locator('[data-design-widget="input"]');
  await project.click();
  await page.locator('.project-dropdown button').first().focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.project-dropdown')).toHaveCount(0);
  await expect(project).toBeFocused();
  await expect(selection).toHaveClass(/is-selected/);
  await project.click();
  await page
    .locator('.project-dropdown')
    .getByRole('button', { name: '重命名工程', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '重命名工程', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.project-dropdown')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await exported.click();
  await page.locator('.export-dropdown button').first().focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.export-dropdown')).toHaveCount(0);
  await expect(exported).toBeFocused();
  await exported.click();
  const download = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  await download;
  await expect(page.locator('.export-dropdown')).toHaveCount(0);
  await exported.click();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('.export-dropdown')).toHaveCount(0);
});

test('context menus close when focus leaves without stealing the new focus', async ({ page }) => {
  const viewport = page.locator('.qg-canvas-viewport');
  const menu = page.getByRole('menu', { name: 'Canvas actions', exact: true });
  const theme = page.getByTitle('Theme', { exact: true });
  await viewport.click({ button: 'right', position: { x: 10, y: 10 } });
  await expect(menu).toBeVisible();
  await theme.focus();
  await expect(menu).toHaveCount(0);
  await expect(theme).toBeFocused();
  await viewport.click({ button: 'right', position: { x: 10, y: 10 } });
  await expect(menu).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(menu).toHaveCount(0);
});
