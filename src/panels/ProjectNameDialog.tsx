import { useEffect, useRef, useState } from 'react';
import { FilePenLine, FilePlus2, X } from 'lucide-react';
import type { Locale } from '../core/types';

export function ProjectNameDialog({
  mode,
  initialName,
  locale,
  onConfirm,
  onCancel,
}: {
  mode: 'create' | 'rename';
  initialName: string;
  locale: Locale;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialName);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const zh = locale === 'zh-CN';
  const name = draft.trim();
  const title =
    mode === 'create' ? (zh ? '新建工程' : 'New project') : zh ? '重命名工程' : 'Rename project';
  const error = !name
    ? zh
      ? '请输入工程名称，不能只包含空格。'
      : 'Enter a project name; whitespace alone is not valid.'
    : name.length > 200
      ? zh
        ? '工程名称最多 200 个字符。'
        : 'Project names must be at most 200 characters.'
      : /[\u0000-\u001f\u007f]/.test(name)
        ? zh
          ? '工程名称不能包含控制字符。'
          : 'Project names cannot contain control characters.'
        : '';
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const Icon = mode === 'create' ? FilePlus2 : FilePenLine;
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
          } else if (event.key === 'Enter' && event.nativeEvent.isComposing) {
            event.preventDefault();
          } else if (event.key === 'Tab') {
            const focusable = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled])',
            );
            if (!focusable?.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <strong>
            <Icon size={16} />
            {title}
          </strong>
          <button
            className="icon-button"
            aria-label={zh ? '取消命名' : 'Cancel naming'}
            onClick={onCancel}
          >
            <X size={18} />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!error) onConfirm(name);
          }}
        >
          <label className="project-name-field" htmlFor="project-name-input">
            {zh ? '工程名称' : 'Project name'}
          </label>
          <input
            id="project-name-input"
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'project-name-error' : 'project-name-help'}
            placeholder={zh ? '例如：一号泵站控制系统' : 'For example: Pump station control'}
          />
          <div className="project-name-meta">
            <span id="project-name-help">
              {zh
                ? '工程名用于工作区和建议文件名；窗口标题、发布应用名分别设置。'
                : 'Used for the workspace and suggested filename. Window title and published app name have separate settings.'}
            </span>
            <span>{name.length}/200</span>
          </div>
          {error && (
            <p id="project-name-error" role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="settings-actions">
            <button type="button" className="button" onClick={onCancel}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button type="submit" className="button primary" disabled={Boolean(error)}>
              {mode === 'create'
                ? zh
                  ? '创建工程'
                  : 'Create project'
                : zh
                  ? '保存名称'
                  : 'Save name'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
