import { Moon, Palette, Sun } from 'lucide-react';
import type { Project } from '../core/types';
import { applyProjectThemePreset } from '../core/themePresets';

export function AppearancePanel({
  project,
  onChange,
}: {
  project: Project;
  onChange: (change: (p: Project) => void) => void;
}) {
  const zh = project.locale === 'zh-CN';
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
          <div className="theme-token-list">
            {Object.entries(project.theme.tokens).map(([key, value]) => (
              <div className="theme-token-row" key={key}>
                <code>${key}</code>
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
                <input
                  aria-label={zh ? `令牌值：${key}` : `Token value: ${key}`}
                  value={value}
                  onChange={(e) =>
                    onChange((p) => {
                      p.theme.tokens[key] = e.target.value;
                    })
                  }
                />
              </div>
            ))}
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
