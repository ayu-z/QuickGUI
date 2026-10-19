import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyProject, createWidget } from '../../src/core/project';
import type { Project } from '../../src/core/types';

function fixture() {
  const project = createEmptyProject('多语言表格工程');
  project.window.width = 900;
  project.window.height = 500;
  project.translations = {
    'zh-CN': { greeting: '你好', 'action.start': '启动' },
    en: { greeting: 'Hello', 'action.start': 'Start', secondary: 'Only English' },
  };
  const greeting = createWidget('text', 32, 32);
  greeting.id = 'greeting';
  greeting.props.text = '@greeting';
  const selector = createWidget('select', 32, 100);
  selector.id = 'locale-selector';
  selector.props.options = [
    { id: 'zh', label: '中文', value: 'zh-CN' },
    { id: 'en', label: 'English', value: 'en' },
    { id: 'fr', label: 'Français', value: 'fr-FR' },
  ];
  selector.bindings['/value'] = { variable: 'locale', mode: 'twoWay' };
  project.widgets = [greeting, selector];
  project.variables = [{ id: 'locale', name: 'locale', type: 'string', initial: 'zh-CN' }];
  return project;
}

async function open(page: Page, project = fixture()) {
  await page.addInitScript(
    (recovery) => {
      if (!localStorage.getItem('quickgui.project.v1'))
        localStorage.setItem('quickgui.project.v1', recovery);
    },
    JSON.stringify({ project, drafts: {} }),
  );
  await page.goto('/');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '多语言', exact: true })
    .click();
  await expect(page.locator('.translations-panel')).toBeVisible();
}

const panel = (page: Page) => page.locator('.translations-panel');
const language = (page: Page, locale: string, expanded: boolean) =>
  panel(page).getByRole('button', {
    name: `${expanded ? '收起' : '展开'}语言 ${locale}`,
    exact: true,
  });
const index = (page: Page, key: string) =>
  panel(page).getByRole('textbox', { name: `索引 ${key}`, exact: true });
const text = (page: Page, locale: string, key: string) =>
  panel(page).getByRole('textbox', { name: `${locale} · ${key}`, exact: true });
const toggles = (page: Page) => panel(page).locator('thead button[aria-expanded]');
const languageInputs = (page: Page) => panel(page).locator('tbody td input');
async function addLanguage(page: Page, locale: string) {
  await panel(page).getByRole('textbox', { name: '语言标识', exact: true }).fill(locale);
  await panel(page).getByRole('button', { name: '添加语言', exact: true }).click();
}
async function addIndex(page: Page, key: string) {
  await panel(page).getByRole('textbox', { name: '新索引', exact: true }).fill(key);
  await panel(page).getByRole('button', { name: '添加索引', exact: true }).click();
}
async function exportProject(page: Page, info: TestInfo) {
  await page
    .locator('.export-menu-wrap')
    .getByRole('button', { name: '导出', exact: true })
    .click();
  const downloading = page.waitForEvent('download');
  await page.locator('.export-dropdown button').first().click();
  const filename = info.outputPath('translations.qgui');
  await (await downloading).saveAs(filename);
  const files = unzipSync(new Uint8Array(await readFile(filename)));
  return { filename, project: JSON.parse(strFromU8(files['quickgui.json'])) as Project };
}
async function undo(page: Page) {
  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
}
async function expectExpandedColumnsVisible(page: Page) {
  await expect
    .poll(() =>
      panel(page)
        .locator('thead th.expanded')
        .evaluateAll(
          (elements) =>
            elements.length > 0 &&
            elements.every((element) => {
              const column = element.getBoundingClientRect();
              const viewport = element
                .closest('.translations-table-scroll')!
                .getBoundingClientRect();
              const indexWidth =
                element.parentElement!.firstElementChild!.getBoundingClientRect().width;
              return (
                column.left >= viewport.left + indexWidth - 1 && column.right <= viewport.right + 1
              );
            }),
        ),
    )
    .toBe(true);
}
async function expectNoFallbackButtons(page: Page) {
  await expect(panel(page).getByRole('button', { name: /恢复回退|Use fallback/ })).toHaveCount(0);
}

