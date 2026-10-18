import { useState, type ChangeEvent } from 'react';
import { AppWindow, Box, Upload, Image as ImageIcon, Info, X, AlertCircle } from 'lucide-react';
import type { Asset, Locale, Project, PublishConfig, WindowConfig } from '../core/types';
import { Field, NumberInput, Section, Toggle } from './Fields';
import './designer.css';

export interface WindowInspectorProps {
  project: Project;
  onWindowChange: (patch: Partial<WindowConfig>) => void;
  onPublishChange: (patch: Partial<PublishConfig>) => void;
  onAsset: (asset: Asset) => void;
  locale: Locale;
}

export function WindowInspector({
  project,
  onWindowChange,
  onPublishChange,
  onAsset,
  locale,
}: WindowInspectorProps) {
  const [tab, setTab] = useState<'window' | 'publish'>('window');
  const [error, setError] = useState('');
  const zh = locale === 'zh-CN',
    config = project.window,
    publish = project.publish;
  const importIcon = async (
    event: ChangeEvent<HTMLInputElement>,
    target: 'window' | 'app' | 'shortcut',
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError(zh ? '图标文件不能超过 5 MB。' : 'Icon files must be 5 MB or smaller.');
      return;
    }
    if (!/\.(png|svg|ico|jpg|jpeg|webp)$/i.test(file.name)) {
      setError(
        zh
          ? '请选择 PNG、SVG、ICO、JPG 或 WebP 图片。'
          : 'Choose a PNG, SVG, ICO, JPG or WebP image.',
      );
      return;
    }
    try {
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const extension = file.name.split('.').pop()!.toLowerCase();
      const mime = (
        {
          svg: 'image/svg+xml',
          ico: 'image/x-icon',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          png: 'image/png',
        } as Record<string, string>
      )[extension];
      const data = `data:${mime};base64,${source.slice(source.indexOf(',') + 1)}`;
      const asset: Asset = { id: crypto.randomUUID(), name: file.name, mime, data };
      onAsset(asset);
      if (target === 'window') onWindowChange({ icon: asset.id });
      else if (target === 'app') onPublishChange({ icon: asset.id });
      else onPublishChange({ shortcutIcon: asset.id });
      setError('');
    } catch {
      setError(zh ? '无法读取图标文件，请重试。' : 'Could not read the icon. Please try again.');
    }
  };
  const iconField = (label: string, target: 'window' | 'app' | 'shortcut', assetId?: string) => {
    const asset = project.assets.find((item) => item.id === assetId);
    return (
      <div className="qg-icon-field">
        <span className="qg-field-label">{label}</span>
        <div className="qg-icon-import">
          <div className="qg-icon-preview">
            {asset ? <img src={asset.data} alt={asset.name} /> : <ImageIcon size={22} />}
          </div>
          <div className="qg-icon-import-copy">
            <strong title={asset?.name}>{asset?.name ?? (zh ? '默认图标' : 'Default icon')}</strong>
            <label className="qg-upload-label">
              <Upload size={12} />
              {zh ? '导入图标' : 'Import icon'}
              <input
                type="file"
                accept=".png,.svg,.ico,.jpg,.jpeg,.webp"
                onChange={(event) => void importIcon(event, target)}
              />
            </label>
          </div>
          {assetId && (
            <button
              className="qg-icon-button"
              aria-label={zh ? '移除图标' : 'Remove icon'}
              onClick={() =>
                target === 'window'
                  ? onWindowChange({ icon: undefined })
                  : target === 'app'
                    ? onPublishChange({ icon: undefined })
                    : onPublishChange({ shortcutIcon: undefined })
              }
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="qg-window-inspector">
      <div className="qg-inspector-heading">
        <div>
          <span className="qg-widget-type">PROJECT</span>
          <strong>{zh ? '窗口与发布' : 'Window & publish'}</strong>
        </div>
        <AppWindow size={18} />
      </div>
      <div className="qg-segmented">
        <button className={tab === 'window' ? 'active' : ''} onClick={() => setTab('window')}>
          <AppWindow size={14} />
          {zh ? '窗口' : 'Window'}
        </button>
        <button className={tab === 'publish' ? 'active' : ''} onClick={() => setTab('publish')}>
          <Box size={14} />
          {zh ? '发布' : 'Publish'}
        </button>
      </div>
      {error && (
        <div className="qg-error" role="alert">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}
      {tab === 'window' ? (
        <>
          <Section title={zh ? '基本信息' : 'BASIC INFORMATION'}>
            <Field label={zh ? '窗口标题' : 'Window title'}>
              <input
                value={config.title}
                onChange={(event) => onWindowChange({ title: event.target.value })}
              />
            </Field>
            {iconField(zh ? '窗口图标' : 'Window icon', 'window', config.icon)}
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
        </>
      ) : (
        <>
          <Section title={zh ? '应用信息' : 'APPLICATION'}>
            <Field label={zh ? '应用名称' : 'Application name'}>
              <input
                value={publish.appName}
                onChange={(event) => onPublishChange({ appName: event.target.value })}
              />
            </Field>
            <Field label={zh ? '应用标识' : 'Identifier'} hint="com.example.quickgui">
              <input
                value={publish.identifier}
                spellCheck={false}
                onChange={(event) => onPublishChange({ identifier: event.target.value })}
              />
            </Field>
            <Field
              label={zh ? '版本号' : 'Version'}
              hint={zh ? '使用语义化版本，例如 1.0.0' : 'Semantic version, for example 1.0.0'}
            >
              <input
                value={publish.version}
                onChange={(event) => onPublishChange({ version: event.target.value })}
              />
            </Field>
            <Field label={zh ? '发布者' : 'Publisher'}>
              <input
                value={publish.publisher}
                onChange={(event) => onPublishChange({ publisher: event.target.value })}
              />
            </Field>
          </Section>
          <Section title={zh ? '应用图标' : 'APPLICATION ICON'}>
            {iconField(zh ? '应用图标' : 'Application icon', 'app', publish.icon)}
            <p className="qg-field-hint">
              {zh
                ? '建议导入 1024 × 1024 的方形 PNG，图标随原始工程一起导出。'
                : 'A 1024 × 1024 square PNG is recommended. Icons are included in the source project export.'}
            </p>
          </Section>
          <Section title={zh ? '桌面快捷方式' : 'DESKTOP SHORTCUT'}>
            <Toggle
              label={zh ? '创建桌面快捷方式' : 'Create desktop shortcut'}
              value={publish.desktopShortcut}
              onChange={(desktopShortcut) => onPublishChange({ desktopShortcut })}
            />
            {iconField(zh ? '快捷方式图标' : 'Shortcut icon', 'shortcut', publish.shortcutIcon)}
            <p className="qg-field-hint">
              {zh
                ? '快捷方式由目标平台的安装器创建。未指定图标时使用应用图标。'
                : 'Shortcuts are created by the target platform installer. The app icon is used if no shortcut icon is set.'}
            </p>
          </Section>
        </>
      )}
    </div>
  );
}

export default WindowInspector;
