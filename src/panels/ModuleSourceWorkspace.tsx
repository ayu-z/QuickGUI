import { useState } from 'react';
import { Code2 } from 'lucide-react';
import type { ComponentModule, Locale } from '../core/types';
import './moduleSource.css';

export function ModuleSourceWorkspace({
  module,
  locale,
  onExit,
}: {
  module: ComponentModule;
  locale: Locale;
  onExit: () => void;
}) {
  const files = Object.keys(module.implementation?.files ?? {});
  const [selected, setSelected] = useState(files[0] ?? '');
  const file = files.includes(selected) ? selected : files[0];
  const zh = locale === 'zh-CN';
  return (
    <section className="module-source-workspace" aria-label={zh ? '模块源码' : 'Module source'}>
      <header className="canvas-heading">
        <strong>
          <Code2 size={15} />
          {module.name}
        </strong>
        <button className="module-exit" onClick={onExit}>
          {zh ? '退出模块定义' : 'Exit module'}
        </button>
      </header>
      <div className="module-source-toolbar">
        <select
          aria-label={zh ? '源码文件' : 'Source file'}
          value={file ?? ''}
          onChange={(event) => setSelected(event.target.value)}
        >
          {files.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
        <span>
          {zh
            ? '只读 · 导出组件包，在源码工程中修改并构建后重新导入。'
            : 'Read only · Export, edit and rebuild the source package, then import it again.'}
        </span>
      </div>
      <textarea
        aria-label={zh ? '模块源码内容' : 'Module source content'}
        readOnly
        spellCheck={false}
        value={module.implementation?.files[file] ?? ''}
      />
    </section>
  );
}
