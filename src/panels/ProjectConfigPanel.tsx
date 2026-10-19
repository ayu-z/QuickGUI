import { useEffect, useId, useRef, useState } from 'react';
import {
  Box,
  FileBadge,
  FilePenLine,
  FilePlus2,
  FolderOpen,
  Image,
  Monitor,
  Save,
  Settings2,
  X,
} from 'lucide-react';
import type { Project, PublishConfig } from '../core/types';
import { IconAssetField } from '../designer/IconAssetField';
import { Toggle } from '../designer/Fields';
import { ResourceHeading } from './ResourceHeading';
import './projectConfig.css';

function PublishTextField({
  label,
  value,
  hint,
  validate,
  onCommit,
  spellCheck,
}: {
  label: string;
  value: string;
  hint?: string;
  validate?: (value: string) => string | undefined;
  onCommit: (value: string) => void;
  spellCheck?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const initial = useRef(value);
  const cancelled = useRef(false);
  const inputId = useId();
  const messageId = `${inputId}-message`;
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  return (
    <div className="qg-field project-config-field">
      <label className="qg-field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        value={draft}
        spellCheck={spellCheck}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? messageId : undefined}
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
            setError('');
            return;
          }
          const invalid = validate?.(draft);
          if (invalid) {
            setError(invalid);
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
            setEditing(false);
            setError('');
            event.currentTarget.blur();
          }
        }}
      />
      {error ? (
        <span className="form-error" role="alert" id={messageId}>
          {error}
        </span>
      ) : (
        hint && (
          <span className="qg-field-hint" id={messageId}>
            {hint}
          </span>
        )
      )}
    </div>
  );
}

export interface ProjectManagement {
  onCreate: () => void;
  onOpen: () => void | Promise<void>;
  onRename: () => void;
  onSave: () => void | Promise<void>;
  onClose: () => void;
}

