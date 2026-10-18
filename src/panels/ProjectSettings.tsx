import { useState } from 'react';
import { Palette, Languages, X } from 'lucide-react';
import type { Project } from '../core/types';
import { CodeEditor } from '../designer/CodeEditor';

export function ProjectSettings({
  project,
  onChange,
  onClose,
}: {
  project: Project;
  onChange: (change: (p: Project) => void) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'theme' | 'languages'>('theme');
  const [draft, setDraft] = useState(
    JSON.stringify(project.translations ?? { 'zh-CN': {}, en: {} }, null, 2),
  );
  const [error, setError] = useState('');
  const zh = project.locale === 'zh-CN';
  const apply = () => {
    try {
      const value = JSON.parse(draft) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected a locale → translations object');
      for (const [locale, dictionary] of Object.entries(value)) {
        if (
          !locale ||
          !dictionary ||
          typeof dictionary !== 'object' ||
          Array.isArray(dictionary) ||
          Object.values(dictionary).some((v) => typeof v !== 'string')
        )
          throw new Error(`Invalid string dictionary for ${locale}`);
      }
      onChange((p) => {
        p.translations = value as Project['translations'];
      });
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="modal-backdrop">
      <div className="settings-modal">
        <header>
          <strong>{zh ? '应用外观与多语言' : 'Application appearance & languages'}</strong>
          <button className="icon-button" aria-label="Close settings" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <nav>
          <button className={tab === 'theme' ? 'active' : ''} onClick={() => setTab('theme')}>
            <Palette size={14} />
            {zh ? '主题令牌' : 'Theme tokens'}
          </button>
          <button
            className={tab === 'languages' ? 'active' : ''}
            onClick={() => setTab('languages')}
          >
            <Languages size={14} />
            {zh ? '翻译资源' : 'Translations'}
          </button>
        </nav>
        <section>
          {tab === 'theme' ? (
            <>
              <p>
                {zh
                  ? '组件通过 $color.primary 等令牌引用样式。修改会同步到画布和预览。'
                  : 'Components reference tokens such as $color.primary. Changes update canvas and preview.'}
              </p>
              <div className="theme-token-list">
                {Object.entries(project.theme.tokens).map(([key, value]) => (
                  <label key={key}>
                    <code>${key}</code>
                    <input
                      type="color"
                      value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
                      onChange={(e) =>
                        onChange((p) => {
                          p.theme.tokens[key] = e.target.value;
                        })
                      }
                    />
                    <input
                      value={value}
                      onChange={(e) =>
                        onChange((p) => {
                          p.theme.tokens[key] = e.target.value;
                        })
                      }
                    />
                  </label>
                ))}
              </div>
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
            </>
          ) : (
            <>
              <p>
                {zh
                  ? '文本属性以 @key 引用翻译，例如 @pump.title。可创建名为 locale 的字符串变量，在运行时切换语言。'
                  : 'Reference a translation with @key, e.g. @pump.title. A string variable named locale can switch languages at runtime.'}
              </p>
              <CodeEditor value={draft} onChange={setDraft} height={330} />
              <div className="settings-actions">
                {error && <span className="form-error">{error}</span>}
                <button className="button primary" onClick={apply}>
                  {zh ? '应用翻译' : 'Apply translations'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
