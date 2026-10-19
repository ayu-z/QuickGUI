import { useState } from 'react';
import {
  Code2,
  Copy,
  Download,
  FolderOpen,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Trash2,
} from 'lucide-react';
import type { Project } from '../core/types';
import { moduleReferences } from '../core/modules';
import './modules.css';

export function ModulesPanel({
  project,
  activeModuleId,
  selectionCount = 0,
  onCreate,
  onInsert,
  onEdit,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
  onImport,
}: {
  project: Project;
  activeModuleId?: string | null;
  selectionCount?: number;
  onCreate: (name: string) => void;
  onInsert: (id: string) => void;
  onEdit: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onImport: () => void;
}) {
  const zh = project.locale === 'zh-CN';
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [error, setError] = useState('');
  const run = (action: () => void): boolean => {
    try {
      action();
      setError('');
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const modules = project.modules.filter((module) =>
    `${module.name} ${module.id}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <section className="modules-panel" aria-label={zh ? '模块管理' : 'Module management'}>
      <form
        className="modules-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (run(() => onCreate(name))) setName('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
        }}
      >
        <label>
          {zh ? '模块名称' : 'Module name'}
          <input
            aria-label={zh ? '模块名称' : 'Module name'}
            value={name}
            placeholder={zh ? '输入新模块名称' : 'New module name'}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button className="button full" type="submit" disabled={!name.trim()}>
          <Plus size={14} />
          {zh ? '创建模块' : 'Create module'}
        </button>
        <p>
          {selectionCount
            ? zh
              ? `复制所选 ${selectionCount} 个控件及其完整子树，原控件保留。`
              : `Copy ${selectionCount} selected widgets and their subtrees; keep the originals.`
            : zh
              ? '未选择控件时创建空白模块。'
              : 'Create a blank module when nothing is selected.'}
        </p>
      </form>
      <div className="modules-toolbar">
        <label className="modules-search">
          <Search size={13} aria-hidden="true" />
          <input
            aria-label={zh ? '搜索模块' : 'Search modules'}
            placeholder={zh ? '搜索模块…' : 'Search modules…'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button className="button full" onClick={() => run(onImport)}>
          <FolderOpen size={14} />
          {zh ? '导入组件包' : 'Import component package'}
        </button>
      </div>
      {error && (
        <p className="modules-error" role="alert">
          {error}
        </p>
      )}
      <div className="modules-scroll">
        {!modules.length && (
          <p className="modules-empty">
            {project.modules.length
              ? zh
                ? '没有匹配的模块。'
                : 'No matching modules.'
              : zh
                ? '创建或导入模块开始复用控件。'
                : 'Create or import a module to reuse widgets.'}
          </p>
        )}
        {modules.map((module) => {
          const references = moduleReferences(project, module.id);
          const source = Boolean(module.implementation);
          return (
            <article
              className={`module-card modules-card ${module.id === activeModuleId ? 'active' : ''}`}
              data-module-id={module.id}
              key={module.id}
            >
              <div className="modules-card-title">
                {source ? (
                  <Code2 size={17} aria-hidden="true" />
                ) : (
                  <Puzzle size={17} aria-hidden="true" />
                )}
                <strong title={module.name}>{module.name}</strong>
              </div>
              <small>
                v{module.version} · {module.width} × {module.height} ·{' '}
                {source
                  ? zh
                    ? '源码组件'
                    : 'Source component'
                  : zh
                    ? '布局模块'
                    : 'Layout module'}
              </small>
              <small title={references.join('\n')}>
                {references.length} {zh ? '个实例引用' : 'instance references'} ·{' '}
                {module.widgets.length} {zh ? '个控件' : 'widgets'}
              </small>
              <div className="modules-card-primary">
                <button className="button" onClick={() => run(() => onInsert(module.id))}>
                  <Plus size={12} />
                  {zh ? '添加实例' : 'Add instance'}
                </button>
                <button className="button" onClick={() => run(() => onEdit(module.id))}>
                  {source ? <Code2 size={12} /> : <Pencil size={12} />}
                  {source ? (zh ? '查看源码' : 'View source') : zh ? '编辑定义' : 'Edit definition'}
                </button>
              </div>
              <div className="modules-card-tools">
                <button
                  className="icon-button"
                  aria-label={`${zh ? '重命名模块' : 'Rename module'} ${module.name}`}
                  title={zh ? '重命名' : 'Rename'}
                  onClick={() => {
                    setRenaming(module.id);
                    setRenameDraft(module.name);
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`${zh ? '复制模块' : 'Duplicate module'} ${module.name}`}
                  title={zh ? '复制定义' : 'Duplicate definition'}
                  onClick={() => run(() => onDuplicate(module.id))}
                >
                  <Copy size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`${zh ? '导出模块' : 'Export module'} ${module.name}`}
                  title={
                    source
                      ? zh
                        ? '导出源码包'
                        : 'Export source package'
                      : zh
                        ? '导出模块工程'
                        : 'Export module project'
                  }
                  onClick={() => run(() => onExport(module.id))}
                >
                  <Download size={13} />
                </button>
                <button
                  className="icon-button"
                  disabled={references.length > 0}
                  aria-label={`${zh ? '删除模块' : 'Delete module'} ${module.name}`}
                  title={
                    references.length
                      ? zh
                        ? '请先移除所有实例引用'
                        : 'Remove all instance references first'
                      : zh
                        ? '删除定义'
                        : 'Delete definition'
                  }
                  onClick={() => run(() => onDelete(module.id))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {renaming === module.id && (
                <form
                  className="modules-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (run(() => onRename(module.id, renameDraft))) setRenaming(null);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Escape') setRenaming(null);
                    if (event.key === 'Enter' && event.nativeEvent.isComposing)
                      event.preventDefault();
                  }}
                >
                  <input
                    autoFocus
                    aria-label={zh ? '新模块名称' : 'New module name'}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                  />
                  <button type="submit" className="button">
                    {zh ? '保存' : 'Save'}
                  </button>
                  <button className="button" type="button" onClick={() => setRenaming(null)}>
                    {zh ? '取消' : 'Cancel'}
                  </button>
                </form>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
