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
async function expectExpandedColumnVisible(page: Page) {
  await expect
    .poll(() =>
      panel(page)
        .locator('thead th.expanded')
        .evaluate((element) => {
          const column = element.getBoundingClientRect();
          const viewport = element.closest('.translations-table-scroll')!.getBoundingClientRect();
          const indexWidth =
            element.parentElement!.firstElementChild!.getBoundingClientRect().width;
          return (
            column.left >= viewport.left + indexWidth - 1 && column.right <= viewport.right + 1
          );
        }),
    )
    .toBe(true);
}

test('separates appearance and translations between design and flow with one expandable language column', async ({
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
  await expect(index(page, 'secondary')).toBeVisible();
  await expect(language(page, 'zh-CN', true)).toHaveAttribute('aria-expanded', 'true');
  await expect(text(page, 'zh-CN', 'greeting')).toHaveValue('你好');
  await expect(text(page, 'en', 'greeting')).toHaveCount(0);
  await language(page, 'en', false).click();
  await expect(language(page, 'zh-CN', false)).toHaveAttribute('aria-expanded', 'false');
  await expect(text(page, 'zh-CN', 'greeting')).toHaveCount(0);
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await language(page, 'en', true).click();
  await expect(table.locator('textarea')).toHaveCount(0);
  await addLanguage(page, 'fr-FR');
  await expect(table.locator('thead th')).toHaveCount(4);
  await expect(language(page, 'fr-FR', true)).toHaveAttribute('aria-expanded', 'true');
  await expect(table.locator('thead button[aria-expanded="true"]')).toHaveCount(1);
  await expect(text(page, 'fr-FR', 'greeting')).toHaveValue('');
  await text(page, 'fr-FR', 'greeting').fill('Bonjour');
  await language(page, 'en', false).click();
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await language(page, 'fr-FR', false).click();
  await expect(text(page, 'fr-FR', 'greeting')).toHaveValue('Bonjour');
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

test('rejects duplicate languages and indexes and keeps rename and delete undoable without overwriting text', async ({
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
  await language(page, 'en', false).click();
  await expect(text(page, 'en', 'welcome')).toHaveValue('Hello');
  await undo(page);
  await expect(index(page, 'greeting')).toBeVisible();
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await panel(page).getByRole('button', { name: '删除索引 greeting', exact: true }).click();
  await expect(index(page, 'greeting')).toHaveCount(0);
  await undo(page);
  await expect(text(page, 'en', 'greeting')).toHaveValue('Hello');
  await addIndex(page, 'status.ready');
  await text(page, 'en', 'status.ready').fill('Ready');
  await panel(page).getByRole('button', { name: '删除语言 en', exact: true }).click();
  await expect(panel(page).locator('thead th')).toHaveCount(2);
  await undo(page);
  await language(page, 'en', false).click();
  await expect(text(page, 'en', 'status.ready')).toHaveValue('Ready');
  const { project } = await exportProject(page, info);
  expect(project.translations).toEqual({
    'zh-CN': { greeting: '你好', 'action.start': '启动' },
    en: {
      greeting: 'Hello',
      'action.start': 'Start',
      secondary: 'Only English',
      'status.ready': 'Ready',
    },
  });
});

test('persists and exports added languages and uses a runtime locale variable in preview', async ({
  page,
}, info) => {
  await open(page);
  await addLanguage(page, 'fr-FR');
  const fallback = panel(page).getByRole('button', {
    name: '恢复回退 fr-FR · greeting',
    exact: true,
  });
  await expect(text(page, 'fr-FR', 'greeting')).toHaveAttribute(
    'placeholder',
    '未设置，使用回退文本',
  );
  await expect(fallback).toBeDisabled();
  await text(page, 'fr-FR', 'greeting').fill('Bonjour');
  await text(page, 'fr-FR', 'greeting').fill('');
  await expect(text(page, 'fr-FR', 'greeting')).toHaveAttribute('placeholder', '空文本');
  await expect(fallback).toBeEnabled();
  expect((await exportProject(page, info)).project.translations?.['fr-FR']).toEqual({
    greeting: '',
  });
  await fallback.click();
  await expect(fallback).toBeDisabled();
  await expect(text(page, 'fr-FR', 'greeting')).toHaveAttribute(
    'placeholder',
    '未设置，使用回退文本',
  );
  const withFallback = (await exportProject(page, info)).project.translations;
  expect(withFallback?.['fr-FR']).toEqual({});
  expect(withFallback?.['zh-CN']?.greeting).toBe('你好');
  expect(withFallback?.en?.greeting).toBe('Hello');
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

test('keeps wide language tables usable at a compact viewport in light and dark designer themes', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const project = fixture();
  for (const locale of ['fr-FR', 'de-DE', 'ja-JP', 'ko-KR', 'es-ES', 'it-IT', 'pt-BR', 'ar'])
    project.translations![locale] = { greeting: `${locale} greeting` };
  await open(page, project);
  const scroll = panel(page).locator('.translations-table-scroll');
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  await language(page, 'ar', false).click();
  await expect(text(page, 'ar', 'greeting')).toBeVisible();
  await expectExpandedColumnVisible(page);
  await text(page, 'ar', 'greeting').fill('مرحبا');
  await expect(scroll).toBeVisible();
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
  await expect(panel(page).locator('textarea')).toHaveCount(0);
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await expect(
    page.locator('.workspace-tabs nav').getByRole('button', { name: 'Languages', exact: true }),
  ).toBeVisible();
  await expect(panel(page).getByRole('table', { name: 'Translations', exact: true })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Expand language ar', exact: true }).click();
  await expect(text(page, 'ar', 'greeting')).toHaveValue('مرحبا');
  await expectExpandedColumnVisible(page);
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