export function ProjectConfigPanel({
  project,
  onChange,
  management,
}: {
  project: Project;
  onChange: (mutate: (project: Project) => void) => void;
  management: ProjectManagement;
}) {
  const zh = project.locale === 'zh-CN';
  const publish = project.publish;
  const update = (patch: Partial<PublishConfig>) =>
    onChange((next) => Object.assign(next.publish, patch));
  const iconField = (field: 'icon' | 'shortcutIcon', label: string) => (
    <IconAssetField
      label={label}
      assets={project.assets}
      assetId={publish[field]}
      locale={project.locale}
      onImport={(asset) =>
        onChange((next) => {
          next.assets.push(asset);
          next.publish[field] = asset.id;
        })
      }
      onChange={(id) => update({ [field]: id })}
    />
  );
  return (
    <section
      key={project.id}
      className="project-config-panel project-settings-page"
      aria-label={zh ? '项目配置' : 'Project settings'}
    >
      <ResourceHeading
        icon={<Settings2 size={16} aria-hidden="true" />}
        title={zh ? '项目配置' : 'Project settings'}
        summary={zh ? '应用信息、图标与桌面快捷方式' : 'Application, icons & desktop shortcut'}
      />
      <div
        className="project-config-scroll"
        tabIndex={0}
        aria-label={zh ? '项目配置滚动区域' : 'Project settings scroll area'}
      >
        <div className="project-config-grid">
          <section
            className="project-config-card project-config-project"
            aria-label={zh ? '工程管理' : 'Project management'}
          >
            <h3>
              <FolderOpen size={16} aria-hidden="true" />
              {zh ? '工程信息' : 'Project'}
            </h3>
            <dl className="project-config-identity">
              <div>
                <dt>{zh ? '工程名称' : 'Project name'}</dt>
                <dd>
                  <strong data-testid="project-name" title={project.name}>
                    {project.name}
                  </strong>
                </dd>
              </div>
              <div>
                <dt>{zh ? '工程 ID' : 'Project ID'}</dt>
                <dd>
                  <code data-testid="project-id" title={project.id}>
                    {project.id}
                  </code>
                </dd>
              </div>
            </dl>
            <div className="project-config-management-actions">
              <button
                className="button"
                aria-label={zh ? '新建工程' : 'New project'}
                onClick={management.onCreate}
              >
                <FilePlus2 size={14} aria-hidden="true" />
                {zh ? '新建工程' : 'New project'}
              </button>
              <button
                className="button"
                aria-label={zh ? '打开工程' : 'Open project'}
                onClick={() => void management.onOpen()}
              >
                <FolderOpen size={14} aria-hidden="true" />
                {zh ? '打开工程' : 'Open project'}
              </button>
              <button
                className="button"
                aria-label={zh ? '重命名工程' : 'Rename project'}
                onClick={management.onRename}
              >
                <FilePenLine size={14} aria-hidden="true" />
                {zh ? '重命名工程' : 'Rename project'}
              </button>
              <button
                className="button primary"
                aria-label={zh ? '保存工程' : 'Save project'}
                onClick={() => void management.onSave()}
              >
                <Save size={14} aria-hidden="true" />
                {zh ? '保存工程' : 'Save project'}
              </button>
              <button
                className="button project-config-close"
                aria-label={zh ? '关闭工程' : 'Close project'}
                onClick={management.onClose}
              >
                <X size={14} aria-hidden="true" />
                {zh ? '关闭工程' : 'Close project'}
              </button>
            </div>
          </section>
          <section
            className="project-config-card project-config-application"
            aria-label={zh ? '应用信息' : 'Application information'}
          >
            <h3>
              <FileBadge size={16} aria-hidden="true" />
              {zh ? '应用信息' : 'Application'}
            </h3>
            <div className="project-config-fields">
              <PublishTextField
                label={zh ? '应用名称' : 'Application name'}
                value={publish.appName}
                validate={(value) =>
                  !value.trim() || value.length > 100
                    ? zh
                      ? '请输入 1–100 个字符的应用名称。'
                      : 'Enter an application name of 1–100 characters.'
                    : undefined
                }
                onCommit={(appName) => update({ appName })}
              />
              <PublishTextField
                label={zh ? '应用标识' : 'Identifier'}
                value={publish.identifier}
                hint="com.example.quickgui"
                spellCheck={false}
                validate={(value) =>
                  !/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+$/.test(value)
                    ? zh
                      ? '请输入有效的应用标识，例如 com.example.quickgui。'
                      : 'Enter a valid identifier, for example com.example.quickgui.'
                    : undefined
                }
                onCommit={(identifier) => update({ identifier })}
              />
              <PublishTextField
                label={zh ? '版本号' : 'Version'}
                value={publish.version}
                hint={zh ? '使用语义化版本，例如 1.0.0' : 'Semantic version, for example 1.0.0'}
                spellCheck={false}
                validate={(value) =>
                  !/^\d+\.\d+\.\d+([+-][\w.-]+)?$/.test(value)
                    ? zh
                      ? '请输入有效的版本号，例如 1.0.0。'
                      : 'Enter a valid version, for example 1.0.0.'
                    : undefined
                }
                onCommit={(version) => update({ version })}
              />
              <PublishTextField
                label={zh ? '发布者' : 'Publisher'}
                value={publish.publisher}
                onCommit={(publisher) => update({ publisher })}
              />
            </div>
          </section>
          <section
            className="project-config-card"
            aria-label={zh ? '应用图标设置' : 'Application icon settings'}
          >
            <h3>
              <Image size={16} aria-hidden="true" />
              {zh ? '应用图标' : 'Application icon'}
            </h3>
            {iconField('icon', zh ? '应用图标' : 'Application icon')}
            <p className="project-config-note">
              {zh
                ? '建议导入 1024 × 1024 的方形 PNG，图标随原始工程一起导出。'
                : 'A 1024 × 1024 square PNG is recommended. Icons are included in the source project export.'}
            </p>
          </section>
          <section
            className="project-config-card"
            aria-label={zh ? '桌面快捷方式设置' : 'Desktop shortcut settings'}
          >
            <h3>
              <Monitor size={16} aria-hidden="true" />
              {zh ? '桌面快捷方式' : 'Desktop shortcut'}
            </h3>
            <Toggle
              label={zh ? '创建桌面快捷方式' : 'Create desktop shortcut'}
              value={publish.desktopShortcut}
              onChange={(desktopShortcut) => update({ desktopShortcut })}
            />
            {iconField('shortcutIcon', zh ? '快捷方式图标' : 'Shortcut icon')}
            <p className="project-config-note">
              {zh
                ? '快捷方式由目标平台的安装器创建。未指定图标时使用应用图标。'
                : 'Shortcuts are created by the target platform installer. The app icon is used if no shortcut icon is set.'}
            </p>
          </section>
        </div>
        <p className="project-config-footer">
          <Box size={14} aria-hidden="true" />
          {zh
            ? '这些设置随工程保存，供原始工程导出和独立应用构建使用。'
            : 'These settings are saved with the project for source export and standalone application builds.'}
        </p>
      </div>
    </section>
  );
}