test('separates appearance and translations and changes from two expanded languages to exclusive columns at three', async ({
  page,
}, info) => {
  await open(page);
  await expect(page.locator('.workspace-tabs nav > button')).toHaveText([
    '界面',
    '应用外观',
    '多语言',
    '流程',
    'C 脚本',
    '数据',
    '连接',
  ]);
  await expect(page.getByRole('button', { name: '应用外观与多语言', exact: true })).toHaveCount(0);
  const table = panel(page).getByRole('table', { name: '翻译资源', exact: true });
  await expect(table.locator('thead th').first()).toContainText('索引');
  await expect(table.locator('thead th')).toHaveCount(3);
  await expect(toggles(page)).toHaveCount(0);
  await expect(table.locator('thead th.expanded')).toHaveCount(2);
  await expect(index(page, 'secondary')).toBeVisible();
  await expect(text(page, 'zh-CN', 'greeting')).toHaveValue('你好');
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await expect(text(page, 'en', 'greeting')).toHaveJSProperty('tagName', 'INPUT');
  await expect(panel(page).locator('textarea')).toHaveCount(0);
  await expectNoFallbackButtons(page);

  await addLanguage(page, 'fr-FR');
  await expect(table.locator('thead th')).toHaveCount(4);
  await expect(toggles(page)).toHaveCount(3);
  await expect(language(page, 'fr-FR', true)).toHaveAttribute('aria-expanded', 'true');
  await expect(table.locator('thead button[aria-expanded="true"]')).toHaveCount(1);
  await expect(text(page, 'zh-CN', 'greeting')).toHaveCount(0);
  await expect(text(page, 'fr-FR', 'greeting')).toHaveValue('');
  await text(page, 'fr-FR', 'greeting').fill('Bonjour');
  await language(page, 'en', false).click();
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await expect(text(page, 'fr-FR', 'greeting')).toHaveCount(0);
  await language(page, 'en', true).click();
  await expect(languageInputs(page)).toHaveCount(0);
  await language(page, 'fr-FR', false).click();
  await expect(text(page, 'fr-FR', 'greeting')).toHaveValue('Bonjour');

  await panel(page).getByRole('button', { name: '删除语言 fr-FR', exact: true }).click();
  await expect(toggles(page)).toHaveCount(0);
  await expect(table.locator('thead th.expanded')).toHaveCount(2);
  await expect(text(page, 'zh-CN', 'greeting')).toHaveValue('你好');
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await undo(page);
  await expect(toggles(page)).toHaveCount(3);
  await expect(language(page, 'fr-FR', true)).toHaveAttribute('aria-expanded', 'true');
  await expect(text(page, 'fr-FR', 'greeting')).toHaveValue('Bonjour');
  await expect(table.locator('thead th.expanded')).toHaveCount(1);

  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '应用外观', exact: true })
    .click();
  await expect(page.locator('.appearance-panel')).toBeVisible();
  await expect(page.locator('.translations-panel')).toHaveCount(0);
  await expect(
    page.locator('.appearance-panel').getByRole('button', { name: '一键亮色', exact: true }),
  ).toBeVisible();
  const screenshot = info.outputPath('appearance-workspace.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('appearance workspace', { path: screenshot, contentType: 'image/png' });
});

