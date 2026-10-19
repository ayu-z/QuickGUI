import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  BlockInput,
  BlockOutput,
  FlowNode,
  FunctionBlockInterface,
  Json,
  Project,
  VariableType,
} from '../core/types';
import {
  assertPortValue,
  createBlockInterface,
  validateBlockInterface,
} from '../core/functionBlocks';
import { validateJsonPath } from '../core/jsonValue';
import { Field } from './Fields';
import { JsonValueField } from '../panels/JsonValueField';

const defaultValue = (type: VariableType): Json =>
  type === 'number' ? 0 : type === 'boolean' ? false : type === 'string' ? '' : null;

export function FunctionBlockEditor({
  node,
  project,
  onEnable,
  onApply,
}: {
  node: FlowNode;
  project: Project;
  onEnable: (block: FunctionBlockInterface) => void;
  onApply: (block: FunctionBlockInterface) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const [draft, setDraft] = useState<FunctionBlockInterface>(() =>
    structuredClone(node.block ?? createBlockInterface(node, project)),
  );
  const [error, setError] = useState('');
  useEffect(() => {
    if (node.block) setDraft(structuredClone(node.block));
    setError('');
  }, [node.block]);
  if (!node.block)
    return (
      <div className="qg-fb-editor">
        <button className="qg-button" onClick={() => onEnable(createBlockInterface(node, project))}>
          {zh ? '启用 FB 端口' : 'Enable FB ports'}
        </button>
        <p className="qg-field-hint">
          {zh
            ? '为功能块添加命名数据输入与输出，分别连接参数和结果。'
            : 'Expose named data inputs and outputs for parameters and results.'}
        </p>
      </div>
    );
  const updateInput = (index: number, patch: Partial<BlockInput>) =>
    setDraft((d) => ({
      ...d,
      inputs: d.inputs.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    }));
  const updateOutput = (index: number, patch: Partial<BlockOutput>) =>
    setDraft((d) => ({
      ...d,
      outputs: d.outputs.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    }));
  const typeSelect = (
    value: VariableType,
    label: string,
    onChange: (type: VariableType) => void,
  ) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as VariableType)}
    >
      {(['number', 'boolean', 'string', 'json'] as const).map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
  return (
    <section className="qg-fb-editor" aria-label={zh ? 'FB 端口' : 'FB ports'}>
      <div className="qg-flow-settings-title">{zh ? 'FB 数据端口' : 'FB DATA PORTS'}</div>
      <p className="qg-field-hint">
        {zh
          ? 'EN 触发执行，数据线提供参数。同一输入只接一个数据源，输出可分接多处。未连接 EN 的块在下游需要时求值。'
          : 'EN triggers execution; data wires supply parameters. Each input accepts one source; outputs can fan out. An unwired EN evaluates on demand.'}
      </p>
      {draft.inputs.map((port, index) => (
        <fieldset key={port.id} className="qg-fb-port-editor">
          <legend>{zh ? `输入 ${index + 1}` : `Input ${index + 1}`}</legend>
          <Field label={zh ? '端口名称' : 'Port name'}>
            <input
              aria-label={`input-${index}-name`}
              value={port.name}
              onChange={(e) => updateInput(index, { name: e.target.value })}
            />
          </Field>
          <Field label={zh ? '数据类型' : 'Data type'}>
            {typeSelect(port.type, `input-${index}-type`, (type) =>
              updateInput(index, {
                type,
                ...(Object.hasOwn(port, 'defaultValue')
                  ? { defaultValue: defaultValue(type) }
                  : {}),
              }),
            )}
          </Field>
          {port.binding === 'field' && (
            <Field label={zh ? 'JSON 字段名' : 'JSON field name'}>
              <input
                aria-label={`input-${index}-key`}
                value={port.key ?? ''}
                onChange={(e) => updateInput(index, { key: e.target.value })}
              />
            </Field>
          )}
          <label className="qg-fb-default-toggle">
            <input
              type="checkbox"
              checked={Object.hasOwn(port, 'defaultValue')}
              onChange={(e) => {
                if (e.target.checked) updateInput(index, { defaultValue: defaultValue(port.type) });
                else
                  setDraft((d) => ({
                    ...d,
                    inputs: d.inputs.map((p, i) => {
                      if (i !== index) return p;
                      const next = { ...p };
                      delete next.defaultValue;
                      return next;
                    }),
                  }));
              }}
            />
            {zh ? '未连线时使用默认值' : 'Use a default when unwired'}
          </label>
          {Object.hasOwn(port, 'defaultValue') && (
            <JsonValueField
              label={`input-${index}-default`}
              value={port.defaultValue!}
              onCommit={(value) => {
                assertPortValue(port.type, value, port.name);
                updateInput(index, { defaultValue: value });
              }}
            />
          )}
          {port.binding === 'field' && (
            <button
              className="qg-icon-button danger"
              aria-label={`${zh ? '删除输入' : 'Remove input'} ${index + 1}`}
              onClick={() =>
                setDraft((d) => ({ ...d, inputs: d.inputs.filter((_, i) => i !== index) }))
              }
            >
              <Trash2 size={13} />
            </button>
          )}
        </fieldset>
      ))}
      {['script', 'map'].includes(node.kind) &&
        draft.inputs.every((p) => p.binding !== 'input') && (
          <button
            className="qg-button"
            disabled={draft.inputs.length >= 16}
            onClick={() => {
              let suffix = draft.inputs.length + 1;
              while (draft.inputs.some((p) => p.key === `IN${suffix}`)) suffix++;
              setDraft((d) => ({
                ...d,
                inputs: [
                  ...d.inputs,
                  {
                    id: `p_${crypto.randomUUID()}`,
                    name: `IN${suffix}`,
                    key: `IN${suffix}`,
                    type: 'number',
                    binding: 'field',
                    defaultValue: 0,
                  },
                ],
              }));
            }}
          >
            <Plus size={13} />
            {zh ? '添加数据输入' : 'Add data input'}
          </button>
        )}
      {draft.outputs.map((port, index) => (
        <fieldset key={port.id} className="qg-fb-port-editor">
          <legend>{zh ? `输出 ${index + 1}` : `Output ${index + 1}`}</legend>
          <Field label={zh ? '端口名称' : 'Port name'}>
            <input
              aria-label={`output-${index}-name`}
              value={port.name}
              onChange={(e) => updateOutput(index, { name: e.target.value })}
            />
          </Field>
          <Field label={zh ? '数据类型' : 'Data type'}>
            {typeSelect(port.type, `output-${index}-type`, (type) => updateOutput(index, { type }))}
          </Field>
          <Field label={zh ? '结果路径（[] 为完整结果）' : 'Result path ([] for full result)'}>
            <JsonValueField
              label={`output-${index}-path`}
              value={port.path}
              onCommit={(value) => {
                validateJsonPath(value);
                updateOutput(index, { path: value });
              }}
            />
          </Field>
          <button
            className="qg-icon-button danger"
            aria-label={`${zh ? '删除输出' : 'Remove output'} ${index + 1}`}
            onClick={() =>
              setDraft((d) => ({ ...d, outputs: d.outputs.filter((_, i) => i !== index) }))
            }
          >
            <Trash2 size={13} />
          </button>
        </fieldset>
      ))}
      <button
        className="qg-button"
        disabled={draft.outputs.length >= 16}
        onClick={() => {
          let suffix = draft.outputs.length + 1;
          while (draft.outputs.some((p) => p.name === `OUT${suffix}`)) suffix++;
          setDraft((d) => ({
            ...d,
            outputs: [
              ...d.outputs,
              { id: `p_${crypto.randomUUID()}`, name: `OUT${suffix}`, type: 'json', path: [] },
            ],
          }));
        }}
      >
        <Plus size={13} />
        {zh ? '添加数据输出' : 'Add data output'}
      </button>
      <p className="qg-field-hint">
        {zh
          ? '输入/输出各最多 16 路。修改名称保留连线；移除端口会一并移除对应数据线。C 脚本的命名输入通过 qg_input_json() 读取，结果用 qg_emit_json() 输出。'
          : 'Up to 16 inputs and 16 outputs. Renaming preserves wires; removing a port removes its data wires. C named inputs use qg_input_json(); results use qg_emit_json().'}
      </p>
      <button
        className="qg-button primary"
        onClick={() => {
          try {
            validateBlockInterface({ ...node, block: draft });
            onApply(structuredClone(draft));
            setError('');
          } catch (error) {
            setError(String(error));
          }
        }}
      >
        {zh ? '应用端口' : 'Apply ports'}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
