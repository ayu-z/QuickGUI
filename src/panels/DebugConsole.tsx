import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Check,
  Copy,
  Play,
  Search,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { Locale, Project, RuntimeLog } from '../core/types';
import type { RuntimeController } from '../runtime/engine';
import { manualFlowEntries } from '../core/flowBindings';
import './debugConsole.css';

export function DebugConsole({
  logs,
  title,
  locale,
  onClear,
  onClose,
  children,
}: {
  logs: RuntimeLog[];
  title: string;
  locale: Locale;
  onClear: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const zh = locale === 'zh-CN';
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('all');
  const [follow, setFollow] = useState(true);
  const [copyState, setCopyState] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const visible = logs.filter(
    (log) =>
      (level === 'all' || log.level === level) &&
      log.message.toLowerCase().includes(search.toLowerCase()),
  );
  useEffect(() => {
    if (follow && content.current) content.current.scrollTop = content.current.scrollHeight;
  }, [logs, follow, search, level]);
  return (
    <section className="console-panel debug-console" aria-label={title}>
      <header>
        <div className="debug-console-title">
          <Terminal size={14} />
          <strong>{title}</strong>
          <span className="count-pill">
            {visible.length}/{logs.length}
          </span>
        </div>
        <div>
          <button
            className="icon-button"
            aria-label={zh ? '关闭日志' : 'Close logs'}
            title={zh ? '关闭日志' : 'Close logs'}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </header>
      {children && <div className="debug-runtime-controls">{children}</div>}
      <div className="debug-console-tools">
        <label className="debug-log-search">
          <Search size={13} aria-hidden="true" />
          <input
            aria-label={zh ? '搜索日志' : 'Search logs'}
            placeholder={zh ? '搜索日志…' : 'Search logs…'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <select
          aria-label={zh ? '日志级别' : 'Log level'}
          value={level}
          onChange={(event) => setLevel(event.target.value)}
        >
          <option value="all">{zh ? '全部级别' : 'All levels'}</option>
          <option value="info">{zh ? '信息' : 'Info'}</option>
          <option value="warning">{zh ? '警告' : 'Warning'}</option>
          <option value="error">{zh ? '错误' : 'Error'}</option>
        </select>
        <button
          className={`icon-button ${follow ? 'selected' : ''}`}
          aria-label={zh ? '自动滚动' : 'Auto-scroll'}
          title={zh ? '自动滚动' : 'Auto-scroll'}
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
        >
          <ArrowDownToLine size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={zh ? '复制日志' : 'Copy logs'}
          title={copyState || (zh ? '复制日志' : 'Copy logs')}
          disabled={!visible.length}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                visible
                  .map((log) => `${new Date(log.time).toISOString()} [${log.level}] ${log.message}`)
                  .join('\n'),
              );
              setCopyState(zh ? '已复制' : 'Copied');
            } catch {
              setCopyState(zh ? '当前环境无法写入剪贴板' : 'Clipboard is unavailable');
            }
          }}
        >
          {copyState === (zh ? '已复制' : 'Copied') ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button className="icon-button" title={zh ? '清空' : 'Clear'} onClick={onClear}>
          <Trash2 size={13} />
        </button>
      </div>
      <div
        className="console-content"
        ref={content}
        tabIndex={0}
        aria-label={zh ? '日志内容' : 'Log content'}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          if (!atEnd && follow) setFollow(false);
        }}
      >
        {visible.length ? (
          visible.map((log) => (
            <div className={`log-row ${log.level}`} key={log.id}>
              <time>{new Date(log.time).toLocaleTimeString('en-GB', { hour12: false })}</time>
              <span className="log-level">{log.level}</span>
              <span>{log.message}</span>
            </div>
          ))
        ) : (
          <div className="console-empty">
            {logs.length
              ? zh
                ? '没有匹配的日志'
                : 'No matching logs'
              : zh
                ? '暂无日志'
                : 'No logs yet'}
          </div>
        )}
      </div>
    </section>
  );
}

