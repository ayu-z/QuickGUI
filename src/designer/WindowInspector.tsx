import { useState } from 'react';
import { AppWindow, Info, Pencil, Trash2 } from 'lucide-react';
import type { Asset, Locale, Project, ProjectWindow, WindowConfig } from '../core/types';
import { Field, NumberInput, Section, Toggle } from './Fields';
import { IconAssetField } from './IconAssetField';
import { WindowPrompt } from '../panels/WindowPrompt';
import './designer.css';

export interface WindowInspectorProps {
  project: Project;
  currentWindow: ProjectWindow;
  onWindowChange: (patch: Partial<WindowConfig>) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onStartup: (id: string, open: boolean) => void;
  onIconImport: (asset: Asset) => void;
  locale: Locale;
}

export function WindowInspector({
  project,
  currentWindow,
  onWindowChange,
  onRename,
  onDelete,
  onStartup,
  onIconImport,
  locale,
}: WindowInspectorProps) {
  const [action, setAction] = useState<'rename' | 'delete' | null>(null);
  const zh = locale === 'zh-CN',
    config = currentWindow.config;
  return (
    <div className="qg-window-inspector">
      <div className="qg-inspector-heading">
        <div>
          <span className="qg-widget-type">{zh ? '当前窗口' : 'CURRENT WINDOW'}</span>
          <strong>{zh ? '窗口属性' : 'Window properties'}</strong>
        </div>
        <AppWindow size={18} />
      </div>
      <Section title={zh ? '窗口管理' : 'WINDOW MANAGEMENT'}>
        <div className="qg-window-management">
          <span title={currentWindow.name}>{currentWindow.name}</span>
          {currentWindow.id !== 'main' ? (
            <>
              <button
                className="qg-icon-button"
                aria-label={`${zh ? '重命名窗口' : 'Rename window'} ${currentWindow.name}`}
                title={zh ? '重命名当前窗口' : 'Rename current window'}
                onClick={() => setAction('rename')}
              >
                <Pencil size={14} />
              </button>
              <button
                className="qg-icon-button danger"
                aria-label={`${zh ? '删除窗口' : 'Delete window'} ${currentWindow.name}`}
                title={zh ? '删除当前窗口' : 'Delete current window'}
                onClick={() => setAction('delete')}
              >
                <Trash2 size={14} />
              </button>
            </>
          ) : (
            <small>{zh ? '主窗口' : 'Main window'}</small>
          )}
        </div>
      </Section>
      <Section title={zh ? '基本信息' : 'BASIC INFORMATION'}>
        <Field label={zh ? '窗口标题' : 'Window title'}>
          <input
            value={config.title}
            onChange={(event) => onWindowChange({ title: event.target.value })}
          />
        </Field>
        <IconAssetField
          label={zh ? '窗口图标' : 'Window icon'}
          assets={project.assets}
          assetId={config.icon}
          locale={locale}
          onImport={onIconImport}
          onChange={(icon) => onWindowChange({ icon })}
        />
      </Section>
      <Section title={zh ? '尺寸' : 'DIMENSIONS'}>
        <div className="qg-field-grid">
          <Field label={zh ? '宽度' : 'Width'}>
            <NumberInput
              value={config.width}
              min={Math.max(200, config.minWidth)}
              max={7680}
              onChange={(width) => onWindowChange({ width })}
            />
          </Field>
          <Field label={zh ? '高度' : 'Height'}>
            <NumberInput
              value={config.height}
              min={Math.max(100, config.minHeight)}
              max={4320}
              onChange={(height) => onWindowChange({ height })}
            />
          </Field>
          <Field label={zh ? '最小宽度' : 'Min width'}>
            <NumberInput
              value={config.minWidth}
              min={0}
              max={config.width}
              onChange={(minWidth) => onWindowChange({ minWidth })}
            />
          </Field>
          <Field label={zh ? '最小高度' : 'Min height'}>
            <NumberInput
              value={config.minHeight}
              min={0}
              max={config.height}
              onChange={(minHeight) => onWindowChange({ minHeight })}
            />
          </Field>
        </div>
        <Toggle
          label={zh ? '允许调整大小' : 'Resizable'}
          value={config.resizable}
          onChange={(resizable) => onWindowChange({ resizable })}
        />
      </Section>
      <Section title={zh ? '启动与行为' : 'LAUNCH & BEHAVIOR'}>
        {currentWindow.id !== 'main' && (
          <Toggle
            label={zh ? '启动时打开此窗口' : 'Open this window on startup'}
            value={currentWindow.openOnStart}
            onChange={(open) => onStartup(currentWindow.id, open)}
          />
        )}
        <Toggle
          label={zh ? '屏幕居中' : 'Center on screen'}
          value={config.center}
          onChange={(center) => onWindowChange({ center })}
        />
        <Toggle
          label={zh ? '记忆窗口位置' : 'Remember position'}
          value={config.rememberPosition}
          onChange={(rememberPosition) => onWindowChange({ rememberPosition })}
        />
        <Toggle
          label={zh ? '始终置顶' : 'Always on top'}
          value={config.alwaysOnTop}
          onChange={(alwaysOnTop) => onWindowChange({ alwaysOnTop })}
        />
        <Toggle
          label={zh ? '全屏启动' : 'Launch fullscreen'}
          value={config.fullscreen}
          onChange={(fullscreen) =>
            onWindowChange({ fullscreen, ...(fullscreen ? { maximized: false } : {}) })
          }
        />
        <Toggle
          label={zh ? '最大化启动' : 'Launch maximized'}
          value={config.maximized}
          onChange={(maximized) =>
            onWindowChange({ maximized, ...(maximized ? { fullscreen: false } : {}) })
          }
        />
      </Section>
      <Section title={zh ? '外观' : 'APPEARANCE'}>
        <Field label={zh ? '窗口背景' : 'Background'}>
          <div className="qg-color-field">
            <input
              type="color"
              aria-label={zh ? '窗口背景色' : 'Window background color'}
              value={/^#[\da-f]{6}$/i.test(config.background) ? config.background : '#111827'}
              onChange={(event) => onWindowChange({ background: event.target.value })}
            />
            <input
              value={config.background}
              onChange={(event) => onWindowChange({ background: event.target.value })}
            />
          </div>
        </Field>
        <Field label={zh ? '内容圆角' : 'Content radius'}>
          <NumberInput
            value={config.contentRadius}
            min={0}
            max={64}
            onChange={(contentRadius) => onWindowChange({ contentRadius })}
          />
        </Field>
        <Field label={zh ? '原生窗口圆角偏好' : 'Native corner preference'}>
          <select
            value={config.cornerPreference}
            onChange={(event) =>
              onWindowChange({
                cornerPreference: event.target.value as WindowConfig['cornerPreference'],
              })
            }
          >
            <option value="system">{zh ? '跟随系统' : 'System default'}</option>
            <option value="square">{zh ? '直角' : 'Square'}</option>
            <option value="round">{zh ? '圆角' : 'Rounded'}</option>
            <option value="small">{zh ? '小圆角' : 'Small rounded'}</option>
          </select>
        </Field>
        <div className="qg-info-note">
          <Info size={14} />
          <span>
            {zh
              ? '内容圆角作用于应用内部。原生窗口边框由操作系统控制；圆角偏好仅在支持的平台生效，不支持时保持系统外观。'
              : 'Content radius affects the app surface. Native window borders are controlled by the OS; corner preferences apply only where supported, otherwise the system appearance is used.'}
          </span>
        </div>
      </Section>
      {action && currentWindow.id !== 'main' && (
        <WindowPrompt
          mode={action}
          initialName={currentWindow.name}
          widgetCount={currentWindow.widgets.length}
          locale={locale}
          onCancel={() => setAction(null)}
          onConfirm={(name) => {
            if (action === 'rename') onRename(currentWindow.id, name);
            else onDelete(currentWindow.id);
            setAction(null);
          }}
        />
      )}
    </div>
  );
}

export default WindowInspector;
