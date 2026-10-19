import { useEffect, useRef, useState } from 'react';
import { Code2, Download, Plus, Puzzle, Trash2 } from 'lucide-react';
import type { ComponentModule, Project } from '../core/types';
import {
  moduleReferences,
  updateModuleDefinition,
  type ModuleDefinitionPatch,
} from '../core/modules';
import { getWidgetDefinition } from '../core/widgetDefinitions';
import { JsonValueField } from '../panels/JsonValueField';
import '../panels/modules.css';

interface ModuleInspectorProps {
  project: Project;
  moduleId: string;
  onChange: (change: (project: Project) => void) => void;
  onExport: (id: string) => void;
}

function DefinitionInput({
  label,
  value,
  disabled = false,
  numeric = false,
  onCommit,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  numeric?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const initial = useRef(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  return (
    <label className="qg-module-field">
      <span>{label}</span>
      <input
        aria-label={label}
        disabled={disabled}
        value={draft}
        type={numeric ? 'number' : 'text'}
        step={numeric ? 'any' : undefined}
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
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
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
    </label>
  );
}

export function ModuleInspector(props: ModuleInspectorProps) {
  const module = props.project.modules.find((item) => item.id === props.moduleId);
  return module ? <DefinitionForm key={module.id} {...props} module={module} /> : null;
}

function DefinitionForm({
  project,
  module,
  onChange,
  onExport,
}: ModuleInspectorProps & { module: ComponentModule }) {
  const zh = project.locale === 'zh-CN';
  const source = Boolean(module.implementation);
  const references = moduleReferences(project, module.id);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState('');
  const [targetId, setTargetId] = useState(module.widgets[0]?.id ?? '');
  const [propertyKey, setPropertyKey] = useState('');
  const propertiesFor = (widgetId: string) => {
    const widget = module.widgets.find((item) => item.id === widgetId);
    return widget
      ? getWidgetDefinition(
          widget.type,
          widget.definitionVersion ?? 1,
          project.modules.find((item) => item.id === widget.moduleId),
        ).properties
      : [];
  };
  const target = module.widgets.find((item) => item.id === targetId) ?? module.widgets[0];
  const properties = propertiesFor(target?.id ?? '');
  const property = properties.find((item) => item.key === propertyKey) ?? properties[0];
  const commit = (patch: ModuleDefinitionPatch) => {
    try {
      onChange((next) => updateModuleDefinition(next, module.id, patch));
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const attempt = (action: () => void) => {
    try {
      action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const exposed = (key: string, patch: Partial<ComponentModule['exposedProps'][string]>) =>
    commit({
      exposedProps: { ...module.exposedProps, [key]: { ...module.exposedProps[key], ...patch } },
    });
  const size = (key: 'width' | 'height', raw: string) => {
    if (!raw.trim()) throw new Error(zh ? '请输入有效尺寸' : 'Enter a valid size');
    commit({ [key]: Number(raw) });
  };
  return (
    <section
      className="qg-module-inspector"
      aria-label={zh ? '模块定义属性' : 'Module definition properties'}
    >
      <header className="qg-module-inspector-heading">
        <div>
          <small>{source ? 'SOURCE COMPONENT' : 'MODULE DEFINITION'}</small>
          <strong>{zh ? '模块定义' : 'Module definition'}</strong>
        </div>
        {source ? <Code2 size={18} /> : <Puzzle size={18} />}
      </header>
      <p className="qg-module-info">
        {zh
          ? '修改定义会影响所有实例；实例属性覆盖单独保存。'
          : 'Definition changes affect all instances; instance overrides remain independent.'}
        <br />
        {references.length} {zh ? '个实例引用' : 'instance references'}
      </p>
      <div className="qg-module-definition-fields">
        <DefinitionInput
          label={zh ? '模块名称' : 'Module name'}
          value={module.name}
          onCommit={(name) => commit({ name })}
        />
        <DefinitionInput
          label={zh ? '模块版本' : 'Module version'}
          value={module.version}
          disabled={source}
          onCommit={(version) => commit({ version })}
        />
        <div className="qg-module-field-pair">
          <DefinitionInput
            label={zh ? '模块宽度' : 'Module width'}
            value={String(module.width)}
            disabled={source}
            numeric
            onCommit={(raw) => size('width', raw)}
          />
          <DefinitionInput
            label={zh ? '模块高度' : 'Module height'}
            value={String(module.height)}
            disabled={source}
            numeric
            onCommit={(raw) => size('height', raw)}
          />
        </div>
        <output className="qg-module-id" title={module.id}>
          ID: {module.id}
        </output>
      </div>
      {error && (
        <p className="qg-module-error" role="alert">
          {error}
        </p>
      )}
      {source ? (
        <div className="qg-module-source">
          <p className="qg-module-info">
            {zh
              ? '源码为只读。导出源码包，在外部编辑 TSX/CSS 或 manifest.json，再用组件构建工具重建并重新导入。版本、画布尺寸和公开属性由源码清单定义。'
              : 'Sources are read-only. Export the source package, edit TSX/CSS or manifest.json externally, then rebuild and import the component. Its manifest defines version, size and public properties.'}
          </p>
          {Object.entries(module.implementation!.files)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, content]) => (
              <details key={path}>
                <summary title={path}>{path}</summary>
                <textarea
                  aria-label={`source ${path}`}
                  readOnly
                  spellCheck={false}
                  value={content}
                  rows={8}
                />
              </details>
            ))}
        </div>
      ) : (
        <section className="qg-module-exposed" aria-label={zh ? '暴露属性' : 'Exposed properties'}>
          <h3>{zh ? '暴露属性' : 'Exposed properties'}</h3>
          {references.length > 0 && (
            <p className="qg-module-info">
              {zh
                ? '已有实例引用。先移除实例才能增删属性名；现有属性默认值可继续编辑。'
                : 'Instances reference this definition. Remove them before adding or removing property names; existing defaults remain editable.'}
            </p>
          )}
          {Object.entries(module.exposedProps).map(([key, value]) => (
            <div className="qg-module-exposed-row" key={key}>
              <DefinitionInput
                label={zh ? `属性名 ${key}` : `Property name ${key}`}
                value={key}
                disabled={references.length > 0}
                onCommit={(name) => {
                  if (name !== key && Object.hasOwn(module.exposedProps, name))
                    throw new Error(zh ? '属性名已存在' : 'Property name already exists');
                  const next = { ...module.exposedProps };
                  delete next[key];
                  next[name] = value;
                  commit({ exposedProps: next });
                }}
              />
              <label className="qg-module-field">
                <span>{zh ? '目标控件' : 'Target widget'}</span>
                <select
                  aria-label={`${zh ? '目标控件' : 'Target widget'} ${key}`}
                  value={value.widgetId}
                  onChange={(event) =>
                    attempt(() => {
                      const widget = module.widgets.find((item) => item.id === event.target.value)!;
                      const nextProperty = propertiesFor(widget.id)[0];
                      if (nextProperty)
                        exposed(key, {
                          widgetId: widget.id,
                          property: nextProperty.key,
                          default: widget.props[nextProperty.key] ?? nextProperty.initialValue,
                        });
                    })
                  }
                >
                  {module.widgets.map((widget) => (
                    <option value={widget.id} key={widget.id}>
                      {widget.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="qg-module-field">
                <span>{zh ? '目标属性' : 'Target property'}</span>
                <select
                  aria-label={`${zh ? '目标属性' : 'Target property'} ${key}`}
                  value={value.property}
                  onChange={(event) =>
                    attempt(() => {
                      const widget = module.widgets.find((item) => item.id === value.widgetId)!;
                      const nextProperty = propertiesFor(widget.id).find(
                        (item) => item.key === event.target.value,
                      )!;
                      exposed(key, {
                        property: nextProperty.key,
                        default: widget.props[nextProperty.key] ?? nextProperty.initialValue,
                      });
                    })
                  }
                >
                  {propertiesFor(value.widgetId).map((property) => (
                    <option value={property.key} key={property.key}>
                      {property.key}
                    </option>
                  ))}
                </select>
              </label>
              <div className="qg-module-field">
                <span>{zh ? '默认值（JSON）' : 'Default value (JSON)'}</span>
                <JsonValueField
                  label={`default ${key}`}
                  value={value.default}
                  onCommit={(next) => exposed(key, { default: next })}
                />
              </div>
              <button
                className="button"
                disabled={references.length > 0}
                aria-label={`${zh ? '删除暴露属性' : 'Delete exposed property'} ${key}`}
                onClick={() =>
                  attempt(() => {
                    const next = { ...module.exposedProps };
                    delete next[key];
                    commit({ exposedProps: next });
                  })
                }
              >
                <Trash2 size={12} />
                {zh ? '删除属性' : 'Delete property'}
              </button>
            </div>
          ))}
          <form
            className="qg-module-exposed-create"
            onSubmit={(event) => {
              event.preventDefault();
              attempt(() => {
                if (!target || !property)
                  throw new Error(zh ? '请先添加一个控件' : 'Add a widget first');
                if (Object.hasOwn(module.exposedProps, newKey))
                  throw new Error(zh ? '属性名已存在' : 'Property name already exists');
                commit({
                  exposedProps: {
                    ...module.exposedProps,
                    [newKey]: {
                      widgetId: target.id,
                      property: property.key,
                      default: target.props[property.key] ?? property.initialValue,
                    },
                  },
                });
                setNewKey('');
              });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
            }}
          >
            <label className="qg-module-field">
              <span>{zh ? '新暴露属性名' : 'New exposed property name'}</span>
              <input
                aria-label={zh ? '新暴露属性名' : 'New exposed property name'}
                value={newKey}
                disabled={references.length > 0}
                placeholder="value"
                onChange={(event) => setNewKey(event.target.value)}
              />
            </label>
            <label className="qg-module-field">
              <span>{zh ? '目标控件' : 'Target widget'}</span>
              <select
                aria-label={zh ? '新属性目标控件' : 'New property target widget'}
                value={target?.id ?? ''}
                disabled={references.length > 0 || !target}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  setPropertyKey('');
                }}
              >
                {!target && <option value="">—</option>}
                {module.widgets.map((widget) => (
                  <option value={widget.id} key={widget.id}>
                    {widget.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="qg-module-field">
              <span>{zh ? '目标属性' : 'Target property'}</span>
              <select
                aria-label={zh ? '新属性目标属性' : 'New property target property'}
                value={property?.key ?? ''}
                disabled={references.length > 0 || !property}
                onChange={(event) => setPropertyKey(event.target.value)}
              >
                {!property && <option value="">—</option>}
                {properties.map((property) => (
                  <option value={property.key} key={property.key}>
                    {property.key}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button"
              type="submit"
              disabled={references.length > 0 || !newKey.trim() || !property}
            >
              <Plus size={12} />
              {zh ? '添加暴露属性' : 'Add exposed property'}
            </button>
          </form>
        </section>
      )}
      <footer className="qg-module-inspector-footer">
        <button className="button" onClick={() => attempt(() => onExport(module.id))}>
          <Download size={13} />
          {source
            ? zh
              ? '导出源码包'
              : 'Export source package'
            : zh
              ? '导出模块工程'
              : 'Export module project'}
        </button>
      </footer>
    </section>
  );
}