test('rejects duplicates and keeps safe indexes, rename and delete undoable without overwriting translations', async ({
  page,
}, info) => {
  await open(page);
  await addLanguage(page, 'en');
  await expect(panel(page).getByRole('alert')).toBeVisible();
  await expect(panel(page).locator('thead th')).toHaveCount(3);
  await expect(text(page, 'zh-CN', 'greeting')).toHaveValue('你好');
  await addIndex(page, 'greeting');
  await expect(panel(page).getByRole('alert')).toBeVisible();
  await expect(index(page, 'greeting')).toHaveCount(1);
  await addIndex(page, '__proto__');
  await expect(panel(page).getByRole('alert')).toContainText('保留名称');
  await expect(index(page, '__proto__')).toHaveCount(0);
  await index(page, 'greeting').fill('__proto__');
  await index(page, 'greeting').press('Enter');
  await expect(panel(page).getByRole('alert')).toContainText('保留名称');
  await expect(index(page, 'greeting')).toBeVisible();
  await expect(text(page, 'zh-CN', 'greeting')).toHaveValue('你好');
  await index(page, 'greeting').fill('composing.index');
  await index(page, 'greeting').dispatchEvent('keydown', {
    key: 'Enter',
    isComposing: true,
    keyCode: 229,
  });
  await expect(index(page, 'greeting')).toBeFocused();
  await expect(index(page, 'greeting')).toHaveValue('composing.index');
  await index(page, 'greeting').press('Escape');
  await expect(index(page, 'greeting')).toHaveValue('greeting');
  await index(page, 'greeting').fill('action.start');
  await index(page, 'greeting').press('Enter');
  await expect(panel(page).getByRole('alert')).toBeVisible();
  await expect(index(page, 'greeting')).toBeVisible();
  await expect(text(page, 'zh-CN', 'greeting')).toHaveValue('你好');
  await index(page, 'greeting').fill('welcome');
  await index(page, 'greeting').press('Enter');
  await expect(index(page, 'welcome')).toBeVisible();
  await expect(text(page, 'zh-CN', 'welcome')).toHaveValue('你好');
  await expect(text(page, 'en', 'welcome')).toHaveValue('Hello');
  await undo(page);
  await expect(index(page, 'greeting')).toBeVisible();
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await panel(page).getByRole('button', { name: '删除索引 greeting', exact: true }).click();
  await expect(index(page, 'greeting')).toHaveCount(0);
  await undo(page);
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await addIndex(page, 'status.ready');
  await text(page, 'zh-CN', 'status.ready').fill('就绪');
  await text(page, 'en', 'status.ready').fill('Ready');
  await panel(page).getByRole('button', { name: '删除语言 en', exact: true }).click();
  await expect(panel(page).locator('thead th')).toHaveCount(2);
  await expect(toggles(page)).toHaveCount(0);
  await undo(page);
  await expect(text(page, 'en', 'status.ready')).toHaveValue('Ready');
  await expect(toggles(page)).toHaveCount(0);
  for (const key of ['constructor', 'toString']) {
    await addIndex(page, key);
    await text(page, 'zh-CN', key).fill(`安全 ${key}`);
    await text(page, 'en', key).fill(`Safe ${key}`);
  }
  const { project } = await exportProject(page, info);
  expect(project.translations?.['zh-CN']).toMatchObject({
    greeting: '你好',
    'action.start': '启动',
    'status.ready': '就绪',
  });
  expect(project.translations?.en).toMatchObject({
    greeting: 'Hello',
    'action.start': 'Start',
    secondary: 'Only English',
    'status.ready': 'Ready',
  });
  expect(Object.hasOwn(project.translations!['zh-CN'], '__proto__')).toBe(false);
  for (const key of ['constructor', 'toString']) {
    expect(Object.hasOwn(project.translations!['zh-CN'], key)).toBe(true);
    expect(project.translations!['zh-CN'][key]).toBe(`安全 ${key}`);
    expect(project.translations!.en[key]).toBe(`Safe ${key}`);
  }
});

