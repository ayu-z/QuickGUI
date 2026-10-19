import { useState } from 'react';
import { AppWindow, Monitor, Plus } from 'lucide-react';
import type { Locale, Project } from '../core/types';
import { listProjectWindows } from '../core/windows';
import { ProjectItemSelect } from './ProjectItemSelect';
import { WindowPrompt } from './WindowPrompt';

export function WindowManager({
  project,
  activeWindowId,
  onSelect,
  onCreate,
  locale,
}: {
  project: Project;
  activeWindowId: string;
  locale: Locale;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const windows = listProjectWindows(project),
    zh = locale === 'zh-CN';
  return (
    <section className="window-manager" aria-label={zh ? '工程窗口' : 'Project windows'}>
      <ProjectItemSelect
        label={zh ? '选择窗口' : 'Select window'}
        icon={activeWindowId === 'main' ? Monitor : AppWindow}
        items={windows.map((window) => ({
          id: window.id,
          name:
            window.id === 'main'
              ? `${window.name} (${zh ? '主窗口' : 'Main window'})`
              : window.name,
        }))}
        value={activeWindowId}
        onSelect={onSelect}
      >
        <button
          className="qg-icon-button"
          aria-label={zh ? '新增窗口' : 'Add window'}
          title={zh ? '新增窗口' : 'Add window'}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} />
        </button>
      </ProjectItemSelect>
      {creating && (
        <WindowPrompt
          mode="create"
          initialName={`${zh ? '新窗口' : 'New window'} ${windows.length}`}
          widgetCount={0}
          locale={locale}
          onCancel={() => setCreating(false)}
          onConfirm={(name) => {
            onCreate(name);
            setCreating(false);
          }}
        />
      )}
    </section>
  );
}
