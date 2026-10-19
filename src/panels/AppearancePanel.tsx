import { useState } from 'react';
import { Moon, Palette, Plus, Sun } from 'lucide-react';
import type { Project } from '../core/types';
import {
  addProjectThemeColor,
  applyProjectThemePreset,
  getProjectThemePalette,
  projectThemeKeys,
  setProjectThemeColor,
} from '../core/themePresets';
import './appearance.css';
import { ResourceHeading } from './ResourceHeading';

export function AppearancePanel({
  project,
  onChange,
}: {
  project: Project;
  onChange: (change: (p: Project) => void) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const keys = projectThemeKeys(project);
  const palettes = {
    light: getProjectThemePalette(project, 'light'),
    dark: getProjectThemePalette(project, 'dark'),
  };
  const [newKey, setNewKey] = useState('');
  const [newLight, setNewLight] = useState('#7c3aed');
  const [newDark, setNewDark] = useState('#8b5cf6');
  const [colorError, setColorError] = useState<'empty' | 'invalid' | 'duplicate' | 'value' | null>(
    null,
  );
  const errorMessage =
    colorError === 'empty'
      ? zh
        ? '请输入新颜色索引。'
        : 'Enter an index for the new color.'
      : colorError === 'invalid'
        ? zh
          ? '颜色索引须以字母或下划线开头，仅支持字母、数字、下划线、连字符和点分层。'
          : 'Use letters, numbers, underscores or hyphens, with optional dot-separated segments starting with a letter or underscore.'
        : colorError === 'duplicate'
          ? zh
            ? '该颜色索引已存在，请使用其他索引。现有颜色未被修改。'
            : 'This color index already exists. Choose another index; the existing color is unchanged.'
          : colorError === 'value'
            ? zh
              ? '请选择有效的亮色和暗色颜色值。'
              : 'Choose valid light and dark color values.'
            : '';
  const addColor = () => {
    const draft = newKey.trim().replace(/^\$/, '');
    if (!draft) {
      setColorError('empty');
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(draft)) {
      setColorError('invalid');
      return;
    }
    const key = draft.startsWith('color.') ? draft : `color.${draft}`;
    if (keys.includes(key)) {
      setColorError('duplicate');
      return;
    }
    if (![newLight, newDark].every((value) => /^#[0-9a-f]{6}$/i.test(value))) {
      setColorError('value');
      return;
    }
    onChange((p) => addProjectThemeColor(p, key, newLight, newDark));
    setNewKey('');
    setColorError(null);
  };
  return (
    <div className="appearance-panel project-settings-page">
      <ResourceHeading
        icon={<Palette size={16} aria-hidden="true" />}
        title={zh ? '应用外观' : 'Appearance'}
        summary={zh ? `${keys.length} 个颜色` : `${keys.length} colors`}
      >
        <div
          className="project-theme-presets appearance-theme-switch"
          role="group"
          aria-label={zh ? '工程界面主题' : 'Project UI theme'}
        >
          <div>
            <button
              type="button"
              aria-pressed={project.theme.mode === 'light'}
              onClick={() => onChange((p) => applyProjectThemePreset(p, 'light'))}
            >
              <Sun size={15} />
              {zh ? '亮色' : 'Light'}
            </button>
            <button
              type="button"
              aria-pressed={project.theme.mode === 'dark'}
              onClick={() => onChange((p) => applyProjectThemePreset(p, 'dark'))}
            >
              <Moon size={15} />
              {zh ? '暗色' : 'Dark'}
            </button>
          </div>
        </div>
      </ResourceHeading>
      <div className="appearance-toolbar">
        <form
          className="appearance-colors-form"
          onSubmit={(event) => {
            event.preventDefault();
            addColor();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          }}
        >
          <label className="appearance-new-index">
            {zh ? '新颜色索引' : 'New color index'}
            <input
              aria-label={zh ? '新颜色索引' : 'New color index'}
              aria-invalid={
                colorError === 'empty' || colorError === 'invalid' || colorError === 'duplicate'
              }
              aria-describedby={colorError ? 'appearance-color-error' : 'appearance-color-hint'}
              placeholder="brand / color.brand"
              value={newKey}
              onChange={(event) => {
                setNewKey(event.target.value);
                setColorError(null);
              }}
            />
          </label>
          <label>
            {zh ? '新亮色值' : 'New light color'}
            <input
              type="color"
              aria-label={zh ? '新亮色值' : 'New light color'}
              value={newLight}
              onChange={(event) => {
                setNewLight(event.target.value);
                setColorError(null);
              }}
            />
          </label>
          <label>
            {zh ? '新暗色值' : 'New dark color'}
            <input
              type="color"
              aria-label={zh ? '新暗色值' : 'New dark color'}
              value={newDark}
              onChange={(event) => {
                setNewDark(event.target.value);
                setColorError(null);
              }}
            />
          </label>
          <button type="submit" className="button">
            <Plus size={14} />
            {zh ? '添加颜色' : 'Add color'}
          </button>
        </form>
      </div>
      {errorMessage && (
        <p className="appearance-colors-error" id="appearance-color-error" role="alert">
          {errorMessage}
        </p>
      )}
      <div
        className="appearance-colors-scroll"
        tabIndex={0}
        aria-label={zh ? '主题颜色表格滚动区域' : 'Theme colors table scroll area'}
      >
        <table className="appearance-colors-table" aria-label={zh ? '主题颜色' : 'Theme colors'}>
          <colgroup>
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{zh ? '索引' : 'Index'}</th>
              <th scope="col">{zh ? '亮色' : 'Light'}</th>
              <th scope="col">{zh ? '暗色' : 'Dark'}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <th scope="row">
                  <code title={`$${key}`}>${key}</code>
                </th>
                {(['light', 'dark'] as const).map((mode) => {
                  const value = palettes[mode][key] ?? '';
                  const name = mode === 'light' ? (zh ? '亮色' : 'Light') : zh ? '暗色' : 'Dark';
                  return (
                    <td
                      key={mode}
                      className={
                        project.theme.mode === mode ||
                        (project.theme.mode === 'system' && mode === 'dark')
                          ? 'appearance-active-palette'
                          : undefined
                      }
                    >
                      <div className="appearance-color-editor">
                        <input
                          type="color"
                          aria-label={zh ? `${name}颜色：${key}` : `${name} color: ${key}`}
                          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
                          onChange={(event) =>
                            onChange((p) => setProjectThemeColor(p, mode, key, event.target.value))
                          }
                        />
                        <input
                          aria-label={zh ? `${name}值：${key}` : `${name} value: ${key}`}
                          value={value}
                          onChange={(event) =>
                            onChange((p) => setProjectThemeColor(p, mode, key, event.target.value))
                          }
                        />
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="appearance-help">
        <summary>{zh ? '使用说明' : 'Usage'}</summary>
        <div>
          <p>
            {zh
              ? '亮色与暗色方案分别保存。编辑当前方案会同步到画布和预览，编辑另一方案不会改变当前界面；亮色 / 暗色切换已保存方案，不会覆盖编辑值，设计器主题不受影响。'
              : 'Light and dark palettes are saved separately. Editing the active palette updates the canvas and preview; editing the other palette leaves the current UI unchanged. Light / Dark selects the saved palette and preserves edits. The designer theme is independent.'}
          </p>
          <p id="appearance-color-hint">
            {zh
              ? '输入 brand 或 color.brand 创建 $color.brand，并设置两套颜色。控件通过 $color.primary 等令牌引用配色；固定颜色、独立组件资源和自定义窗口背景会保留。'
              : 'Enter brand or color.brand to create $color.brand with both colors. Widgets reference tokens such as $color.primary. Fixed widget colors, isolated component resources and custom window backgrounds are preserved.'}
          </p>
        </div>
      </details>
    </div>
  );
}