test('persists added languages and explicit empty text and uses a runtime locale variable in preview', async ({
  page,
}, info) => {
  await open(page);
  await addLanguage(page, 'fr-FR');
  await expectNoFallbackButtons(page);
  await expect(text(page, 'fr-FR', 'greeting')).toHaveAttribute(
    'placeholder',
    '未设置，使用回退文本',
  );
  await text(page, 'fr-FR', 'greeting').fill('Bonjour');
  await text(page, 'fr-FR', 'greeting').fill('');
  await expect(text(page, 'fr-FR', 'greeting')).toHaveAttribute('placeholder', '空文本');
  expect((await exportProject(page, info)).project.translations?.['fr-FR']).toEqual({
    greeting: '',
  });
  await text(page, 'fr-FR', 'greeting').fill('Bonjour');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  const exported = await exportProject(page, info);
  expect(exported.project.translations?.['fr-FR']).toEqual({ greeting: 'Bonjour' });
  expect(exported.project.locale).toBe('zh-CN');
  await page.reload();
  await page
    .locator('.workspace-tabs nav')
    .getByRole('button', { name: '多语言', exact: true })
    .click();
  await language(page, 'fr-FR', false).click();
  await expect(text(page, 'fr-FR', 'greeting')).toHaveValue('Bonjour');
  await text(page, 'fr-FR', 'greeting').fill('Temporary');
  await page.locator('input[accept=".qgui,.json"]').setInputFiles(exported.filename);
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await expect(preview.locator('[data-widget="greeting"]')).toHaveText('你好');
  await preview
    .locator('[data-widget="locale-selector"] select')
    .selectOption({ label: 'Français' });
  await expect(preview.locator('[data-widget="greeting"]')).toHaveText('Bonjour');
  await preview
    .locator('[data-widget="locale-selector"] select')
    .selectOption({ label: 'English' });
  await expect(preview.locator('[data-widget="greeting"]')).toHaveText('Hello');
});

