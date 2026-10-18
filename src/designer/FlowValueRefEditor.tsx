import { Field } from './Fields';
import { JsonValueField } from '../panels/JsonValueField';
import { assertJsonPath } from '../core/jsonValue';
import type { Json, JsonPath, Project } from '../core/types';

export function FlowValueRefEditor({
  label,
  value,
  project,
  onChange,
}: {
  label: string;
  value: Json | undefined;
  project: Project;
  onChange: (value: Json) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const ref =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { source: 'literal', value: null };
  const source = String(ref.source ?? 'literal');
  return (
    <fieldset
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 9,
        margin: '10px 0',
        minWidth: 0,
      }}
    >
      <legend style={{ color: 'var(--muted)', fontSize: 11 }}>{label}</legend>
      <Field label={zh ? '取值来源' : 'Value source'}>
        <select
          aria-label={`${label} ${zh ? '来源' : 'source'}`}
          value={source}
          onChange={(event) => {
            const source = event.target.value;
            onChange(
              source === 'literal'
                ? { source, value: null }
                : source === 'input'
                  ? { source, path: [] }
                  : { source, variable: project.variables[0]?.id ?? '', path: [] },
            );
          }}
        >
          <option value="literal">{zh ? '固定值' : 'Literal'}</option>
          <option value="input">{zh ? '上游消息' : 'Incoming message'}</option>
          <option value="variable">{zh ? '工程变量' : 'Project variable'}</option>
        </select>
      </Field>
      {source === 'literal' ? (
        <JsonValueField
          label={`${label} ${zh ? '固定值 JSON' : 'literal JSON'}`}
          value={ref.value ?? null}
          onCommit={(next) => onChange({ source, value: next })}
        />
      ) : (
        <>
          {source === 'variable' && (
            <Field label={zh ? '变量' : 'Variable'}>
              <select
                aria-label={`${label} ${zh ? '变量' : 'variable'}`}
                value={String(ref.variable ?? '')}
                onChange={(event) => onChange({ ...ref, variable: event.target.value })}
              >
                <option value="">{zh ? '选择变量' : 'Choose a variable'}</option>
                {project.variables.map((variable) => (
                  <option key={variable.id} value={variable.id}>
                    {variable.name} · {variable.type}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={zh ? '字段路径（[] 为整个值）' : 'Path ([] means the whole value)'}>
            <JsonValueField
              label={`${label} ${zh ? '路径' : 'path'}`}
              value={ref.path ?? []}
              onCommit={(path) => {
                assertJsonPath(path as JsonPath);
                onChange({ ...ref, path });
              }}
            />
          </Field>
        </>
      )}
    </fieldset>
  );
}

export function FlowMapFieldsEditor({
  fields,
  project,
  onChange,
}: {
  fields: Json | undefined;
  project: Project;
  onChange: (fields: Json) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const entries = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  return (
    <div>
      {Object.entries(entries).map(([key, value]) => (
        <div key={key}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              aria-label={zh ? '输出字段名' : 'Output field name'}
              defaultValue={key}
              style={{ minWidth: 0, width: '100%' }}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (!name || (name !== key && Object.hasOwn(entries, name))) {
                  event.target.value = key;
                  return;
                }
                if (name !== key) {
                  const next = { ...entries };
                  delete next[key];
                  Object.defineProperty(next, name, {
                    value,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                  });
                  onChange(next);
                }
              }}
            />
            <button
              className="qg-secondary-button"
              aria-label={`${zh ? '删除字段' : 'Remove field'} ${key}`}
              onClick={() => {
                const next = { ...entries };
                delete next[key];
                onChange(next);
              }}
            >
              ×
            </button>
          </div>
          <FlowValueRefEditor
            label={key}
            value={value}
            project={project}
            onChange={(value) => onChange({ ...entries, [key]: value })}
          />
        </div>
      ))}
      <button
        className="qg-secondary-button"
        onClick={() => {
          let index = Object.keys(entries).length + 1;
          while (Object.hasOwn(entries, `field${index}`)) index++;
          onChange({ ...entries, [`field${index}`]: { source: 'input', path: [] } });
        }}
      >
        {zh ? '添加输出字段' : 'Add output field'}
      </button>
    </div>
  );
}
