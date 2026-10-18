import { useState } from 'react';
import {
  Search,
  Square,
  Type,
  MousePointer2,
  TextCursorInput,
  Hash,
  ToggleLeft,
  SlidersHorizontal,
  Gauge,
  BarChart3,
  Image,
  ListFilter,
  Table2,
  Puzzle,
  PanelTop,
  Grip,
} from 'lucide-react';
import type { Locale, WidgetType } from '../core/types';
import './designer.css';

export const WIDGET_CATALOG = [
  { type: 'panel', icon: PanelTop, zh: '容器面板', en: 'Panel', group: 'layout' },
  { type: 'text', icon: Type, zh: '文本标签', en: 'Text', group: 'basic' },
  { type: 'button', icon: MousePointer2, zh: '操作按钮', en: 'Button', group: 'basic' },
  { type: 'input', icon: TextCursorInput, zh: '文本输入', en: 'Input', group: 'basic' },
  { type: 'number', icon: Hash, zh: '数值输入', en: 'Number', group: 'basic' },
  { type: 'switch', icon: ToggleLeft, zh: '开关', en: 'Switch', group: 'basic' },
  { type: 'slider', icon: SlidersHorizontal, zh: '滑块', en: 'Slider', group: 'basic' },
  { type: 'select', icon: ListFilter, zh: '下拉选择', en: 'Select', group: 'basic' },
  { type: 'progress', icon: Square, zh: '进度条', en: 'Progress', group: 'data' },
  { type: 'gauge', icon: Gauge, zh: '仪表盘', en: 'Gauge', group: 'data' },
  { type: 'chart', icon: BarChart3, zh: '趋势图', en: 'Chart', group: 'data' },
  { type: 'table', icon: Table2, zh: '数据表格', en: 'Table', group: 'data' },
  { type: 'image', icon: Image, zh: '图片', en: 'Image', group: 'layout' },
  { type: 'module', icon: Puzzle, zh: '模块组件', en: 'Module', group: 'layout' },
] satisfies { type: WidgetType; icon: typeof Type; zh: string; en: string; group: string }[];

export interface LibraryProps {
  onAdd: (type: WidgetType) => void;
  locale: Locale;
}
export function Library({ onAdd, locale }: LibraryProps) {
  const [search, setSearch] = useState('');
  const zh = locale === 'zh-CN';
  return (
    <div className="qg-library">
      <div className="qg-library-intro">
        <span>{zh ? '组件库' : 'COMPONENTS'}</span>
        <span className="qg-count">{WIDGET_CATALOG.length}</span>
      </div>
      <label className="qg-search">
        <Search size={14} />
        <input
          aria-label={zh ? '搜索组件' : 'Search components'}
          placeholder={zh ? '搜索组件…' : 'Search components…'}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <kbd>⌕</kbd>
      </label>
      {(['basic', 'data', 'layout'] as const).map((group) => {
        const items = WIDGET_CATALOG.filter(
          (item) =>
            item.group === group &&
            `${item.zh} ${item.en} ${item.type}`.toLowerCase().includes(search.toLowerCase()),
        );
        if (!items.length) return null;
        return (
          <section className="qg-library-group" key={group}>
            <h3>
              {
                {
                  basic: zh ? '基础控件' : 'BASIC',
                  data: zh ? '数据展示' : 'DATA DISPLAY',
                  layout: zh ? '布局与资源' : 'LAYOUT & ASSETS',
                }[group]
              }
            </h3>
            <div className="qg-library-grid">
              {items.map((item) => (
                <button
                  key={item.type}
                  className="qg-library-item"
                  draggable
                  title={
                    zh
                      ? `拖入画布或点击添加${item.zh}`
                      : `Drag to canvas or click to add ${item.en}`
                  }
                  onClick={() => onAdd(item.type)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/quickgui-widget', item.type);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <item.icon size={21} strokeWidth={1.5} />
                  <span>{zh ? item.zh : item.en}</span>
                  <Grip className="qg-drag-grip" size={11} />
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {!WIDGET_CATALOG.some((item) =>
        `${item.zh} ${item.en} ${item.type}`.toLowerCase().includes(search.toLowerCase()),
      ) && <div className="qg-empty-small">{zh ? '没有匹配的组件' : 'No matching components'}</div>}
      <div className="qg-library-tip">
        <MousePointer2 size={14} />
        <span>{zh ? '拖拽组件到画布，开始构建界面' : 'Drag a component onto the canvas'}</span>
      </div>
    </div>
  );
}

export default Library;
