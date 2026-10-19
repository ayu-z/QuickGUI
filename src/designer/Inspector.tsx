import { useEffect, useRef, useState } from 'react';
import {
  Code2,
  Copy,
  Trash2,
  SlidersHorizontal,
  Search,
  RotateCcw,
  X,
  Plus,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import type { Binding, Json, Locale, Project, Widget } from '../core/types';
import {
  getBindableProperties,
  getWidgetDefinition,
  inferBindingPath,
  remapArrayBindings,
  resolvedWidgetProps,
  resolveWidgetResourceScope,
  validatePropertyPatch,
  WIDGET_STATES,
  type PropertyDefinition,
} from '../core/widgetDefinitions';
import { errorText, parseWidgetCode } from '../core/validation';
import { Field, NumberInput, Section } from './Fields';
import { CodeEditor } from './CodeEditor';
import { FlowBindingSelect } from './FlowBindingSelect';
import { scopedProject, WidgetView } from '../runtime/WidgetRenderer';
import './designer.css';
import './propertyInspector.css';

export interface InspectorProps {
  widget?: Widget | null;
  selectedWidgets?: Widget[];
  project: Project;
  onUpdate: (patch: Partial<Widget>) => void;
  onUpdateMany?: (patches: { id: string; patch: Partial<Widget> }[]) => void;
  draft: string | undefined;
  onDraft: (text: string | undefined) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onEditModule?: () => void;
  locale: Locale;
  onBeginTransaction?: (label?: string) => void;
  onCommitTransaction?: () => void;
  onCancelTransaction?: () => void;
}
function widgetLocked(widget: Widget, project: Project): boolean {
  const visited = new Set<string>();
  let current: Widget | undefined = widget;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.editor?.locked) return true;
    current = project.widgets.find((entry) => entry.id === current?.parentId);
  }
  return false;
}
export function Inspector(props: InspectorProps) {
  if (!props.widget) return null;
  return <PropertyInspector key={props.widget.id} {...props} widget={props.widget} />;
}
function DraftText({
  value,
  onChange,
  multiline = false,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  label?: string;
}) {
  const [draft, setDraft] = useState(value);
  const cancel = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const shared = {
    value: draft,
    placeholder,
    'aria-label': label,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(event.target.value),
    onBlur: () => {
      if (cancel.current) {
        cancel.current = false;
        return;
      }
      if (draft !== value) onChange(draft);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        cancel.current = true;
        setDraft(value);
        event.currentTarget.blur();
      }
      if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey))
        event.currentTarget.blur();
    },
  };
  return multiline ? <textarea {...shared} rows={3} /> : <input {...shared} />;
}
function JsonEditor({
  value,
  onChange,
  label,
}: {
  value: Json;
  onChange: (value: Json) => void;
  label: string;
}) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2)),
    [error, setError] = useState('');
  useEffect(() => {
    setDraft(JSON.stringify(value, null, 2));
    setError('');
  }, [value]);
  return (
    <div className="qg-json-field">
      <textarea
        aria-label={label}
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError('');
        }}
        rows={5}
      />
      <button
        className="qg-secondary-button"
        onClick={() => {
          try {
            onChange(JSON.parse(draft) as Json);
            setError('');
          } catch (cause) {
            setError(errorText(cause));
          }
        }}
      >
        JSON ✓
      </button>
      {error && (
        <span className="qg-field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
function ArrayEditor({
  kind,
  value,
  project,
  locale,
  onChange,
  headerFromFirstRow = false,
}: {
  kind: 'options' | 'series' | 'columns';
  value: Json;
  project: Project;
  locale: Locale;
  onChange: (value: Json) => void;
  headerFromFirstRow?: boolean;
}) {
  const items = Array.isArray(value) ? value : [],
    zh = locale === 'zh-CN';
  const object = (raw: Json, index: number): Record<string, Json> =>
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw
      : { id: 'option_' + index, label: String(raw), value: raw };
  const update = (index: number, key: string, value: Json) =>
    onChange(items.map((item, i) => (i === index ? { ...object(item, i), [key]: value } : item)));
  const move = (from: number, to: number) => {
    const next = [...items];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
  };
  return (
    <div className="qg-array-editor">
      {items.map((raw, index) => {
        const item = object(raw, index),
          nameKey = kind === 'options' ? 'label' : kind === 'series' ? 'name' : 'title';
        return (
          <div className="qg-array-item" key={String(item.id ?? index)}>
            <div className="qg-array-heading">
              <code>{String(item.id ?? index + 1)}</code>
              <button
                title={zh ? '上移' : 'Move up'}
                disabled={!index}
                onClick={() => move(index, index - 1)}
              >
                <ArrowUp size={12} />
              </button>
              <button
                title={zh ? '下移' : 'Move down'}
                disabled={index === items.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <ArrowDown size={12} />
              </button>
              <button
                title={zh ? '删除' : 'Remove'}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <X size={12} />
              </button>
            </div>
            <Field label={zh ? '名称' : 'Name'}>
              {kind === 'columns' && headerFromFirstRow ? (
                <span className="qg-field-hint">
                  {zh ? '标题来自数据首行' : 'Heading follows the first data row'}
                </span>
              ) : (
                <DraftText
                  value={String(item[nameKey] ?? '')}
                  onChange={(value) => update(index, nameKey, value)}
                />
              )}
            </Field>
            {kind === 'options' && (
              <>
                <Field label={zh ? '值类型' : 'Value type'}>
                  <select
                    value={typeof item.value}
                    onChange={(event) =>
                      update(
                        index,
                        'value',
                        event.target.value === 'number'
                          ? 0
                          : event.target.value === 'boolean'
                            ? false
                            : '',
                      )
                    }
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                  </select>
                </Field>
                <Field label={zh ? '值' : 'Value'}>
                  {typeof item.value === 'number' ? (
                    <NumberInput
                      value={item.value}
                      onChange={(value) => update(index, 'value', value)}
                      commitOnBlur
                    />
                  ) : typeof item.value === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={item.value}
                      onChange={(event) => update(index, 'value', event.target.checked)}
                    />
                  ) : (
                    <DraftText
                      value={String(item.value ?? '')}
                      onChange={(value) => update(index, 'value', value)}
                    />
                  )}
                </Field>
                <Field label={zh ? '禁用' : 'Disabled'}>
                  <input
                    type="checkbox"
                    checked={item.disabled === true}
                    onChange={(event) => update(index, 'disabled', event.target.checked)}
                  />
                </Field>
              </>
            )}
            {kind === 'series' && (
              <>
                <Field label={zh ? '静态数值' : 'Static value'}>
                  <NumberInput
                    value={Number(item.value ?? 0)}
                    commitOnBlur
                    onChange={(value) => update(index, 'value', value)}
                  />
                </Field>
                <Field label={zh ? '曲线颜色 / token' : 'Color / token'}>
                  <DraftText
                    value={String(item.color ?? '$color.primary')}
                    onChange={(value) => update(index, 'color', value)}
                  />
                </Field>
                <Field label={zh ? '显示曲线' : 'Visible'}>
                  <input
                    type="checkbox"
                    checked={item.visible !== false}
                    onChange={(event) => update(index, 'visible', event.target.checked)}
                  />
                </Field>
                <Field label={zh ? '历史变量' : 'History variable'}>
                  <select
                    value={String(item.variableId ?? '')}
                    onChange={(event) => {
                      if (event.target.value) update(index, 'variableId', event.target.value);
                      else
                        onChange(
                          items.map((raw, i) => {
                            if (i !== index) return raw;
                            const next = { ...item };
                            delete next.variableId;
                            return next;
                          }),
                        );
                    }}
                  >
                    <option value="">—</option>
                    {project.variables
                      .filter((variable) => variable.type === 'number')
                      .map((variable) => (
                        <option key={variable.id} value={variable.id}>
                          {variable.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </>
            )}
            {kind === 'columns' && (
              <>
                <Field label={zh ? '字段路径（JSON 数组）' : 'Field path (JSON array)'}>
                  <JsonEditor
                    label="Column JSON path"
                    value={item.path ?? []}
                    onChange={(value) => update(index, 'path', value)}
                  />
                </Field>
                <Field label={zh ? '列宽（0自动）' : 'Width (0 automatic)'}>
                  <NumberInput
                    value={Number(item.width ?? 0)}
                    min={0}
                    max={10000}
                    commitOnBlur
                    onChange={(value) => update(index, 'width', value)}
                  />
                </Field>
                <Field label={zh ? '对齐' : 'Align'}>
                  <select
                    value={String(item.align ?? 'left')}
                    onChange={(event) => update(index, 'align', event.target.value)}
                  >
                    {['left', 'center', 'right'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </Field>
                <Field label={zh ? '格式' : 'Format'}>
                  <select
                    value={String(item.format ?? 'text')}
                    onChange={(event) => update(index, 'format', event.target.value)}
                  >
                    {['text', 'number', 'json'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>
        );
      })}
      <button
        className="qg-secondary-button"
        disabled={kind === 'series' && items.length >= 16}
        onClick={() => {
          const id = kind + '_' + crypto.randomUUID().slice(0, 8);
          onChange([
            ...items,
            kind === 'series'
              ? {
                  id,
                  name: 'Series ' + (items.length + 1),
                  value: 0,
                  color: '$color.primary',
                  visible: true,
                }
              : kind === 'columns'
                ? { id, title: 'Column ' + (items.length + 1), path: [], align: 'left' }
                : {
                    id,
                    label: 'Option ' + (items.length + 1),
                    value: 'option_' + (items.length + 1),
                    disabled: false,
                  },
          ]);
        }}
      >
        <Plus size={12} />
        {zh ? '添加' : 'Add'}
      </button>
    </div>
  );
}
function PropertyControl({
  definition,
  value,
  mixed,
  project,
  locale,
  onChange,
  headerFromFirstRow,
}: {
  definition: PropertyDefinition;
  value: Json;
  mixed: boolean;
  project: Project;
  locale: Locale;
  onChange: (value: Json) => void;
  headerFromFirstRow?: boolean;
}) {
  const label = definition.label[locale === 'zh-CN' ? 'zh' : 'en'];
  if (definition.editor === 'toggle')
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={!mixed && value === true}
        ref={(node) => {
          if (node) node.indeterminate = mixed;
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  if (definition.editor === 'number' && typeof value !== 'string')
    return (
      <NumberInput
        label={label}
        value={typeof value === 'number' ? value : 0}
        min={definition.min}
        max={definition.max}
        step={definition.step}
        integer={definition.integer}
        mixed={mixed}
        commitOnBlur
        onChange={onChange}
      />
    );
  if (definition.editor === 'select')
    return (
      <select
        aria-label={label}
        value={mixed ? '' : String(value)}
        onChange={(event) =>
          onChange(definition.type === 'number' ? Number(event.target.value) : event.target.value)
        }
      >
        {mixed && <option value="">—</option>}
        {definition.enum?.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    );
  if (definition.editor === 'asset')
    return (
      <select
        aria-label={label}
        value={mixed ? '' : String(value)}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">—</option>
        {project.assets
          .filter(
            (asset, index, assets) => assets.findIndex((item) => item.id === asset.id) === index,
          )
          .map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name}
            </option>
          ))}
      </select>
    );
  if (definition.editor === 'color') {
    const resolved = String(value).startsWith('$')
      ? (project.theme.tokens[String(value).slice(1)] ?? '')
      : String(value);
    return (
      <div className="qg-color-token">
        <input
          type="color"
          aria-label={label + ' color'}
          value={/^#[\da-f]{6}$/i.test(resolved) ? resolved : '#000000'}
          onChange={(event) => onChange(event.target.value)}
        />
        <DraftText
          label={label}
          value={mixed ? '' : String(value)}
          placeholder={mixed ? '—' : 'inherit'}
          onChange={onChange}
        />
        <select
          aria-label={label + ' token'}
          value={String(value).startsWith('$') ? String(value) : ''}
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value);
          }}
        >
          <option value="">token</option>
          {Object.keys(project.theme.tokens).map((key) => (
            <option key={key} value={'$' + key}>
              {key}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (
    definition.editor === 'options' ||
    definition.editor === 'series' ||
    definition.editor === 'columns'
  )
    return (
      <ArrayEditor
        kind={definition.editor}
        value={value}
        project={project}
        locale={locale}
        onChange={onChange}
        headerFromFirstRow={headerFromFirstRow}
      />
    );
  if (definition.editor === 'json')
    return <JsonEditor label={label} value={value} onChange={onChange} />;
  return (
    <DraftText
      label={label}
      value={mixed ? '' : String(value ?? '')}
      multiline={definition.editor === 'textarea'}
      placeholder={mixed ? '—' : undefined}
      onChange={onChange}
    />
  );
}
function PropertyInspector({
  widget,
  selectedWidgets,
  project,
  onUpdate,
  onUpdateMany,
  draft,
  onDraft,
  onDelete,
  onDuplicate,
  onEditModule,
  locale,
  onBeginTransaction,
  onCommitTransaction,
  onCancelTransaction,
}: InspectorProps & { widget: Widget }) {
  const zh = locale === 'zh-CN',
    selected = selectedWidgets?.length ? selectedWidgets : [widget],
    multiple = selected.length > 1;
  const [tab, setTab] = useState<'design' | 'code'>('design'),
    [search, setSearch] = useState(''),
    [state, setState] = useState('default'),
    [error, setError] = useState(''),
    [newBinding, setNewBinding] = useState('');
  const module = project.modules.find((entry) => entry.id === widget.moduleId),
    definition = getWidgetDefinition(widget.type, 2, module);
  const selectionLocked = selected.some((item) => widgetLocked(item, project));
  const scope = resolveWidgetResourceScope(widget, project);
  const editorProject = scope
    ? scopedProject(
        {
          ...project,
          resourceScopes: [
            ...(project.resourceScopes ?? []).filter((item) => item.id !== scope.id),
            scope,
          ],
        },
        scope.id,
      )
    : project;
  const commonKeys = (key: string) =>
    selected.every(
      (item) =>
        item.definitionVersion === 2 &&
        getWidgetDefinition(
          item.type,
          2,
          project.modules.find((module) => module.id === item.moduleId),
        ).properties.some((entry) => {
          const primary = definition.properties.find((entry) => entry.key === key);
          return (
            entry.key === key && entry.type === primary?.type && entry.editor === primary.editor
          );
        }),
    );
  const visible = (entry: PropertyDefinition) =>
    !search ||
    (entry.key + ' ' + entry.label.zh + ' ' + entry.label.en)
      .toLowerCase()
      .includes(search.toLowerCase());
  const apply = (makePatch: (widget: Widget) => Partial<Widget>) => {
    if (selectionLocked) {
      setError(zh ? '请先解锁选中的控件。' : 'Unlock the selected widgets first.');
      return;
    }
    const patches = selected.map((item) => ({ id: item.id, patch: makePatch(item) }));
    const issues = patches.flatMap((item, index) =>
      validatePropertyPatch(selected[index], item.patch, project),
    );
    if (issues.length) {
      setError(issues.map((issue) => issue.path + ': ' + issue.message).join('\n'));
      return;
    }
    setError('');
    if (multiple && onUpdateMany) onUpdateMany(patches);
    else onUpdate(patches.find((item) => item.id === widget.id)!.patch);
  };
  const updateProperty = (key: string, value: Json | undefined) =>
    apply((item) => {
      const props = { ...item.props };
      if (value === undefined) delete props[key];
      else props[key] = structuredClone(value);
      const bindings =
        Array.isArray(value) && Array.isArray(item.props[key]) && key === 'series'
          ? remapArrayBindings(item.bindings, key, item.props[key] as Json[], value)
          : item.bindings;
      return { props, ...(bindings !== item.bindings ? { bindings } : {}) };
    });
  const updateStyle = (key: string, value: Json | undefined) =>
    apply((item) => {
      const style = { ...(state === 'default' ? item.style : (item.states[state] ?? {})) };
      if (value === undefined) delete style[key];
      else if (typeof value === 'string' || typeof value === 'number') style[key] = value;
      return state === 'default' ? { style } : { states: { ...item.states, [state]: style } };
    });
  const bindable = getBindableProperties(widget, module),
    bindingKey = bindable.some((entry) => entry.key === newBinding)
      ? newBinding
      : (bindable[0]?.key ?? '');
  const compatibleVariable = (
    variable: Project['variables'][number],
    property?: PropertyDefinition,
  ) =>
    !!property?.binding?.variableTypes.includes(variable.type) &&
    (variable.type !== 'json' || inferBindingPath(variable.initial, property) !== undefined);
  const code =
    draft ??
    JSON.stringify({ props: widget.props, style: widget.style, states: widget.states }, null, 2);
  const propertyRow = (entry: PropertyDefinition, isStyle = false) => {
    const get = (item: Widget): Json => {
      if (!isStyle)
        return resolvedWidgetProps(
          item,
          project.modules.find((module) => module.id === item.moduleId),
        )[entry.key];
      const own =
        state === 'default'
          ? item.style[entry.key]
          : (item.states[state]?.[entry.key] ?? item.style[entry.key]);
      if (own !== undefined) return own;
      const shorthand = /^padding(Top|Right|Bottom|Left)$/.test(entry.key)
        ? 'padding'
        : /^border(TopLeft|TopRight|BottomRight|BottomLeft)Radius$/.test(entry.key)
          ? 'borderRadius'
          : undefined;
      if (shorthand) {
        const inherited =
          state === 'default'
            ? item.style[shorthand]
            : (item.states[state]?.[shorthand] ?? item.style[shorthand]);
        if (inherited !== undefined) return inherited;
      }
      if (
        [
          'color',
          'fontSize',
          'fontWeight',
          'fontFamily',
          'textAlign',
          'lineHeight',
          'letterSpacing',
        ].includes(entry.key)
      ) {
        let parentId = item.parentId;
        const visited = new Set<string>();
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          const parent = project.widgets.find((widget) => widget.id === parentId);
          if (!parent || parent.definitionVersion !== 2) break;
          if (parent.style[entry.key] !== undefined) return parent.style[entry.key];
          parentId = parent.parentId;
        }
      }
      return entry.fallbackValue;
    };
    const value = get(widget),
      mixed = selected.some((item) => JSON.stringify(get(item)) !== JSON.stringify(value));
    const hasOverride = selected.some((item) =>
      Object.hasOwn(
        isStyle ? (state === 'default' ? item.style : (item.states[state] ?? {})) : item.props,
        entry.key,
      ),
    );
    const update = isStyle ? updateStyle : updateProperty;
    return (
      <div key={entry.key} className="qg-property-row">
        <div className="qg-property-label">
          <span>
            {entry.label[zh ? 'zh' : 'en']}
            {mixed && <em>{zh ? '多值' : 'Mixed'}</em>}
          </span>
          <button
            title={zh ? '恢复新建默认值' : 'Reset to creation default'}
            onClick={() => update(entry.key, entry.initialValue)}
          >
            <RotateCcw size={11} />
          </button>
          <button
            title={zh ? '移除覆盖，使用继承值' : 'Remove override'}
            disabled={!hasOverride}
            onClick={() => update(entry.key, undefined)}
          >
            <X size={11} />
          </button>
        </div>
        <PropertyControl
          definition={
            widget.type === 'select' &&
            entry.key === 'options' &&
            widget.props.legacyOptions === true
              ? { ...entry, editor: 'json' }
              : entry
          }
          value={value}
          mixed={mixed}
          project={editorProject}
          locale={locale}
          headerFromFirstRow={widget.type === 'table' && widget.props.headerFromFirstRow === true}
          onChange={(value) => update(entry.key, value)}
        />
        {!hasOverride && (
          <span className="qg-field-hint">{zh ? '继承 / 默认' : 'Inherited / default'}</span>
        )}
      </div>
    );
  };
  return (
    <div
      className="qg-inspector qg-metadata-inspector"
      onFocus={(event) => {
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement
        )
          onBeginTransaction?.('Edit widget property');
      }}
      onBlur={(event) => {
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement
        )
          onCommitTransaction?.();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancelTransaction?.();
      }}
    >
      <div className="qg-inspector-heading">
        <div>
          <span className="qg-widget-type">
            {multiple ? selected.length + (zh ? ' 个控件' : ' widgets') : widget.type.toUpperCase()}
          </span>
          <strong>{widget.name}</strong>
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
            disabled={selectionLocked}
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
        <button
          disabled={multiple}
          className={tab === 'code' ? 'active' : ''}
          onClick={() => setTab('code')}
        >
          <Code2 size={14} />
          CODE{draft !== undefined && <span className="qg-unsaved-dot" />}
        </button>
      </div>
      {error && (
        <div className="qg-error" role="alert" style={{ whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}
      {selectionLocked && (
        <p className="qg-field-hint">
          {zh
            ? '选中项包含已锁定控件，批量编辑已停用；请先在图层中解锁。'
            : 'Selection contains locked widgets. Unlock them in the layer tree before editing.'}
        </p>
      )}
      <div inert={selectionLocked}>
        {tab === 'code' ? (
          <div className="qg-code-properties">
            <CodeEditor value={code} onChange={onDraft} height={440} />
            <div className="qg-code-actions">
              <button
                className="qg-secondary-button"
                onClick={() => {
                  onDraft(undefined);
                  setError('');
                }}
              >
                {zh ? '还原草稿' : 'Discard draft'}
              </button>
              <button
                className="qg-primary-button"
                onClick={() => {
                  try {
                    const patch = parseWidgetCode(code, widget, project);
                    const issues = validatePropertyPatch(widget, patch, project);
                    if (issues.length)
                      throw new Error(
                        issues.map((issue) => issue.path + ': ' + issue.message).join('\n'),
                      );
                    onUpdate(patch);
                    onDraft(undefined);
                    setError('');
                  } catch (cause) {
                    setError(errorText(cause));
                  }
                }}
              >
                {zh ? '应用代码' : 'Apply code'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="qg-property-search">
              <Search size={14} />
              <input
                aria-label={zh ? '搜索属性' : 'Search properties'}
                placeholder={zh ? '搜索属性…' : 'Search properties…'}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {!search && (
              <Section title={zh ? '组件与布局' : 'COMPONENT & LAYOUT'}>
                {!multiple && (
                  <>
                    <Field label={zh ? '名称' : 'Name'}>
                      <DraftText value={widget.name} onChange={(name) => onUpdate({ name })} />
                    </Field>
                    <div className="qg-id-display">
                      ID <code>{widget.id}</code>
                    </div>
                  </>
                )}
                <div className="qg-field-grid">
                  {(['x', 'y', 'width', 'height'] as const).map((key) => (
                    <Field key={key} label={{ x: 'X', y: 'Y', width: 'W', height: 'H' }[key]}>
                      <NumberInput
                        value={widget.layout[key]}
                        min={key === 'width' || key === 'height' ? 1 : undefined}
                        max={key === 'width' || key === 'height' ? 10000 : undefined}
                        mixed={selected.some((item) => item.layout[key] !== widget.layout[key])}
                        commitOnBlur
                        onChange={(value) =>
                          apply((item) => ({ layout: { ...item.layout, [key]: value } }))
                        }
                      />
                    </Field>
                  ))}
                </div>
                {!multiple && (
                  <Field label={zh ? '父级容器' : 'Parent panel'}>
                    <select
                      value={widget.parentId ?? ''}
                      onChange={(event) => onUpdate({ parentId: event.target.value || undefined })}
                    >
                      <option value="">{zh ? '当前窗口' : 'Current window'}</option>
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
                )}
                {selected.every((item) => item.type === 'panel') && (
                  <>
                    <Field label={zh ? '布局方式' : 'Layout'}>
                      <select
                        value={widget.layout.mode ?? 'absolute'}
                        onChange={(event) =>
                          apply((item) => ({
                            layout: {
                              ...item.layout,
                              mode: event.target.value as Widget['layout']['mode'],
                            },
                          }))
                        }
                      >
                        {['absolute', 'flex', 'grid'].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </Field>
                    {widget.layout.mode && widget.layout.mode !== 'absolute' && (
                      <>
                        <Field label={zh ? '间距' : 'Gap'}>
                          <NumberInput
                            value={widget.layout.gap ?? 0}
                            min={0}
                            commitOnBlur
                            onChange={(gap) =>
                              apply((item) => ({ layout: { ...item.layout, gap } }))
                            }
                          />
                        </Field>
                        {widget.layout.mode === 'grid' ? (
                          <Field label={zh ? '列数' : 'Columns'}>
                            <NumberInput
                              value={widget.layout.columns ?? 2}
                              min={1}
                              max={100}
                              integer
                              commitOnBlur
                              onChange={(columns) =>
                                apply((item) => ({ layout: { ...item.layout, columns } }))
                              }
                            />
                          </Field>
                        ) : (
                          <Field label={zh ? '方向' : 'Direction'}>
                            <select
                              value={widget.layout.direction ?? 'row'}
                              onChange={(event) =>
                                apply((item) => ({
                                  layout: {
                                    ...item.layout,
                                    direction: event.target.value as 'row' | 'column',
                                  },
                                }))
                              }
                            >
                              <option value="row">row</option>
                              <option value="column">column</option>
                            </select>
                          </Field>
                        )}
                      </>
                    )}
                  </>
                )}
                {widget.type === 'module' && !multiple && (
                  <>
                    <Field label={zh ? '组件模块' : 'Component module'}>
                      <select
                        value={widget.moduleId ?? ''}
                        onChange={(event) =>
                          onUpdate({ moduleId: event.target.value || undefined })
                        }
                      >
                        <option value="">—</option>
                        {project.modules.map((module) => (
                          <option key={module.id} value={module.id}>
                            {module.name} · {module.version}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {onEditModule && (
                      <button className="qg-secondary-button" onClick={onEditModule}>
                        {module?.implementation
                          ? zh
                            ? '查看模块源码'
                            : 'View module source'
                          : zh
                            ? '编辑模块定义'
                            : 'Edit module definition'}
                      </button>
                    )}
                  </>
                )}
              </Section>
            )}
            {(['content', 'data', 'behavior'] as const).map((group) => {
              const entries = definition.properties.filter(
                (entry) => entry.group === group && commonKeys(entry.key) && visible(entry),
              );
              return entries.length ? (
                <Section
                  key={group}
                  title={
                    {
                      content: zh ? '内容' : 'CONTENT',
                      data: zh ? '数据' : 'DATA',
                      behavior: zh ? '行为' : 'BEHAVIOR',
                    }[group]
                  }
                >
                  {entries.map((entry) => propertyRow(entry))}
                </Section>
              ) : null;
            })}
            <Section title={zh ? '外观与状态' : 'APPEARANCE & STATES'}>
              <Field label={zh ? '编辑状态' : 'Edit state'}>
                <select value={state} onChange={(event) => setState(event.target.value)}>
                  {['default', ...WIDGET_STATES].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              {!multiple && state !== 'default' && (
                <div className="qg-state-preview">
                  <WidgetView
                    widget={{ ...widget, layout: { ...widget.layout, width: 240, height: 90 } }}
                    project={project}
                    previewState={state}
                  />
                </div>
              )}
              {definition.properties
                .filter(
                  (entry) =>
                    entry.group === 'appearance' && commonKeys(entry.key) && visible(entry),
                )
                .map((entry) => propertyRow(entry))}
              {definition.styles
                .filter(
                  (entry) =>
                    visible(entry) &&
                    selected.every(
                      (item) =>
                        item.definitionVersion === 2 &&
                        getWidgetDefinition(item.type).styles.some(
                          (style) => style.key === entry.key,
                        ),
                    ),
                )
                .map((entry) => propertyRow(entry, true))}
            </Section>
            {!multiple && (
              <Section title={zh ? '数据绑定' : 'DATA BINDINGS'}>
                {Object.entries(widget.bindings).map(([key, binding]) => {
                  const property = bindable.find((entry) => entry.key === key),
                    variable = project.variables.find(
                      (item) => item.id === binding.variable || item.name === binding.variable,
                    );
                  const update = (patch: Partial<Binding>) =>
                    apply((item) => ({
                      bindings: { ...item.bindings, [key]: { ...binding, ...patch } },
                    }));
                  return (
                    <div className="qg-binding" key={key}>
                      <div className="qg-binding-label">
                        <code>{key}</code>
                        <button
                          className="qg-icon-button"
                          aria-label={zh ? '删除绑定' : 'Remove binding'}
                          onClick={() =>
                            apply((item) => {
                              const bindings = { ...item.bindings };
                              delete bindings[key];
                              return { bindings };
                            })
                          }
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <select
                        aria-label={zh ? '绑定变量' : 'Binding variable'}
                        value={variable?.id ?? binding.variable}
                        onChange={(event) => {
                          const next = project.variables.find(
                            (item) => item.id === event.target.value,
                          );
                          update({
                            variable: event.target.value,
                            path:
                              next?.type === 'json' && property
                                ? inferBindingPath(next.initial, property)
                                : undefined,
                          });
                        }}
                      >
                        {project.variables
                          .filter(
                            (item) =>
                              compatibleVariable(item, property) &&
                              !(binding.mode === 'twoWay' && item.readOnly),
                          )
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · {item.type}
                            </option>
                          ))}
                      </select>
                      <select
                        aria-label={zh ? '绑定模式' : 'Binding mode'}
                        value={binding.mode}
                        onChange={(event) =>
                          update({ mode: event.target.value as Binding['mode'] })
                        }
                      >
                        {property?.binding?.modes.map((mode) => (
                          <option key={mode}>{mode}</option>
                        ))}
                      </select>
                      {variable?.type === 'json' && (
                        <Field label={zh ? 'JSON 字段路径' : 'JSON field path'}>
                          <JsonEditor
                            label="Binding JSON path"
                            value={binding.path ?? []}
                            onChange={(path) => update({ path: path as Binding['path'] })}
                          />
                        </Field>
                      )}
                      {!property && (
                        <span className="qg-field-error">
                          {zh ? '旧绑定属性当前不支持' : 'Unsupported legacy binding'}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div className="qg-add-binding">
                  <select
                    aria-label={zh ? '绑定属性' : 'Bind property'}
                    value={bindingKey}
                    onChange={(event) => setNewBinding(event.target.value)}
                  >
                    {bindable.map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.label[zh ? 'zh' : 'en']} ({entry.key})
                      </option>
                    ))}
                  </select>
                  <button
                    className="qg-secondary-button"
                    disabled={
                      !bindingKey ||
                      !!widget.bindings[bindingKey] ||
                      !project.variables.some((item) =>
                        compatibleVariable(
                          item,
                          bindable.find((entry) => entry.key === bindingKey),
                        ),
                      )
                    }
                    onClick={() => {
                      const entry = bindable.find((entry) => entry.key === bindingKey)!;
                      const variable = project.variables.find((item) =>
                        compatibleVariable(item, entry),
                      );
                      if (variable)
                        apply((item) => ({
                          bindings: {
                            ...item.bindings,
                            [bindingKey]: {
                              variable: variable.id,
                              mode: 'oneWay',
                              ...(variable.type === 'json'
                                ? { path: inferBindingPath(variable.initial, entry) }
                                : {}),
                            },
                          },
                        }));
                    }}
                  >
                    <Plus size={13} />
                    {zh ? '绑定' : 'Bind'}
                  </button>
                </div>
              </Section>
            )}
            {!multiple && (
              <Section title={zh ? '事件与流程' : 'EVENTS & FLOWS'}>
                {definition.events.map((event) => (
                  <Field
                    key={event.name}
                    label={'on' + event.name[0].toUpperCase() + event.name.slice(1)}
                    hint={event.description + ' · ' + event.payload}
                  >
                    <FlowBindingSelect
                      binding={widget.events[event.name]}
                      flows={project.flows}
                      zh={zh}
                      label={'on' + event.name[0].toUpperCase() + event.name.slice(1)}
                      onChange={(binding) => {
                        const events = { ...widget.events };
                        if (binding) events[event.name] = binding;
                        else delete events[event.name];
                        onUpdate({ events });
                      }}
                    />
                  </Field>
                ))}
                {!definition.events.length && (
                  <span className="qg-field-hint">
                    {zh ? '此控件用于内容展示。' : 'This widget displays content.'}
                  </span>
                )}
              </Section>
            )}
            {!multiple &&
              Object.keys(widget.props).some(
                (key) => !definition.properties.some((entry) => entry.key === key),
              ) && (
                <Section title={zh ? '保留的扩展属性' : 'RETAINED EXTENSIONS'}>
                  <p className="qg-field-hint">
                    {zh
                      ? '扩展数据会原样保留；未声明属性不保证渲染生效。'
                      : 'Extension data is retained. Undeclared properties may not affect rendering.'}
                  </p>
                  <button className="qg-secondary-button" onClick={() => setTab('code')}>
                    CODE
                  </button>
                </Section>
              )}
          </>
        )}
      </div>
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
export default Inspector;
