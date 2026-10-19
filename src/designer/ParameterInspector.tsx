import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Braces, Trash2 } from 'lucide-react';
import type { Json, Project, Variable } from '../core/types';
import { variableReferences } from '../core/references';
import { deleteParameterDefinition, updateParameterDefinition } from '../core/parameters';
import type { RuntimeController } from '../runtime/engine';
import { HistoryPanel } from '../panels/HistoryPanel';
import { JsonValueField } from '../panels/JsonValueField';
import './parameters.css';

function CommitInput({
  value,
  label,
  type = 'text',
  disabled = false,
  onCommit,
}: {
  value: string;
  label: string;
  type?: 'text' | 'number';
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const initial = useRef(value);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  return (
    <div className="qg-parameter-input">
      <input
        aria-label={label}
        type={type}
        step={type === 'number' ? 'any' : undefined}
        disabled={disabled}
        value={draft}
        aria-invalid={Boolean(error)}
        onFocus={() => {
          initial.current = value;
          setEditing(true);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setError('');
        }}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            return;
          }
          if (draft === initial.current) {
            setEditing(false);
            return;
          }
          try {
            onCommit(draft);
            setError('');
            setEditing(false);
          } catch (error) {
            setError(String(error));
          }
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            cancelled.current = true;
            setDraft(value);
            setError('');
            setEditing(false);
            event.currentTarget.blur();
          }
        }}
      />
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function ParameterInspector({
  project,
  variableId,
  engine,
  onChange,
  notify,
}: {
  project: Project;
  variableId: string;
  engine: RuntimeController;
  onChange: (change: (project: Project) => void) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => setHistoryOpen(false), [variableId]);
  const variable = project.variables.find((item) => item.id === variableId);
  const zh = project.locale === 'zh-CN';
  if (!variable) return null;
  const runtime = snapshot.values[variable.id];
  const runtimePending = snapshot.revision !== project.revision;
  const runtimeDisabled = Boolean(variable.readOnly || runtimePending || !runtime);
  const references = variableReferences(project, variable);
  const referenceReason = references.length
    ? `${zh ? '更改类型或删除前，请先移除引用' : 'Remove references before changing type or deleting'}: ${references.join(', ')}`
    : '';
  const update = (patch: Partial<Omit<Variable, 'id'>>) => {
    try {
      onChange((next) => updateParameterDefinition(next, variable.id, patch));
    } catch (error) {
      notify(String(error), true);
      throw error;
    }
  };
  const finiteNumber = (raw: string): number => {
    const number = Number(raw);
    if (!raw.trim() || !Number.isFinite(number))
      throw new Error(zh ? '请输入有效的有限数值' : 'Enter a finite number');
    return number;
  };
  const writeRuntimeValue = (value: Json) => {
    try {
      if (engine.getSnapshot().revision !== project.revision)
        throw new Error(zh ? '运行时正在更新，请稍后重试' : 'Runtime is updating. Please retry.');
      engine.setVariable(variable.id, value);
    } catch (error) {
      notify(String(error), true);
      throw error;
    }
  };
  const valueField = (kind: 'initial' | 'runtime') => {
    const value = kind === 'initial' ? variable.initial : (runtime?.value ?? null);
    const label = `${kind} ${variable.name}`;
    const disabled = kind === 'runtime' && runtimeDisabled;
    const commit = (next: Json) =>
      kind === 'initial' ? update({ initial: next }) : writeRuntimeValue(next);
    if (variable.type === 'json')
      return <JsonValueField label={label} value={value} disabled={disabled} onCommit={commit} />;
    if (variable.type === 'boolean')
      return (
        <input
          aria-label={label}
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => {
            try {
              commit(event.target.checked);
            } catch {
              /* The mutation reports its error. */
            }
          }}
        />
      );
    return (
      <CommitInput
        key={`${variable.id}-${kind}-${variable.type}`}
        label={label}
        type={variable.type === 'number' ? 'number' : 'text'}
        value={String(value ?? '')}
        disabled={disabled}
        onCommit={(raw) => commit(variable.type === 'number' ? finiteNumber(raw) : raw)}
      />
    );
  };
  return (
    <section className="qg-parameter-inspector" key={variable.id}>
      <header className="qg-parameter-heading">
        <div>
          <span>PARAMETER</span>
          <strong>{zh ? '参数属性' : 'Parameter properties'}</strong>
        </div>
        <Braces size={17} />
      </header>
      <div className="qg-parameter-fields">
        <label className="qg-parameter-field">
          <span>{zh ? '参数 ID' : 'Parameter ID'}</span>
          <output className="qg-parameter-id" title={variable.id}>
            {variable.id}
          </output>
        </label>
        <label className="qg-parameter-field">
          <span>{zh ? '参数名称' : 'Parameter name'}</span>
          <CommitInput
            key={`${variable.id}-name`}
            label={zh ? '参数名称' : 'Parameter name'}
            value={variable.name}
            onCommit={(name) => update({ name })}
          />
        </label>
        <label className="qg-parameter-field">
          <span>{zh ? '参数类型' : 'Parameter type'}</span>
          <select
            aria-label={zh ? '参数类型' : 'Parameter type'}
            title={referenceReason || undefined}
            value={variable.type}
            disabled={references.length > 0}
            onChange={(event) => {
              try {
                update({ type: event.target.value as Variable['type'] });
              } catch {
                /* Reported by update. */
              }
            }}
          >
            <option>number</option>
            <option>string</option>
            <option>boolean</option>
            <option>json</option>
          </select>
        </label>
        <label className="qg-parameter-field">
          <span>{zh ? '初始值' : 'Initial value'}</span>
          {valueField('initial')}
        </label>
        <label className="qg-parameter-field">
          <span>{zh ? '参数单位' : 'Parameter unit'}</span>
          <CommitInput
            key={`${variable.id}-unit`}
            label={zh ? '参数单位' : 'Parameter unit'}
            value={variable.unit ?? ''}
            onCommit={(unit) => update({ unit })}
          />
        </label>
        <label className="qg-parameter-toggle">
          <span>{zh ? '只读' : 'Read only'}</span>
          <input
            type="checkbox"
            checked={Boolean(variable.readOnly)}
            onChange={(event) => {
              try {
                update({ readOnly: event.target.checked });
              } catch {
                /* Reported by update. */
              }
            }}
          />
        </label>
        <label className="qg-parameter-toggle">
          <span>{zh ? '持久化' : 'Persist value'}</span>
          <input
            type="checkbox"
            checked={Boolean(variable.persistent)}
            onChange={(event) => {
              try {
                update({ persistent: event.target.checked });
              } catch {
                /* Reported by update. */
              }
            }}
          />
        </label>
      </div>
      <section className="qg-parameter-runtime">
        <h3>{zh ? '运行状态' : 'Runtime state'}</h3>
        <label className="qg-parameter-field">
          <span>{zh ? '运行值' : 'Runtime value'}</span>
          {valueField('runtime')}
        </label>
        {runtimePending && (
          <p className="qg-parameter-note">{zh ? '运行时正在更新…' : 'Runtime is updating…'}</p>
        )}
        <div className="qg-parameter-state">
          <span>{zh ? '质量' : 'Quality'}</span>
          <span className="quality-tag">{runtime?.quality ?? '—'}</span>
        </div>
        <div className="qg-parameter-state">
          <span>{zh ? '时间戳' : 'Timestamp'}</span>
          <time>{runtime ? new Date(runtime.timestamp).toLocaleString(project.locale) : '—'}</time>
        </div>
      </section>
      {variable.type === 'number' && (
        <details
          className="qg-parameter-history"
          open={historyOpen}
          onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
        >
          <summary>{zh ? '历史与报警' : 'History & alarms'}</summary>
          {historyOpen && (
            <HistoryPanel
              key={variable.id}
              project={project}
              engine={engine}
              onChange={onChange}
              variableId={variable.id}
            />
          )}
        </details>
      )}
      <footer className="qg-parameter-footer">
        {referenceReason && <p className="qg-parameter-note">{referenceReason}</p>}
        <button
          className="button danger"
          disabled={references.length > 0}
          title={referenceReason || undefined}
          onClick={() => {
            try {
              onChange((next) => deleteParameterDefinition(next, variable.id));
            } catch (error) {
              notify(String(error), true);
            }
          }}
        >
          <Trash2 size={13} />
          {zh ? '删除参数' : 'Delete parameter'}
        </button>
      </footer>
    </section>
  );
}
