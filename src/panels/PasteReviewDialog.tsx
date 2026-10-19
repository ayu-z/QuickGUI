import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, X } from 'lucide-react';
import type { Project } from '../core/types';
import { listProjectWindows } from '../core/windows';
import {
  preparePaste,
  type ClipboardBundle,
  type DependencyKind,
  type EditScope,
  type PasteMappings,
  type PastePlan,
  type Point,
} from '../core/clipboard';
import './pasteReview.css';

const dependencyNames: Record<string, string> = {
  variables: '变量',
  flows: '流程',
  scripts: '脚本',
  modules: '模块',
  assets: '资源',
  connections: '连接',
  windows: '窗口',
  resourceScopes: '外观与语言资源组',
};

function localizedPasteMessage(message: string, zh: boolean): string {
  if (!zh) return message;
  const fixed: Record<string, string> = {
    'Upgrade the target working copy to schema v3; existing widgets keep definition version 1.':
      '目标工作副本将升级为 v3，现有控件保留旧版行为。',
    'Imported C or React code is preserved verbatim; review and trust it before running.':
      '导入的 C 或 React 代码保持原样，请审阅并确认信任后运行。',
    'System clipboard unavailable; using this process clipboard only.':
      '系统剪贴板不可用，当前使用本次应用进程内的剪贴板。',
  };
  if (Object.hasOwn(fixed, message)) return fixed[message];
  const count = /^Paste (\d+) widgets \((\d+) roots\); (.+)$/.exec(message);
  if (count)
    return `粘贴 ${count[1]} 个控件（${count[2]} 个顶层控件）；新增${count[3]
      .split(', ')
      .map((entry) => {
        const [kind, amount] = entry.split('=');
        return `${dependencyNames[kind] ?? kind} ${amount}`;
      })
      .join('、')}。`;
  const reuse = /^Reuse (\w+): (.+)$/.exec(message);
  if (reuse) return `复用${dependencyNames[reuse[1]] ?? reuse[1]}：${reuse[2]}`;
  const flow = /^Flow (.*): source enabled=(true|false); pasted enabled=(true|false)$/.exec(
    message,
  );
  if (flow)
    return `流程「${flow[1]}」：源工程${flow[2] === 'true' ? '已启用' : '未启用'}，粘贴后${flow[3] === 'true' ? '启用' : '保持禁用'}。`;
  const window =
    /^Window (.*): source openOnStart=(true|false); pasted openOnStart=(true|false)$/.exec(message);
  if (window)
    return `窗口「${window[1]}」：源工程${window[2] === 'true' ? '启动时自动打开' : '启动时不打开'}，粘贴后${window[3] === 'true' ? '启动时自动打开' : '启动时不打开'}。`;
  const removed =
    /^(Removed credential field|Removed URL credentials|Removed URL credential parameter): (.+)$/.exec(
      message,
    );
  if (removed) {
    const labels: Record<string, string> = {
      'Removed credential field': '已移除凭据字段',
      'Removed URL credentials': '已移除 URL 中的凭据',
      'Removed URL credential parameter': '已移除 URL 中的凭据参数',
    };
    return `${labels[removed[1]]}：${removed[2]}`;
  }
  // Preserve unknown diagnostics so new validation messages remain actionable.
  return message;
}

