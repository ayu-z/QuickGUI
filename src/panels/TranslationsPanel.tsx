import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Languages, Plus, Trash2 } from 'lucide-react';
import type { Project } from '../core/types';
import './translations.css';

const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function TranslationsPanel({
  project,
  onChange,
}: {
  project: Project;
  onChange: (mutator: (p: Project) => void) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const dictionaries = project.translations ?? {};
  const locales = Object.keys(dictionaries);
  const keys = [
    ...new Set(Object.values(dictionaries).flatMap((dictionary) => Object.keys(dictionary))),
  ];
  const [expanded, setExpanded] = useState<string | null>(() =>
    owns(dictionaries, project.locale) ? project.locale : (locales[0] ?? null),
  );
  const allExpanded = locales.length <= 2;
  const expandedLocale = expanded !== null && owns(dictionaries, expanded) ? expanded : null;
  const [localeDraft, setLocaleDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [keyEdits, setKeyEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [invalidKey, setInvalidKey] = useState<string | null>(null);
  const expandedHeader = useRef<HTMLTableCellElement>(null);
  const tableScroll = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (allExpanded && tableScroll.current) tableScroll.current.scrollLeft = 0;
    else if (expandedLocale)
      expandedHeader.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [allExpanded, expandedLocale]);

  const addLocale = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const locale = localeDraft.trim();
    if (!locale) {
      setError(zh ? '语言标识不能为空。' : 'Enter a language identifier.');
      return;
    }
    if (locales.some((existing) => existing.toLowerCase() === locale.toLowerCase())) {
      setError(zh ? `语言 ${locale} 已存在。` : `Language ${locale} already exists.`);
      return;
    }
    if (!/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i.test(locale)) {
      setError(
        zh
          ? '请使用有效的语言标识，例如 en、fr 或 ja-JP。'
          : 'Use a language identifier such as en, fr, or ja-JP.',
      );
      return;
    }
    onChange((p) => {
      p.translations = { ...p.translations, [locale]: {} };
    });
    setExpanded(locale);
    setLocaleDraft('');
    setError('');
  };

  const addKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = keyDraft.trim();
    if (!key) {
      setError(zh ? '索引不能为空。' : 'Enter an index.');
      return;
    }
    if (key === '__proto__') {
      setError(
        zh
          ? '索引 __proto__ 为保留名称，请使用其他索引。'
          : 'Index __proto__ is reserved. Choose another index.',
      );
      return;
    }
    if (keys.includes(key)) {
      setError(zh ? `索引 ${key} 已存在。` : `Index ${key} already exists.`);
      return;
    }
    const locale = expandedLocale ?? locales[0];
    if (!locale) {
      setError(zh ? '请先添加一种语言。' : 'Add a language first.');
      return;
    }
    onChange((p) => {
      const translations = p.translations ?? {};
      p.translations = {
        ...translations,
        [locale]: { ...(owns(translations, locale) ? translations[locale] : {}), [key]: '' },
      };
    });
    setExpanded(locale);
    setKeyDraft('');
    setError('');
  };

  const renameKey = (key: string, value: string) => {
    const next = value.trim();
    if (next === '__proto__' && next !== key) {
      setInvalidKey(key);
      setError(
        zh
          ? '索引 __proto__ 为保留名称，请使用其他索引。'
          : 'Index __proto__ is reserved. Choose another index.',
      );
      return;
    }
    if (!next || (next !== key && keys.includes(next))) {
      setInvalidKey(key);
      setError(
        !next
          ? zh
            ? '索引不能为空，原索引已保留。'
            : 'An index cannot be empty. The original index is unchanged.'
          : zh
            ? `索引 ${next} 已存在，原翻译已保留。`
            : `Index ${next} already exists. Existing translations are unchanged.`,
      );
      return;
    }
    if (next !== key) {
      onChange((p) => {
        p.translations = Object.fromEntries(
          Object.entries(p.translations ?? {}).map(([locale, dictionary]) => [
            locale,
            Object.fromEntries(
              Object.entries(dictionary).map(([existing, text]) => [
                existing === key ? next : existing,
                text,
              ]),
            ),
          ]),
        );
      });
    }
    setKeyEdits((edits) =>
      Object.fromEntries(Object.entries(edits).filter(([name]) => name !== key)),
    );
    setInvalidKey(null);
    setError('');
  };

  const deleteKey = (key: string) => {
    onChange((p) => {
      p.translations = Object.fromEntries(
        Object.entries(p.translations ?? {}).map(([locale, dictionary]) => [
          locale,
          Object.fromEntries(Object.entries(dictionary).filter(([existing]) => existing !== key)),
        ]),
      );
    });
    setKeyEdits((edits) =>
      Object.fromEntries(Object.entries(edits).filter(([name]) => name !== key)),
    );
    setInvalidKey(null);
    setError('');
  };

  const deleteLocale = (locale: string) => {
    onChange((p) => {
      p.translations = Object.fromEntries(
        Object.entries(p.translations ?? {}).filter(([existing]) => existing !== locale),
      );
    });
    setError('');
  };

  return (
    <section className="translations-panel project-settings-page">
      <header className="translations-heading">
        <div>
          <h2>
            <Languages size={20} aria-hidden="true" />
            {zh ? '多语言' : 'Languages'}
          </h2>
          <p>
            {zh
              ? '两种及以内语言并排显示；三种及以上同一时刻展开一列，也可全部收起。'
              : 'Up to two languages appear side by side. With three or more, expand one language at a time or collapse all columns.'}
          </p>
        </div>
        <span className="translations-count">
          {zh
            ? `${keys.length} 个索引 · ${locales.length} 种语言`
            : `${keys.length} indices · ${locales.length} languages`}
        </span>
      </header>

      <div className="translations-toolbar">
        <form onSubmit={addKey}>
          <label htmlFor="translation-new-key">{zh ? '新索引' : 'New index'}</label>
          <div>
            <input
              id="translation-new-key"
              value={keyDraft}
              placeholder="pump.title"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
            <button type="submit" className="translations-action" disabled={!locales.length}>
              <Plus size={15} aria-hidden="true" />
              {zh ? '添加索引' : 'Add index'}
            </button>
          </div>
        </form>
        <form onSubmit={addLocale}>
          <label htmlFor="translation-new-locale">{zh ? '语言标识' : 'Language identifier'}</label>
          <div>
            <input
              id="translation-new-locale"
              value={localeDraft}
              placeholder="fr / ja-JP"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setLocaleDraft(event.target.value)}
            />
            <button type="submit" className="translations-action">
              <Plus size={15} aria-hidden="true" />
              {zh ? '添加语言' : 'Add language'}
            </button>
          </div>
        </form>
      </div>

      <p className="translations-help">
        {zh ? (
          <>
            控件文本使用 <code>@key</code> 引用索引，例如 <code>@pump.title</code>。运行时可用名为{' '}
            <code>locale</code>{' '}
            的字符串变量切换语言。重命名索引后需同步修改控件引用；删除可通过撤销恢复。
          </>
        ) : (
          <>
            Reference an index in widget text with <code>@key</code>, e.g. <code>@pump.title</code>.
            Switch runtime languages with a string variable named <code>locale</code>. Update widget
            references after renaming an index. Use Undo to restore deleted resources.
          </>
        )}
      </p>
      {error && (
        <p className="translations-error" role="alert">
          {error}
        </p>
      )}

      <div
        className="translations-table-scroll"
        ref={tableScroll}
        tabIndex={0}
        aria-label={zh ? '翻译表格滚动区域' : 'Translation table scroll area'}
      >
        <table
          aria-label={zh ? '翻译资源' : 'Translations'}
          className={`translations-table${allExpanded ? ' all-expanded' : ''}`}
        >
          <colgroup>
            <col className="translations-index-column" />
            {locales.map((locale) => (
              <col
                key={locale}
                className={
                  allExpanded || locale === expandedLocale
                    ? 'translations-language-column expanded'
                    : 'translations-language-column collapsed'
                }
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="translations-index-cell">
                {zh ? '索引' : 'Index'}
                <code>@key</code>
              </th>
              {locales.map((locale) => {
                const open = allExpanded || locale === expandedLocale;
                return (
                  <th
                    scope="col"
                    key={locale}
                    className={open ? 'expanded' : 'collapsed'}
                    ref={!allExpanded && open ? expandedHeader : undefined}
                  >
                    <div className="translations-language-heading">
                      {allExpanded ? (
                        <span className="translations-language-title" title={locale}>
                          {locale}
                        </span>
                      ) : (
                        <button
                          className="translations-column-toggle"
                          aria-label={
                            zh
                              ? `${open ? '收起' : '展开'}语言 ${locale}`
                              : `${open ? 'Collapse' : 'Expand'} language ${locale}`
                          }
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : locale)}
                        >
                          {open ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
                          <span title={locale}>{locale}</span>
                        </button>
                      )}
                      <button
                        className="translations-delete"
                        aria-label={zh ? `删除语言 ${locale}` : `Delete language ${locale}`}
                        title={zh ? `删除语言 ${locale}` : `Delete language ${locale}`}
                        onClick={() => deleteLocale(locale)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <th scope="row" className="translations-index-cell">
                  <div className="translations-key-editor">
                    <input
                      aria-label={zh ? `索引 ${key}` : `Index ${key}`}
                      aria-invalid={invalidKey === key || undefined}
                      value={owns(keyEdits, key) ? keyEdits[key] : key}
                      spellCheck={false}
                      onChange={(event) =>
                        setKeyEdits((edits) => ({ ...edits, [key]: event.target.value }))
                      }
                      onBlur={(event) => renameKey(key, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                          return;
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === 'Escape') {
                          event.currentTarget.value = key;
                          event.currentTarget.blur();
                        }
                      }}
                    />
                    <button
                      className="translations-delete"
                      aria-label={zh ? `删除索引 ${key}` : `Delete index ${key}`}
                      title={zh ? `删除索引 ${key}` : `Delete index ${key}`}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => deleteKey(key)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </th>
                {locales.map((locale) => {
                  const dictionary = dictionaries[locale];
                  const present = owns(dictionary, key);
                  const text = present ? dictionary[key] : '';
                  const displayedText = text.replace(/[\r\n]/g, '');
                  const open = allExpanded || locale === expandedLocale;
                  return (
                    <td key={locale} className={open ? 'expanded' : 'collapsed'}>
                      {open ? (
                        <input
                          type="text"
                          className="translations-text-input"
                          aria-label={`${locale} · ${key}`}
                          value={displayedText}
                          title={text}
                          onFocus={() => {
                            if (!allExpanded)
                              expandedHeader.current?.scrollIntoView({
                                block: 'nearest',
                                inline: 'nearest',
                              });
                          }}
                          placeholder={
                            present
                              ? zh
                                ? '空文本'
                                : 'Empty text'
                              : zh
                                ? '未设置，使用回退文本'
                                : 'Not set; use fallback text'
                          }
                          onChange={(event) => {
                            const value = event.target.value;
                            // A single-line input strips CR/LF for display. Preserve the original
                            // imported text unless the user actually changes the displayed value.
                            if (value === displayedText) return;
                            onChange((p) => {
                              const translations = p.translations ?? {};
                              p.translations = {
                                ...translations,
                                [locale]: {
                                  ...(owns(translations, locale) ? translations[locale] : {}),
                                  [key]: value,
                                },
                              };
                            });
                          }}
                        />
                      ) : (
                        <span
                          className={`translations-collapsed-text${present ? '' : ' missing'}`}
                          title={
                            present
                              ? text
                              : zh
                                ? '未设置，使用回退文本'
                                : 'Not set; use fallback text'
                          }
                        >
                          {present ? text || (zh ? '空文本' : 'Empty text') : '—'}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!keys.length && (
              <tr>
                <td className="translations-empty" colSpan={Math.max(locales.length + 1, 1)}>
                  {locales.length
                    ? zh
                      ? '添加一个索引，开始编辑翻译文本。'
                      : 'Add an index to start editing translations.'
                    : zh
                      ? '先添加语言，再添加需要翻译的索引。'
                      : 'Add a language, then add indices for your translated text.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="translations-footnote">
        {zh
          ? '翻译文本即时保存；索引在回车或失焦时保存，Esc 取消。未设置的翻译保持缺省，不会被批量填为空文本。'
          : 'Translation text saves immediately. Indices save on Enter or blur; press Esc to cancel. Missing translations stay unset rather than being filled with empty text.'}
      </p>
    </section>
  );
}
