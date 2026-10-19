import { useState } from 'react';
import { Moon, Palette, Plus, Sun } from 'lucide-react';
import type { Project } from '../core/types';
import { applyProjectThemePreset } from '../core/themePresets';
import './appearance.css';

export function AppearancePanel({
  project,
  onChange,
}: {
  project: Project;
  onChange: (change: (p: Project) => void) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const [newKey, setNewKey] = useState('');
  const [newColor, setNewColor] = useState('#8b5cf6');
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
              ? '请选择有效的颜色值。'
              : 'Choose a valid color value.'
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
    if (Object.hasOwn(project.theme.tokens, key)) {
      setColorError('duplicate');
      return;
    }
    if (!/^#[0-9a-f]{6}$/i.test(newColor)) {
      setColorError('value');
      return;
    }
    onChange((p) => {
      if (!Object.hasOwn(p.theme.tokens, key)) p.theme.tokens[key] = newColor;
    });
    setNewKey('');
    setColorError(null);
  };
  return (
    <div className="appearance-panel project-settings-page">
      <header className="project-settings-heading">
        <div>
          <h2>
            <Palette size={20} />
            {zh ? '应用外观' : 'Appearance'}
          </h2>
          <p>
            {zh
              ? '配置工程界面的主题与颜色，画布、预览和导出同步生效。'
              : 'Configure the project UI theme and colors for the canvas, preview and exports.'}
          </p>
        </div>
      </header>
      <div className="project-settings-content">
        <section className="appearance-section">
          <div
            className="project-theme-presets"
            aria-label={zh ? '工程界面主题' : 'Project UI theme'}
          >
            <strong>{zh ? '工程界面主题' : 'Project UI theme'}</strong>
            <div>
              <button
                type="button"
                aria-pressed={project.theme.mode === 'light'}
                onClick={() => onChange((p) => applyProjectThemePreset(p, 'light'))}
              >
                <span className="project-theme-swatch light" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <Sun size={16} />
                {zh ? '一键亮色' : 'Apply light theme'}
              </button>
              <button
                type="button"
                aria-pressed={project.theme.mode === 'dark'}
                onClick={() => onChange((p) => applyProjectThemePreset(p, 'dark'))}
              >
                <span className="project-theme-swatch dark" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <Moon size={16} />
                {zh ? '一键暗色' : 'Apply dark theme'}
              </button>
            </div>
          </div>
          <p>
            {zh
              ? '预设会覆盖内置颜色令牌，仅同步匹配原主题背景色的窗口背景，画布、预览与导出同步生效。保留自定义令牌、控件固定颜色、独立组件资源和自定义窗口背景；设计器主题不受影响。'
              : 'Presets replace built-in color tokens and window backgrounds matching the previous theme background, updating the canvas, preview and exports. Custom tokens, fixed widget colors, isolated component resources and custom window backgrounds are preserved. The designer theme is unchanged.'}
          </p>
        </section>
        <section className="appearance-section">
          <h3>{zh ? '主题令牌' : 'Theme tokens'}</h3>
          <p>
            {zh
              ? '组件通过 $color.primary 等令牌引用样式。修改会同步到画布和预览。'
              : 'Components reference tokens such as $color.primary. Changes update canvas and preview.'}
          </p>
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
            <label>
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
              {zh ? '新颜色值' : 'New color value'}
              <input
                type="color"
                aria-label={zh ? '新颜色值' : 'New color value'}
                value={newColor}
                onChange={(event) => {
                  setNewColor(event.target.value);
                  setColorError(null);
                }}
              />
            </label>
            <button type="submit" className="button">
              <Plus size={14} />
              {zh ? '添加颜色' : 'Add color'}
            </button>
          </form>
          <p className="appearance-colors-hint" id="appearance-color-hint">
            {zh
              ? '输入 brand 或 color.brand 创建 $color.brand。自定义颜色会在切换亮暗预设时保留。'
              : 'Enter brand or color.brand to create $color.brand. Custom colors are preserved when applying light or dark presets.'}
          </p>
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
            <table
              className="appearance-colors-table"
              aria-label={zh ? '主题颜色' : 'Theme colors'}
            >
              <colgroup>
                <col />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{zh ? '索引' : 'Index'}</th>
                  <th scope="col">{zh ? '颜色' : 'Color'}</th>
                  <th scope="col">{zh ? '颜色值' : 'Value'}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(project.theme.tokens).map(([key, value]) => (
                  <tr key={key}>
                    <th scope="row">
                      <code title={`$${key}`}>${key}</code>
                    </th>
                    <td>
                      <input
                        type="color"
                        aria-label={zh ? `颜色：${key}` : `Color: ${key}`}
                        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
                        onChange={(e) =>
                          onChange((p) => {
                            p.theme.tokens[key] = e.target.value;
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={zh ? `令牌值：${key}` : `Token value: ${key}`}
                        value={value}
                        onChange={(e) =>
                          onChange((p) => {
                            p.theme.tokens[key] = e.target.value;
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="appearance-section">
          <h3>{zh ? '主窗口' : 'Main window'}</h3>
          <label className="settings-field">
            {zh ? '内容背景' : 'Content background'}
            <input
              type="color"
              value={project.window.background}
              onChange={(e) =>
                onChange((p) => {
                  p.window.background = e.target.value;
                })
              }
            />
          </label>
        </section>
      </div>
    </div>
  );
}