export function PasteReviewDialog({
  project,
  bundle,
  scope,
  point,
  sessionKey,
  currentWindowId,
  onConfirm,
  onCancel,
}: {
  project: Project;
  bundle: ClipboardBundle;
  scope: EditScope;
  point?: Point;
  sessionKey: string;
  currentWindowId: string;
  onConfirm: (plan: PastePlan) => void;
  onCancel: () => void;
}) {
  const zh = project.locale === 'zh-CN';
  const [reuse, setReuse] = useState<Partial<Record<DependencyKind, Record<string, string>>>>({});
  const [useTargetTheme, setUseTargetTheme] = useState(false);
  const [trust, setTrust] = useState(false);
  const [enabledFlows, setEnabledFlows] = useState<string[]>([]);
  const [openWindows, setOpenWindows] = useState<string[]>([]);
  const [failure, setFailure] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const previous = useRef<PasteMappings | undefined>(undefined);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      if (focused?.isConnected) focused.focus();
    };
  }, []);
  const result = useMemo(() => {
    try {
      const plan = preparePaste(project, bundle, scope, point, {
        sameDocument: false,
        sessionKey,
        currentWindowId,
        useTargetTheme,
        reuse,
        enableFlows: enabledFlows,
        openWindows,
        previousMappings: previous.current,
      });
      previous.current = plan.mappings;
      return { plan, error: '' };
    } catch (error) {
      return { plan: undefined, error: String(error) };
    }
  }, [
    project,
    bundle,
    scope,
    point,
    sessionKey,
    currentWindowId,
    useTargetTheme,
    reuse,
    enabledFlows,
    openWindows,
  ]);
  const kinds: [DependencyKind, string][] = [
    ['variables', zh ? '变量' : 'Variables'],
    ['flows', zh ? '流程' : 'Flows'],
    ['scripts', zh ? '脚本' : 'Scripts'],
    ['modules', zh ? '模块' : 'Modules'],
    ['assets', zh ? '资源' : 'Assets'],
    ['connections', zh ? '连接' : 'Connections'],
    ['windows', zh ? '窗口' : 'Windows'],
  ];
  const code = bundle.scripts.length > 0 || bundle.modules.some((module) => module.implementation);
  return (
    <div className="modal-backdrop">
      <div
        ref={dialog}
        className="settings-modal paste-review-modal"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? '跨工程粘贴' : 'Paste across projects'}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Tab') {
            const buttons = event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled),select:not(:disabled),input:not(:disabled)',
            );
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <strong>
            <ClipboardPaste size={16} />
            {zh ? '跨工程粘贴' : 'Paste across projects'}
          </strong>
          <button
            className="icon-button"
            onClick={onCancel}
            aria-label={zh ? '取消粘贴' : 'Cancel paste'}
          >
            <X size={16} />
          </button>
        </header>
        <section>
          <p>
            {bundle.source.projectName} → {project.name} · {bundle.widgets.length}{' '}
            {zh ? '个控件' : 'widgets'}
          </p>
          <label className="paste-choice">
            <input
              type="checkbox"
              checked={useTargetTheme}
              onChange={(event) => setUseTargetTheme(event.target.checked)}
            />
            {zh
              ? '使用目标工程主题与语言（默认保留源外观）'
              : 'Use target theme and language (default: preserve source appearance)'}
          </label>
          <div className="paste-mappings">
            {kinds.map(([kind, label]) => {
              const sources = bundle[kind];
              const candidates =
                kind === 'windows' ? listProjectWindows(project) : (project[kind] ?? []);
              if (!sources.length) return null;
              return (
                <fieldset key={kind}>
                  <legend>
                    {label} · {sources.length}
                  </legend>
                  {sources.map((source) => {
                    const targets = candidates.filter(
                      (target) =>
                        kind !== 'variables' ||
                        ('type' in source && 'type' in target && source.type === target.type),
                    );
                    return (
                      <label className="paste-mapping-row" key={source.id}>
                        <span title={source.id}>{'name' in source ? source.name : source.id}</span>
                        <select
                          aria-label={`${label}: ${'name' in source ? source.name : source.id}`}
                          value={reuse[kind]?.[source.id] ?? ''}
                          onChange={(event) => {
                            const entries = { ...reuse[kind] };
                            if (event.target.value) entries[source.id] = event.target.value;
                            else delete entries[source.id];
                            setReuse({ ...reuse, [kind]: entries });
                            setFailure('');
                          }}
                        >
                          <option value="">
                            {zh ? '新建独立副本' : 'Create independent copy'}
                          </option>
                          {targets.map((target) => (
                            <option key={target.id} value={target.id}>
                              {zh ? '复用' : 'Reuse'}: {'name' in target ? target.name : target.id}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </fieldset>
              );
            })}
          </div>
          {bundle.flows
            .filter((flow) => flow.enabled)
            .map((flow) => (
              <label key={flow.id} className="paste-choice">
                <input
                  type="checkbox"
                  checked={enabledFlows.includes(flow.id)}
                  onChange={(event) =>
                    setEnabledFlows(
                      event.target.checked
                        ? [...enabledFlows, flow.id]
                        : enabledFlows.filter((id) => id !== flow.id),
                    )
                  }
                />
                {zh ? '明确启用导入流程' : 'Explicitly enable imported flow'}: {flow.name}
              </label>
            ))}
          {bundle.windows
            .filter((window) => window.openOnStart)
            .map((window) => (
              <label key={window.id} className="paste-choice">
                <input
                  type="checkbox"
                  checked={openWindows.includes(window.id)}
                  onChange={(event) =>
                    setOpenWindows(
                      event.target.checked
                        ? [...openWindows, window.id]
                        : openWindows.filter((id) => id !== window.id),
                    )
                  }
                />
                {zh ? '启动时打开导入窗口' : 'Open imported window on startup'}: {window.name}
              </label>
            ))}
          <div className="paste-summary">
            {result.plan?.summary.map((line, index) => (
              <div key={index}>{localizedPasteMessage(line, zh)}</div>
            ))}
          </div>
          {(result.plan?.warnings ?? bundle.warnings).map((line, index) => (
            <p className="paste-warning" key={index}>
              {localizedPasteMessage(line, zh)}
            </p>
          ))}
          {code && (
            <label className="paste-choice paste-trust">
              <input
                type="checkbox"
                checked={trust}
                onChange={(event) => setTrust(event.target.checked)}
              />
              {zh
                ? '我信任此次导入的 C / React 代码；导入可能包含自动流程和连接。'
                : 'I trust the imported C / React code. Imported logic may include automatic flows and connections.'}
            </label>
          )}
          {(result.error || failure) && (
            <p role="alert" className="form-error">
              {result.error || failure}
            </p>
          )}
          <div className="settings-actions">
            <button className="button" onClick={onCancel}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button
              className="button primary"
              disabled={!result.plan || (code && !trust)}
              onClick={() => {
                if (result.plan)
                  try {
                    onConfirm(result.plan);
                  } catch (error) {
                    setFailure(String(error));
                  }
              }}
            >
              {zh ? '确认粘贴' : 'Confirm paste'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
