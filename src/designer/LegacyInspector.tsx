import { useState } from 'react';
import {
  Code2,
  SlidersHorizontal,
  Copy,
  Trash2,
  Check,
  AlertCircle,
  Link2,
  Zap,
  Plus,
  X,
} from 'lucide-react';
import type { Json, Locale, Project, Widget } from '../core/types';
import { errorText, parseWidgetCode } from '../core/validation';
import { CodeEditor } from './CodeEditor';
import { Field, NumberInput, Section, Toggle } from './Fields';
import './designer.css';

export interface InspectorProps {
  widget?: Widget | null;
  project: Project;
  onUpdate: (patch: Partial<Widget>) => void;
  draft: string | undefined;
  onDraft: (text: string | undefined) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  locale: Locale;
}
const propertyLabels: Record<string, [string, string]> = {
  text: ['文本', 'Text'],
  label: ['标签', 'Label'],
  title: ['标题', 'Title'],
  value: ['数值 / 内容', 'Value'],
  placeholder: ['占位文字', 'Placeholder'],
  min: ['最小值', 'Minimum'],
  max: ['最大值', 'Maximum'],
  step: ['步长', 'Step'],
  unit: ['单位', 'Unit'],
  disabled: ['禁用', 'Disabled'],
  visible: ['可见', 'Visible'],
  src: ['图片地址', 'Image source'],
  checked: ['开启', 'Checked'],
  enabled: ['启用', 'Enabled'],
  options: ['选项', 'Options'],
  color: ['颜色', 'Color'],
  rows: ['数据行', 'Rows'],
};

export function LegacyInspector(props: InspectorProps) {
  if (!props.widget)
    return (
      <div className="qg-inspector-empty">
        <SlidersHorizontal size={28} />
        <strong>{props.locale === 'zh-CN' ? '选择一个组件' : 'Select a component'}</strong>
        <span>
          {props.locale === 'zh-CN'
            ? '在画布中选择组件，编辑属性与数据绑定。'
            : 'Select a component on the canvas to edit its properties and bindings.'}
        </span>
      </div>
    );
  return <WidgetInspector key={props.widget.id} {...props} widget={props.widget} />;
}

