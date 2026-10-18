import { useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderOpen, RotateCcw, X } from 'lucide-react';
import type { EditorState, EditorStore } from '../core/store';
import type { Project } from '../core/types';
import { createEmptyProject } from '../core/project';
import { projectExamples } from '../core/examples';
import { importProject } from '../core/archive';
import { errorText, validateProject } from '../core/validation';
import * as native from '../native/bridge';
import { ProjectNameDialog } from './ProjectNameDialog';

export function WelcomeScreen({ store, state }: { store: EditorStore; state: EditorState }) {
  const locale =
    state.closedRecovery?.project.locale ??
    (localStorage.getItem('quickgui.locale') === 'en' ? 'en' : 'zh-CN');
  const zh = locale === 'zh-CN';
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Project>();
  const [creating, setCreating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    document.documentElement.dataset.theme = localStorage.getItem('quickgui.theme') ?? 'dark';
    return () => {
      mounted.current = false;
    };
  }, []);
  const stage = (raw: Project) => {
    if (!mounted.current) return;
    const project = validateProject(raw);
    const executable =
      project.modules.some((module) => module.implementation) ||
      project.flows.some(
        (flow) =>
          flow.enabled &&
          flow.nodes.some(
            (node) =>
              node.kind === 'event' &&
              ['startup', 'interval', 'controlledInterval', 'serial'].includes(
                String(node.config.trigger),
              ),
          ),
      );
    if (executable) setPending(project);
    else store.replaceProject(project);
  };
  const open = async () => {
    if (!native.isDesktop()) {
      input.current?.click();
      return;
    }
    try {
      const project = await native.loadProject();
      if (project) stage(project);
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    }
  };
  return (
    <div className="app-shell" data-testid="no-project">
      <header className="topbar">
        <div className="brand">
          <img src="/quickgui.svg" alt="QuickGUI" />
          <strong>QuickGUI</strong>
          <span>DESIGNER</span>
        </div>
        <span className="no-project-label">{zh ? '未打开工程' : 'No project open'}</span>
      </header>
      <main className="welcome-screen">
        <div className="welcome-content">
          <img className="welcome-logo" src="/quickgui.svg" alt="" />
          <span className="eyebrow">QUICKGUI WORKSPACE</span>
          <h1>{zh ? '开始一个工程' : 'Start a project'}</h1>
          <p>
            {zh
              ? '工程已关闭。源文件和运行历史保留在原位置。'
              : 'The project is closed. Source files and runtime history remain in their original locations.'}
          </p>
          <div className="welcome-actions">
            <button className="button primary" onClick={() => setCreating(true)}>
              <FilePlus2 size={16} />
              {zh ? '新建工程' : 'New project'}
            </button>
            <button className="button" onClick={() => void open()}>
              <FolderOpen size={16} />
              {zh ? '打开工程' : 'Open project'}
            </button>
          </div>
          {state.closedRecovery && (
            <button className="recovery-card" onClick={() => store.restoreClosedProject()}>
              <RotateCcw size={20} />
              <span>
                <strong>{zh ? '恢复上次关闭的工程' : 'Restore last closed project'}</strong>
                <small>
                  {state.closedRecovery.project.name}
                  {Object.keys(state.closedRecovery.drafts).length
                    ? ` · ${Object.keys(state.closedRecovery.drafts).length} ${zh ? '个未应用草稿' : 'unapplied drafts'}`
                    : ''}
                </small>
              </span>
            </button>
          )}
          <div>
            {projectExamples.map((example) => (
              <button
                key={example.id}
                className="welcome-example"
                onClick={() => store.replaceProject(example.create(locale))}
              >
                {example.label[locale]}
              </button>
            ))}
          </div>
          {(error || state.recoveryError) && (
            <div role="alert" className="form-error welcome-error">
              {error || state.recoveryError}
            </div>
          )}
          {state.closeWarnings.map((warning, index) => (
            <p className="form-error" key={index}>
              {warning}
            </p>
          ))}
        </div>
      </main>
      <footer className="statusbar">
        <span>{zh ? '所有工程任务已停止' : 'Project tasks stopped'}</span>
      </footer>
      {creating && (
        <ProjectNameDialog
          mode="create"
          initialName={zh ? '未命名工程' : 'Untitled project'}
          locale={locale}
          onCancel={() => setCreating(false)}
          onConfirm={(name) => {
            const project = createEmptyProject(name);
            project.locale = locale;
            store.replaceProject(project);
          }}
        />
      )}
      <input
        hidden
        ref={input}
        type="file"
        accept=".qgui,.json"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            stage(importProject(new Uint8Array(await file.arrayBuffer())));
          } catch (e) {
            setError(errorText(e));
          }
          event.target.value = '';
        }}
      />
      {pending && (
        <div className="modal-backdrop">
          <div
            className="settings-modal"
            role="dialog"
            aria-label={zh ? '打开可执行工程' : 'Open executable project'}
          >
            <header>
              <strong>{pending.name}</strong>
              <button className="icon-button" onClick={() => setPending(undefined)}>
                <X size={18} />
              </button>
            </header>
            <section>
              <p>
                {zh
                  ? '工程含代码组件或自动触发流程，打开后可能执行代码并连接外部设备或服务。只打开你信任的工程。'
                  : 'This project can execute code or automatically connect to external services. Open only projects you trust.'}
              </p>
              <div className="settings-actions">
                <button className="button" onClick={() => setPending(undefined)}>
                  {zh ? '取消' : 'Cancel'}
                </button>
                <button className="button primary" onClick={() => store.replaceProject(pending)}>
                  {zh ? '信任并打开' : 'Trust and open'}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
