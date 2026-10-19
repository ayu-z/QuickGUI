import { useEffect, useState, useSyncExternalStore } from 'react';
import { Activity, Bell, Check, RefreshCw } from 'lucide-react';
import type { Project } from '../core/types';
import type { RuntimeController } from '../runtime/engine';
import * as native from '../native/bridge';

export function HistoryPanel({
  project,
  engine,
  onChange,
  variableId,
}: {
  project: Project;
  engine: RuntimeController;
  onChange: (change: (p: Project) => void) => void;
  variableId?: string;
}) {
  const [selection, setSelected] = useState(
    project.variables.find((v) => v.type === 'number')?.id ?? '',
  );
  const selected = variableId ?? selection;
  const variable = project.variables.find((v) => v.id === selected);
  const [samples, setSamples] = useState<native.HistorySample[]>([]),
    [alarms, setAlarms] = useState<native.AlarmRecord[]>([]);
  const [error, setError] = useState('');
  const zh = project.locale === 'zh-CN';
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const refresh = async () => {
    if (!native.isDesktop() || !selected) return;
    try {
      const [history, nextAlarms] = await Promise.all([
        native.queryHistory(selected, 120),
        native.queryAlarms(100),
      ]);
      setSamples(history);
      setAlarms(nextAlarms);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    let cancelled = false,
      busy = false;
    const load = async () => {
      if (busy || !native.isDesktop() || !selected) return;
      busy = true;
      try {
        const [history, nextAlarms] = await Promise.all([
          native.queryHistory(selected, 120),
          native.queryAlarms(100),
        ]);
        if (!cancelled) {
          setSamples(history);
          setAlarms(nextAlarms);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected, project.id]);
  const values = native.isDesktop() ? samples.map((s) => s.value) : engine.getHistory(selected);
  const low = values.length ? Math.min(...values) : 0,
    high = values.length ? Math.max(...values) : 1;
  const points = values
    .map(
      (value, i) =>
        `${(i / Math.max(1, values.length - 1)) * 800},${90 - ((value - low) / (high - low || 1)) * 80}`,
    )
    .join(' ');
  const configure = (key: 'min' | 'max', raw: string) =>
    onChange((p) => {
      const v = p.variables.find((v) => v.id === selected);
      if (!v) return;
      const alarm = { ...v.alarm };
      if (raw === '') delete alarm[key];
      else {
        const number = Number(raw);
        if (!Number.isFinite(number)) return;
        alarm[key] = number;
      }
      v.alarm = alarm;
    });
  return (
    <section className="history-panel">
      <header>
        <div>
          <Activity size={16} />
          <h3>{zh ? '趋势与报警' : 'History & alarms'}</h3>
          <span>{native.isDesktop() ? 'SQLite' : zh ? '会话内数据' : 'In-memory'}</span>
        </div>
        <button className="icon-button" title="Refresh history" onClick={() => void refresh()}>
          <RefreshCw size={14} />
        </button>
      </header>
      <div className="history-config">
        {variableId === undefined && (
          <label>
            {zh ? '变量' : 'Variable'}
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {project.variables
                .filter((v) => v.type === 'number')
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {variable && (
          <>
            {variableId === undefined && (
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(variable.persistent)}
                  onChange={(e) =>
                    onChange((p) => {
                      p.variables.find((v) => v.id === selected)!.persistent = e.target.checked;
                    })
                  }
                />
                {zh ? '恢复持久值' : 'Persist value'}
              </label>
            )}
            <label>
              {zh ? '下限' : 'Low'}
              <input
                type="number"
                value={variable.alarm?.min ?? ''}
                placeholder="—"
                onChange={(e) => configure('min', e.target.value)}
              />
            </label>
            <label>
              {zh ? '上限' : 'High'}
              <input
                type="number"
                value={variable.alarm?.max ?? ''}
                placeholder="—"
                onChange={(e) => configure('max', e.target.value)}
              />
            </label>
          </>
        )}
      </div>
      <div className="history-chart">
        <div>
          <span>{high.toFixed(2)}</span>
          <span>{low.toFixed(2)}</span>
        </div>
        <svg viewBox="0 0 800 100" preserveAspectRatio="none">
          <line x1="0" y1="10" x2="800" y2="10" stroke="var(--border)" strokeDasharray="3 5" />
          <line x1="0" y1="90" x2="800" y2="90" stroke="var(--border)" strokeDasharray="3 5" />
          <polyline
            points={points}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <small className="history-caption">
        {values.length} {zh ? '个采样' : 'samples'} · {zh ? '当前值' : 'Current'}{' '}
        {String(snapshot.values[selected]?.value ?? '—')} {variable?.unit}
      </small>
      {error && <p className="form-error">{error}</p>}
      <div className="alarm-heading">
        <Bell size={14} />
        <strong>{zh ? '报警记录' : 'Alarm records'}</strong>
        <span>
          {alarms.filter((a) => a.active).length} {zh ? '活动' : 'active'}
        </span>
      </div>
      {!native.isDesktop() && (
        <p className="panel-intro">
          {zh
            ? '桌面运行时提供持久化历史、报警生命周期和确认记录。浏览器阈值告警显示在运行日志中。'
            : 'The desktop runtime persists history, alarm lifecycles and acknowledgements. Browser alarms appear in runtime logs.'}
        </p>
      )}
      {native.isDesktop() && !alarms.length && (
        <p className="panel-intro">
          {zh
            ? '暂无报警。为数值变量设置阈值以监测越界。'
            : 'No alarms. Configure thresholds for numeric variables.'}
        </p>
      )}
      {alarms.map((alarm) => (
        <div className={`alarm-row ${alarm.active ? 'active' : ''}`} key={alarm.id}>
          <span className="alarm-dot" />
          <strong>{alarm.variableName}</strong>
          <span>
            {alarm.direction === 'high' ? '>' : '<'} {alarm.threshold} · {alarm.value}
          </span>
          <time>{new Date(alarm.startedAt).toLocaleString()}</time>
          <span>{alarm.active ? (zh ? '活动' : 'Active') : zh ? '已恢复' : 'Cleared'}</span>
          <button
            className="button"
            disabled={alarm.acknowledged}
            onClick={() => {
              void native
                .ackAlarm(alarm.id)
                .then(refresh)
                .catch((e) => setError(String(e)));
            }}
          >
            <Check size={12} />
            {alarm.acknowledged ? (zh ? '已确认' : 'Acknowledged') : zh ? '确认' : 'Acknowledge'}
          </button>
        </div>
      ))}
    </section>
  );
}