function WidgetInspector({
  widget,
  project,
  onUpdate,
  draft,
  onDraft,
  onDelete,
  onDuplicate,
  locale,
}: InspectorProps & { widget: Widget }) {
  const [tab, setTab] = useState<'design' | 'code'>('design');
  const [codeError, setCodeError] = useState('');
  const [newBinding, setNewBinding] = useState('value');
  const zh = locale === 'zh-CN';
  const code =
    draft ??
    JSON.stringify({ props: widget.props, style: widget.style, states: widget.states }, null, 2);
  const updateProperty = (key: string, value: Json) =>
    onUpdate({ props: { ...widget.props, [key]: value } });
  const updateStyle = (key: string, value: string | number) =>
    onUpdate({ style: { ...widget.style, [key]: value } });
  const patchLayout = (key: keyof Widget['layout'], value: string | number) =>
    onUpdate({ layout: { ...widget.layout, [key]: value } });
  const eventNames = [
    ...new Set([
      ...(widget.type === 'button'
        ? ['click']
        : widget.type === 'input'
          ? ['change', 'submit']
          : ['number', 'switch', 'slider', 'select'].includes(widget.type)
            ? ['change']
            : []),
      ...(project.modules.find((module) => module.id === widget.moduleId)?.implementation?.events ??
        []),
      ...Object.keys(widget.events),
    ]),
  ];
  const applyCode = () => {
    try {
      const parsed = parseWidgetCode(code);
      onUpdate(parsed);
      onDraft(undefined);
      setCodeError('');
    } catch (error) {
      setCodeError(errorText(error));
    }
  };
  return (
    <div className="qg-inspector">
      <div className="qg-inspector-heading">
        <div>
          <span className="qg-widget-type">{widget.type.toUpperCase()}</span>
          <strong title={widget.name}>{widget.name}</strong>
        </div>
        <div className="qg-toolbar-cluster">
          <button
            className="qg-icon-button"
            title={zh ? '复制组件' : 'Duplicate component'}
            aria-label={zh ? '复制组件' : 'Duplicate component'}
            onClick={onDuplicate}
          >
            <Copy size={14} />
          </button>
          <button
            className="qg-icon-button danger"
            title={zh ? '删除组件' : 'Delete component'}
            aria-label={zh ? '删除组件' : 'Delete component'}
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="qg-segmented">
        <button className={tab === 'design' ? 'active' : ''} onClick={() => setTab('design')}>
          <SlidersHorizontal size={13} />
          {zh ? '属性' : 'Properties'}
        </button>
        <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
          <Code2 size={14} />
          CODE{draft !== undefined && <span className="qg-unsaved-dot" />}
        </button>
      </div>
      {tab === 'code' ? (
        <div className="qg-code-properties">
          <p className="qg-field-hint">
            {zh
              ? '编辑此组件的 props、style 和 states。通过校验后应用到画布。'
              : 'Edit this component’s props, style and states. Apply after validation to update the canvas.'}
          </p>
          <CodeEditor
            value={code}
            onChange={(value) => {
              onDraft(value);
              setCodeError('');
            }}
            height={440}
          />
          {codeError && (
            <div className="qg-error" role="alert">
              <AlertCircle size={14} />
              <span>{codeError}</span>
            </div>
          )}
          <div className="qg-code-actions">
            <button
              className="qg-secondary-button"
              disabled={draft === undefined}
              onClick={() => {
                onDraft(undefined);
                setCodeError('');
              }}
            >
              {zh ? '还原草稿' : 'Discard draft'}
            </button>
            <button className="qg-primary-button" onClick={applyCode}>
              <Check size={14} />
              {zh ? '应用代码' : 'Apply code'}
            </button>
          </div>
          <span className="qg-field-hint">
            {zh
              ? '未应用的草稿会随组件保留；属性编辑不会覆盖草稿。'
              : 'Unapplied drafts are retained per component. Property edits do not overwrite a draft.'}
          </span>
        </div>
      ) : (
        <>
          <Section title={zh ? '组件' : 'COMPONENT'}>
            <Field label={zh ? '名称' : 'Name'}>
              <input
                value={widget.name}
                onChange={(event) => onUpdate({ name: event.target.value })}
              />
            </Field>
            <div className="qg-id-display">
              ID <code>{widget.id}</code>
            </div>
          </Section>
          <Section title={zh ? '位置与尺寸' : 'POSITION & SIZE'}>
            <div className="qg-field-grid">
              {(['x', 'y', 'width', 'height'] as const).map((key) => (
                <Field key={key} label={{ x: 'X', y: 'Y', width: 'W', height: 'H' }[key]}>
                  <NumberInput
                    value={widget.layout[key]}
                    min={key === 'width' || key === 'height' ? 20 : 0}
                    onChange={(value) => patchLayout(key, value)}
                  />
                </Field>
              ))}
            </div>
            {widget.type === 'panel' && (
              <>
                <Field label={zh ? '布局方式' : 'Layout'}>
                  <select
                    value={widget.layout.mode || 'absolute'}
                    onChange={(event) => patchLayout('mode', event.target.value)}
                  >
                    <option value="absolute">{zh ? '自由布局' : 'Absolute'}</option>
                    <option value="flex">Flex</option>
                    <option value="grid">Grid</option>
                  </select>
                </Field>
                {widget.layout.mode !== 'absolute' && widget.layout.mode && (
                  <div className="qg-field-grid">
                    <Field label={zh ? '间距' : 'Gap'}>
                      <NumberInput
                        value={widget.layout.gap ?? 12}
                        min={0}
                        onChange={(value) => patchLayout('gap', value)}
                      />
                    </Field>
                    {widget.layout.mode === 'grid' ? (
                      <Field label={zh ? '列数' : 'Columns'}>
                        <NumberInput
                          value={widget.layout.columns ?? 2}
                          min={1}
                          max={24}
                          onChange={(value) => patchLayout('columns', value)}
                        />
                      </Field>
                    ) : (
                      <Field label={zh ? '方向' : 'Direction'}>
                        <select
                          value={widget.layout.direction ?? 'row'}
                          onChange={(event) => patchLayout('direction', event.target.value)}
                        >
                          <option value="row">{zh ? '水平' : 'Row'}</option>
                          <option value="column">{zh ? '垂直' : 'Column'}</option>
                        </select>
                      </Field>
                    )}
                  </div>
                )}
              </>
            )}
            <Field label={zh ? '父级容器' : 'Parent panel'}>
              <select
                value={widget.parentId ?? ''}
                onChange={(event) => onUpdate({ parentId: event.target.value || undefined })}
              >
                <option value="">{zh ? '主窗口' : 'Main window'}</option>
                {project.widgets
                  .filter(
                    (item) =>
                      item.type === 'panel' &&
                      item.id !== widget.id &&
                      !isDescendant(item, widget.id, project.widgets),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </Field>
          </Section>
          <Section title={zh ? '内容' : 'CONTENT'}>
            {Object.entries(widget.props)
              .filter(([key]) => key !== 'assetId' || widget.type !== 'image')
              .map(([key, value]) => {
                const label = propertyLabels[key]?.[zh ? 0 : 1] ?? key;
                if (typeof value === 'boolean')
                  return (
                    <Toggle
                      key={key}
                      label={label}
                      value={value}
                      onChange={(next) => updateProperty(key, next)}
                    />
                  );
                if (typeof value === 'number')
                  return (
                    <Field key={key} label={label}>
                      <NumberInput value={value} onChange={(next) => updateProperty(key, next)} />
                    </Field>
                  );
                if (typeof value === 'string')
                  return (
                    <Field key={key} label={label}>
                      <input
                        value={value}
                        onChange={(event) => updateProperty(key, event.target.value)}
                      />
                    </Field>
                  );
                return (
                  <div className="qg-complex-prop" key={key}>
                    <span>{label}</span>
                    <button onClick={() => setTab('code')}>
                      {Array.isArray(value) ? `${value.length} ${zh ? '项' : 'items'}` : '{…}'}{' '}
                      <Code2 size={12} />
                    </button>
                  </div>
                );
              })}
            {Object.keys(widget.props).length === 0 && (
              <span className="qg-field-hint">
                {zh ? '在 CODE 中配置组件属性' : 'Configure component properties in CODE'}
              </span>
            )}
            {widget.type === 'module' && (
              <Field label={zh ? '组件模块' : 'Component module'}>
                <select
                  value={widget.moduleId ?? ''}
                  onChange={(event) => onUpdate({ moduleId: event.target.value || undefined })}
                >
                  <option value="">{zh ? '选择模块' : 'Choose module'}</option>
                  {project.modules.map((module) => (
                    <option key={module.id} value={module.id}>
                      {module.name} · {module.version}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {widget.type === 'image' && (
              <Field label={zh ? '图片资源' : 'Image asset'}>
                <select
                  value={String(widget.props.assetId ?? '')}
                  onChange={(event) => updateProperty('assetId', event.target.value)}
                >
                  <option value="">{zh ? '选择图片资源' : 'Choose image asset'}</option>
                  {project.assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </Section>
          <Section title={zh ? '外观' : 'APPEARANCE'}>
            <div className="qg-field-grid">
              <Field label={zh ? '字号' : 'Font size'}>
                <NumberInput
                  value={Number(widget.style.fontSize ?? 14)}
                  min={8}
                  max={160}
                  onChange={(value) => updateStyle('fontSize', value)}
                />
              </Field>
              <Field label={zh ? '圆角' : 'Radius'}>
                <NumberInput
                  value={Number(widget.style.borderRadius ?? 8)}
                  min={0}
                  max={200}
                  onChange={(value) => updateStyle('borderRadius', value)}
                />
              </Field>
            </div>
            {(['color', 'background'] as const).map((key) => (
              <Field
                key={key}
                label={
                  key === 'color'
                    ? zh
                      ? '文字颜色'
                      : 'Text color'
                    : zh
                      ? '背景颜色'
                      : 'Background'
                }
              >
                <div className="qg-color-field">
                  <input
                    type="color"
                    aria-label={key}
                    value={
                      /^#[\da-f]{6}$/i.test(String(widget.style[key]))
                        ? String(widget.style[key])
                        : key === 'color'
                          ? '#e5e7eb'
                          : '#1e293b'
                    }
                    onChange={(event) => updateStyle(key, event.target.value)}
                  />
                  <input
                    value={String(widget.style[key] ?? '')}
                    placeholder="inherit"
                    onChange={(event) => updateStyle(key, event.target.value)}
                  />
                </div>
              </Field>
            ))}
            <Field label={zh ? '文本对齐' : 'Text align'}>
              <select
                value={String(widget.style.textAlign ?? 'left')}
                onChange={(event) => updateStyle('textAlign', event.target.value)}
              >
                <option value="left">{zh ? '左对齐' : 'Left'}</option>
                <option value="center">{zh ? '居中' : 'Center'}</option>
                <option value="right">{zh ? '右对齐' : 'Right'}</option>
              </select>
            </Field>
          </Section>
          <Section title={zh ? '数据绑定' : 'DATA BINDINGS'} action={<Link2 size={13} />}>
            {Object.entries(widget.bindings).map(([property, binding]) => (
              <div className="qg-binding" key={property}>
                <div className="qg-binding-label">
                  <code>{property}</code>
                  <button
                    className="qg-icon-button"
                    aria-label={zh ? '删除绑定' : 'Remove binding'}
                    onClick={() => {
                      const bindings = { ...widget.bindings };
                      delete bindings[property];
                      onUpdate({ bindings });
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
                <select
                  aria-label={zh ? '绑定变量' : 'Binding variable'}
                  value={binding.variable}
                  onChange={(event) =>
                    onUpdate({
                      bindings: {
                        ...widget.bindings,
                        [property]: { ...binding, variable: event.target.value },
                      },
                    })
                  }
                >
                  <option value="" disabled>
                    {zh ? '选择变量' : 'Select variable'}
                  </option>
                  {project.variables.map((variable) => (
                    <option key={variable.id} value={variable.id}>
                      {variable.name} · {variable.type}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={zh ? '绑定模式' : 'Binding mode'}
                  value={binding.mode}
                  onChange={(event) =>
                    onUpdate({
                      bindings: {
                        ...widget.bindings,
                        [property]: { ...binding, mode: event.target.value as typeof binding.mode },
                      },
                    })
                  }
                >
                  <option value="oneWay">{zh ? '单向 · 数据 → UI' : 'One way · data → UI'}</option>
                  <option value="twoWay">{zh ? '双向 · 数据 ↔ UI' : 'Two way · data ↔ UI'}</option>
                  <option value="once">{zh ? '仅初始化' : 'Once'}</option>
                </select>
              </div>
            ))}
            <div className="qg-add-binding">
              <select
                aria-label={zh ? '绑定属性' : 'Bind property'}
                value={newBinding}
                onChange={(event) => setNewBinding(event.target.value)}
              >
                {['value', 'text', 'enabled', 'visible', 'label', 'assetId'].map((property) => (
                  <option value={property} key={property}>
                    {property}
                  </option>
                ))}
              </select>
              <button
                className="qg-secondary-button"
                disabled={!!widget.bindings[newBinding] || !project.variables.length}
                onClick={() =>
                  onUpdate({
                    bindings: {
                      ...widget.bindings,
                      [newBinding]: { variable: project.variables[0]?.id ?? '', mode: 'oneWay' },
                    },
                  })
                }
              >
                <Plus size={13} />
                {zh ? '绑定' : 'Bind'}
              </button>
            </div>
            {!project.variables.length && (
              <p className="qg-field-hint">
                {zh ? '请先创建数据变量。' : 'Create a variable first.'}
              </p>
            )}
          </Section>
          <Section title={zh ? '事件与流程' : 'EVENTS & FLOWS'} action={<Zap size={13} />}>
            {eventNames.map((name) => (
              <Field key={name} label={`on${name[0].toUpperCase()}${name.slice(1)}`}>
                <select
                  value={widget.events[name] ?? ''}
                  onChange={(event) => {
                    const events = { ...widget.events };
                    if (event.target.value) events[name] = event.target.value;
                    else delete events[name];
                    onUpdate({ events });
                  }}
                >
                  <option value="">{zh ? '无关联流程' : 'No flow'}</option>
                  {project.flows.map((flow) => (
                    <option key={flow.id} value={flow.id}>
                      {flow.name}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
            {!eventNames.length && (
              <span className="qg-field-hint">
                {zh ? '此组件用于内容展示。' : 'This component displays content.'}
              </span>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function isDescendant(candidate: Widget, parentId: string, widgets: Widget[]) {
  const visited = new Set<string>();
  let current: Widget | undefined = candidate;
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === parentId) return true;
    visited.add(current.id);
    current = widgets.find((widget) => widget.id === current?.parentId);
  }
  return false;
}

export default LegacyInspector;
