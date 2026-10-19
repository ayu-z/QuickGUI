import { useEffect, useRef, useState } from 'react';
import { AppWindow, X } from 'lucide-react';
import type { Locale } from '../core/types';

export function WindowPrompt({
  mode,
  initialName,
  widgetCount,
  locale,
  onConfirm,
  onCancel,
}: {
  mode: 'create' | 'rename' | 'delete';
  initialName: string;
  widgetCount: number;
  locale: Locale;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialName),
    [failure, setFailure] = useState('');
  const dialog = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const zh = locale === 'zh-CN',
    name = draft.trim();
  const title =
    mode === 'create'
      ? zh
        ? '新增窗口'
        : 'Add window'
      : mode === 'rename'
        ? zh
          ? '重命名窗口'
          : 'Rename window'
        : zh
          ? '删除窗口'
          : 'Delete window';
  const invalid =
    mode !== 'delete' && (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name));
  useEffect(() => {
    if (input.current) {
      input.current.focus();
      input.current.select();
    } else dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={dialog}
        className="settings-modal project-name-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          if (event.key === 'Tab') {
            const items = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]),input:not([disabled])',
            );
            if (!items?.length) return;
            const first = items[0],
              last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <strong>
            <AppWindow size={16} />
            {title}
          </strong>
          <button
            className="icon-button"
            aria-label={zh ? '取消窗口操作' : 'Cancel window action'}
            onClick={onCancel}
          >
            <X size={18} />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid) return;
            try {
              onConfirm(name);
            } catch (error) {
              setFailure(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          {mode === 'delete' ? (
            <p className="window-delete-message">
              {zh
                ? `删除“${initialName}”及其中的 ${widgetCount} 个控件？此操作可撤销。共享变量、流程和模块会保留。`
                : `Delete “${initialName}” and its ${widgetCount} widgets? You can undo this action. Shared variables, flows and modules are retained.`}
            </p>
          ) : (
            <>
              <label className="project-name-field" htmlFor="window-name-input">
                {zh ? '窗口名称' : 'Window name'}
              </label>
              <input
                ref={input}
                id="window-name-input"
                value={draft}
                autoComplete="off"
                aria-invalid={invalid}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setFailure('');
                }}
              />
              <div className="project-name-meta">
                <span>
                  {zh
                    ? '窗口名称用于设计器下拉框；原生标题可在窗口属性中单独设置。'
                    : 'Used in the window selector. Set the native title separately in window properties.'}
                </span>
                <span>{name.length}/200</span>
              </div>
            </>
          )}
          {invalid && (
            <p className="form-error" role="alert">
              {zh
                ? '请输入 1–200 个字符，不允许空白名称或控制字符。'
                : 'Enter 1–200 characters. Blank names and control characters are not allowed.'}
            </p>
          )}
          {failure && (
            <p className="form-error" role="alert">
              {failure}
            </p>
          )}
          <div className="settings-actions">
            <button type="button" className="button" onClick={onCancel}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              className={`button ${mode === 'delete' ? 'window-delete-confirm' : 'primary'}`}
              disabled={invalid}
            >
              {mode === 'create'
                ? zh
                  ? '创建窗口'
                  : 'Create window'
                : mode === 'rename'
                  ? zh
                    ? '保存名称'
                    : 'Save name'
                  : zh
                    ? '删除窗口'
                    : 'Delete window'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
