import { useEffect, useRef, useState } from 'react';
import { AppWindow, Monitor, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Locale, Project } from '../core/types';
import { listProjectWindows } from '../core/windows';

type WindowAction = { mode: 'create' } | { mode: 'rename' | 'delete'; id: string };

export function WindowManager({
  project,
  activeWindowId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onStartup,
  locale,
}: {
  project: Project;
  activeWindowId: string;
  locale: Locale;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onStartup: (id: string, open: boolean) => void;
}) {
  const [action, setAction] = useState<WindowAction | null>(null);
  const windows = listProjectWindows(project),
    zh = locale === 'zh-CN';
  const current = windows.find((window) => window.id === activeWindowId);
  const target =
    action && action.mode !== 'create'
      ? windows.find((window) => window.id === action.id)
      : undefined;
  useEffect(() => {
    if (action && action.mode !== 'create' && !windows.some((window) => window.id === action.id))
      setAction(null);
  }, [project, action]);
  return (
    <section className="window-manager" aria-label={zh ? '工程窗口' : 'Project windows'}>
      <header>
        <span>
          {zh ? '窗口' : 'WINDOWS'} <small>{windows.length}</small>
        </span>
        <button
          className="icon-button"
          aria-label={zh ? '新增窗口' : 'Add window'}
          title={zh ? '新增窗口' : 'Add window'}
          onClick={() => setAction({ mode: 'create' })}
        >
          <Plus size={14} />
        </button>
      </header>
      <div className="window-manager-list">
        {windows.map((window) => (
          <div
            key={window.id}
            data-window-id={window.id}
            className={`window-manager-row ${window.id === activeWindowId ? 'active' : ''}`}
          >
            <button
              className="window-select"
              aria-label={`${zh ? '切换窗口' : 'Select window'} ${window.name}`}
              aria-pressed={window.id === activeWindowId}
              onClick={() => onSelect(window.id)}
            >
              {window.id === 'main' ? <Monitor size={14} /> : <AppWindow size={14} />}
              <span title={window.name}>{window.name}</span>
              {window.id === 'main' ? (
                <small>{zh ? '主' : 'MAIN'}</small>
              ) : (
                window.openOnStart && (
                  <i
                    className="window-startup-dot"
                    title={zh ? '启动时打开' : 'Opens on startup'}
                  />
                )
              )}
            </button>
            {window.id !== 'main' && (
              <div className="window-row-actions">
                <button
                  className="icon-button"
                  aria-label={`${zh ? '重命名窗口' : 'Rename window'} ${window.name}`}
                  onClick={() => setAction({ mode: 'rename', id: window.id })}
                >
                  <Pencil size={11} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`${zh ? '删除窗口' : 'Delete window'} ${window.name}`}
                  onClick={() => setAction({ mode: 'delete', id: window.id })}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {current && current.id !== 'main' && (
        <label className="window-startup-toggle">
          <input
            type="checkbox"
            checked={current.openOnStart}
            onChange={(event) => onStartup(current.id, event.target.checked)}
          />
          <span>{zh ? '启动时打开此窗口' : 'Open this window on startup'}</span>
        </label>
      )}
      {action && (action.mode === 'create' || target) && (
        <WindowPrompt
          key={`${action.mode}:${target?.id ?? 'new'}`}
          mode={action.mode}
          initialName={target?.name ?? `${zh ? '新窗口' : 'New window'} ${windows.length}`}
          widgetCount={target?.widgets.length ?? 0}
          locale={locale}
          onCancel={() => setAction(null)}
          onConfirm={(name) => {
            if (action.mode === 'create') onCreate(name);
            else if (action.mode === 'rename') onRename(action.id, name);
            else onDelete(action.id);
            setAction(null);
          }}
        />
      )}
    </section>
  );
}

function WindowPrompt({
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
                    ? '窗口名称用于设计器列表；原生标题可在窗口属性中单独设置。'
                    : 'Used in the window list. Set the native title separately in window properties.'}
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