test('keeps long tables and expanded language columns visible in light and dark designer themes', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const project = fixture();
  for (const locale of ['fr-FR', 'de-DE', 'ja-JP', 'ko-KR', 'es-ES', 'it-IT', 'pt-BR', 'ar'])
    project.translations![locale] = { greeting: `${locale} greeting` };
  for (let row = 0; row < 45; row++) project.translations!['zh-CN'][`row.${row}`] = `第${row}行`;
  await open(page, project);
  const scroll = panel(page).locator('.translations-table-scroll');
  await expect
    .poll(() =>
      scroll.evaluate(
        (element) =>
          element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await language(page, 'ar', false).click();
  await expect(text(page, 'ar', 'greeting')).toBeVisible();
  await expectExpandedColumnsVisible(page);
  await text(page, 'ar', 'greeting').fill('مرحبا');
  await scroll.hover();
  await page.mouse.wheel(0, 10_000);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(index(page, 'row.44')).toBeInViewport();
  await expect(index(page, 'greeting')).not.toBeInViewport();
  await scroll.hover();
  await page.mouse.wheel(0, -10_000);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(index(page, 'greeting')).toBeInViewport();
  await scroll.hover();
  await page.mouse.wheel(-10_000, 0);
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(0);
  await index(page, 'greeting').focus();
  await expect(index(page, 'greeting')).toBeFocused();
  await text(page, 'ar', 'greeting').focus();
  await expect(text(page, 'ar', 'greeting')).toBeFocused();
  await expectExpandedColumnsVisible(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const darkScreenshot = info.outputPath('translations-compact-dark.png');
  await page.screenshot({ path: darkScreenshot, fullPage: true });
  await info.attach('compact translations in dark appearance', {
    path: darkScreenshot,
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(text(page, 'ar', 'greeting')).toHaveValue('مرحبا');
  await language(page, 'ar', true).click();
  await expect(languageInputs(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await expect(
    page.locator('.workspace-tabs nav').getByRole('button', { name: 'Languages', exact: true }),
  ).toBeVisible();
  await expect(panel(page).getByRole('table', { name: 'Translations', exact: true })).toBeVisible();
  await expectNoFallbackButtons(page);
  await panel(page).getByRole('button', { name: 'Expand language ar', exact: true }).click();
  await expect(text(page, 'ar', 'greeting')).toHaveValue('مرحبا');
  await expectExpandedColumnsVisible(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const lightScreenshot = info.outputPath('translations-compact-light.png');
  await page.screenshot({ path: lightScreenshot, fullPage: true });
  await info.attach('compact translations in light appearance', {
    path: lightScreenshot,
    contentType: 'image/png',
  });
});

test('fits two compact single-line language columns beside the index and preserves untouched multiline translations', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const project = fixture();
  const originalChinese = '第一行\n第二行\r\n第三行';
  const originalEnglish = 'First line\nSecond line';
  project.translations!['zh-CN'].multiline = originalChinese;
  project.translations!.en.multiline = originalEnglish;
  await open(page, project);
  await expect(toggles(page)).toHaveCount(0);
  await expect(panel(page).locator('textarea')).toHaveCount(0);
  await expectNoFallbackButtons(page);
  await expectExpandedColumnsVisible(page);
  const scroll = panel(page).locator('.translations-table-scroll');
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  for (const locale of ['zh-CN', 'en']) {
    await expect(text(page, locale, 'greeting')).toHaveJSProperty('tagName', 'INPUT');
    const bounds = await text(page, locale, 'greeting').boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(31);
    expect(bounds!.height).toBeLessThanOrEqual(33);
  }
  const rowHeight = await text(page, 'en', 'greeting').evaluate(
    (element) => element.closest('tr')!.getBoundingClientRect().height,
  );
  expect(rowHeight).toBeLessThanOrEqual(48);
  await expect(text(page, 'zh-CN', 'multiline')).toHaveValue('第一行第二行第三行');
  await expect(text(page, 'zh-CN', 'multiline')).toHaveAttribute('title', originalChinese);
  await text(page, 'zh-CN', 'multiline').focus();
  await text(page, 'zh-CN', 'multiline').press('Tab');
  await text(page, 'en', 'greeting').fill('Hello edited');
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectExpandedColumnsVisible(page);
  await expect(text(page, 'zh-CN', 'multiline')).toHaveValue('第一行第二行第三行');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  const exported = (await exportProject(page, info)).project;
  expect(exported.translations!['zh-CN'].multiline).toBe(originalChinese);
  expect(exported.translations!.en.multiline).toBe(originalEnglish);
  expect(exported.translations!.en.greeting).toBe('Hello edited');
  const screenshot = info.outputPath('translations-two-languages-compact.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('two compact expanded language columns', {
    path: screenshot,
    contentType: 'image/png',
  });
});

test('handles empty and single-language tables while keeping the remaining language expanded', async ({
  page,
}) => {
  const project = fixture();
  project.translations = {};
  await open(page, project);
  await expect(panel(page).locator('thead th')).toHaveCount(1);
  await expect(panel(page).getByRole('button', { name: '添加索引', exact: true })).toBeDisabled();
  await expect(toggles(page)).toHaveCount(0);
  await expectNoFallbackButtons(page);
  await addLanguage(page, 'en');
  await expect(panel(page).locator('thead th.expanded')).toHaveCount(1);
  await expect(toggles(page)).toHaveCount(0);
  await addIndex(page, 'only');
  await text(page, 'en', 'only').fill('Only language');
  await addLanguage(page, 'fr-FR');
  await expect(panel(page).locator('thead th.expanded')).toHaveCount(2);
  await expect(toggles(page)).toHaveCount(0);
  await expect(text(page, 'en', 'only')).toHaveValue('Only language');
  await expect(text(page, 'fr-FR', 'only')).toHaveValue('');
  await panel(page).getByRole('button', { name: '删除语言 en', exact: true }).click();
  await expect(index(page, 'only')).toHaveCount(0);
  await expect(panel(page).locator('thead th.expanded')).toHaveCount(1);
  await addIndex(page, 'unique');
  await text(page, 'fr-FR', 'unique').fill('Français');
  await panel(page).getByRole('button', { name: '删除语言 fr-FR', exact: true }).click();
  await expect(panel(page).locator('thead th')).toHaveCount(1);
  await expect(panel(page).getByRole('button', { name: '添加索引', exact: true })).toBeDisabled();
  await undo(page);
  await expect(text(page, 'fr-FR', 'unique')).toHaveValue('Français');
  await expect(toggles(page)).toHaveCount(0);
});