export function PreviewDebugger({
  project,
  engine,
  onClose,
  canStart = true,
}: {
  project: Project;
  engine: RuntimeController;
  onClose: () => void;
  canStart?: boolean;
}) {
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [entryKey, setEntryKey] = useState('');
  const [simulate, setSimulate] = useState(false);
  const [runError, setRunError] = useState('');
  const zh = project.locale === 'zh-CN';
  const entries = project.flows
    .filter((flow) => flow.enabled)
    .flatMap((flow) =>
      manualFlowEntries(flow).map((node) => ({
        flow,
        node,
        key: JSON.stringify([flow.id, node.id]),
      })),
    );
  const entry = entries.find((item) => item.key === entryKey) ?? entries[0];
  const simulationVariables = project.variables.filter(
    (variable) =>
      ['temperature', 'pressure'].includes(variable.id) &&
      variable.type === 'number' &&
      !variable.readOnly,
  );
  useEffect(() => {
    if (!simulate || !simulationVariables.length) return;
    const start = Date.now();
    const timer = setInterval(() => {
      if (engine.getSnapshot().revision !== project.revision) return;
      const elapsed = (Date.now() - start) / 1000;
      for (const variable of simulationVariables) {
        const value =
          variable.id === 'temperature'
            ? Math.round((42.6 + Math.sin(elapsed / 3) * 8) * 10) / 10
            : Math.round((0.36 + Math.sin(elapsed / 5) * 0.04) * 100) / 100;
        try {
          engine.setVariable(variable.id, value);
        } catch (error) {
          engine.log(String(error), 'error');
        }
      }
    }, 500);
    return () => clearInterval(timer);
  }, [simulate, project.variables, project.revision, engine]);
  const updating = snapshot.revision !== project.revision;
  return (
    <DebugConsole
      logs={snapshot.logs}
      title={zh ? '预览调试' : 'Preview debug'}
      locale={project.locale}
      onClear={() => {
        engine.clearLogs();
        setRunError('');
      }}
      onClose={onClose}
    >
      {simulationVariables.length > 0 && (
        <label className="simulate-toggle">
          <input
            type="checkbox"
            checked={simulate}
            onChange={(event) => setSimulate(event.target.checked)}
          />
          {zh ? '模拟数据' : 'Simulator'} <span className="simulated-label">SIM</span>
        </label>
      )}
      {entries.length > 1 && (
        <select
          className="console-entry"
          aria-label={zh ? '运行入口' : 'Run entry'}
          value={entry?.key ?? ''}
          onChange={(event) => setEntryKey(event.target.value)}
        >
          {entries.map((item) => (
            <option key={item.key} value={item.key}>
              {item.flow.name} · {item.node.label}
            </option>
          ))}
        </select>
      )}
      <button
        className="button"
        title={zh ? '运行' : 'Run'}
        disabled={updating || (!canStart && !snapshot.running) || (!entry && snapshot.running)}
        aria-busy={updating || undefined}
        onClick={() => {
          if (engine.getSnapshot().revision !== project.revision) return;
          if (!canStart && !engine.getSnapshot().running) return;
          setRunError('');
          if (!snapshot.running) engine.start();
          if (entry)
            void engine
              .runFlow(entry.flow.id, null, entry.node.id)
              .catch((error) => setRunError(String(error)));
        }}
      >
        <Play size={13} />
        {zh ? '运行' : 'Run'}
      </button>
      <button
        className="button"
        title={zh ? '停止' : 'Stop'}
        disabled={snapshot.revision < 0}
        onClick={engine.stop}
      >
        <Square size={12} />
        {zh ? '停止' : 'Stop'}
      </button>
      {updating && (
        <span className="debug-updating">
          {zh ? '等待预览更新…' : 'Waiting for preview update…'}
        </span>
      )}
      {runError && (
        <span className="form-error" role="alert">
          {runError}
        </span>
      )}
      {!canStart && !snapshot.running && !updating && (
        <span className="debug-updating">
          {zh
            ? '共享会话已停止，请在主预览窗口中恢复运行。'
            : 'The shared session is stopped. Resume it in the main preview window.'}
        </span>
      )}
      {(project.windows?.length ?? 0) > 0 && (
        <span className="debug-updating">
          {zh
            ? '运行与停止作用于所有预览窗口的共享会话。'
            : 'Run and stop affect the session shared by all preview windows.'}
        </span>
      )}
    </DebugConsole>
  );
}
