import { useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from 'react';
import { PanelsTopLeft, X } from 'lucide-react';
import type { Json, Project, ProjectWindow, Widget } from '../core/types';
import { listProjectWindows, projectForWindow } from '../core/windows';
import type { RuntimeController } from './engine';
import { initialWindowState } from './windowState';
import { Scene } from './WidgetRenderer';
import { getBindableProperties, propertyPath } from '../core/widgetDefinitions';
import './runtime.css';

export function writeWidgetBindings(
  widget: Widget,
  event: string,
  payload: Json,
  project: Project,
  setVariable: RuntimeController['setVariable'],
): void {
  if (widget.definitionVersion !== 2) {
    if (event === 'change' && widget.bindings.value?.mode === 'twoWay')
      setVariable(widget.bindings.value.variable, payload, widget.bindings.value.path);
    return;
  }
  const fields = getBindableProperties(
    widget,
    project.modules.find((module) => module.id === widget.moduleId),
  );
  for (const [key, binding] of Object.entries(widget.bindings)) {
    const target = JSON.stringify(propertyPath(key));
    const definition = fields.find((field) => JSON.stringify(propertyPath(field.key)) === target);
    if (binding.mode === 'twoWay' && definition?.binding?.writeEvent === event)
      setVariable(binding.variable, payload, binding.path);
  }
}

export function RuntimeWindows({
  engine,
  windowId,
}: {
  project: Project;
  engine: RuntimeController;
  windowId?: string;
}) {
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const project = engine.getProject();
  const state = snapshot.windowState ?? initialWindowState(project);
  const windows = listProjectWindows(project);
  const zh = project.locale === 'zh-CN';
  const onEvent = (widget: Widget, event: string, payload: Json) => {
    try {
      writeWidgetBindings(widget, event, payload, project, engine.setVariable);
      const flow = widget.events[event];
      if (flow)
        void engine.runFlow(flow, payload).catch((error) => engine.log(String(error), 'error'));
    } catch (error) {
      engine.log(String(error), 'error');
    }
  };
  const action = (command: 'open' | 'close' | 'focus', id: string) => {
    try {
      engine.windowAction(command, id);
    } catch (error) {
      engine.log(String(error), 'error');
    }
  };
  if (windowId || windows.length === 1) {
    const id = windowId ?? 'main';
    if (!windows.some((window) => window.id === id)) return null;
    return (
      <Scene project={projectForWindow(project, id)} values={snapshot.values} onEvent={onEvent} />
    );
  }
  return (
    <div className="qg-runtime-desktop" data-testid="runtime-windows">
      <nav className="qg-runtime-window-list" aria-label={zh ? '运行窗口' : 'Runtime windows'}>
        <PanelsTopLeft size={15} />
        {windows.map((window) => (
          <button
            key={window.id}
            className={state.open.includes(window.id) ? 'open' : ''}
            onClick={() => action('open', window.id)}
            aria-label={`${zh ? '打开窗口' : 'Open window'} ${window.name}`}
          >
            {window.name}
          </button>
        ))}
        <span>{zh ? '窗口共享变量与流程' : 'Shared variables and flows'}</span>
      </nav>
      <div
        className="qg-runtime-window-space"
        style={{
          minWidth:
            Math.max(
              ...windows
                .filter((window) => state.open.includes(window.id))
                .map((window) => window.config.width),
            ) + 100,
          minHeight:
            Math.max(
              ...windows
                .filter((window) => state.open.includes(window.id))
                .map((window) => window.config.height),
            ) + 140,
        }}
      >
        {windows
          .filter((window) => state.open.includes(window.id))
          .map((window) => (
            <RuntimeFrame
              key={window.id}
              window={window}
              index={windows.indexOf(window)}
              focused={state.focused === window.id}
              locale={project.locale}
              onFocus={() => action('focus', window.id)}
              onClose={() => action('close', window.id)}
            >
              <Scene
                project={projectForWindow(project, window.id)}
                values={snapshot.values}
                onEvent={onEvent}
              />
            </RuntimeFrame>
          ))}
      </div>
    </div>
  );
}

function RuntimeFrame({
  window,
  index,
  focused,
  locale,
  onFocus,
  onClose,
  children,
}: {
  window: ProjectWindow;
  index: number;
  focused: boolean;
  locale: string;
  onFocus: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [position, setPosition] = useState({ x: 16 + index * 32, y: 16 + index * 32 });
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const down = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
  };
  return (
    <section
      className={`qg-runtime-window ${focused ? 'focused' : ''}`}
      data-runtime-window-id={window.id}
      aria-label={window.name}
      onPointerDownCapture={() => {
        if (!focused) onFocus();
      }}
      style={{
        width: window.config.width + 2,
        left: position.x,
        top: position.y,
        zIndex: focused ? 50 : index,
      }}
    >
      <header
        onPointerDown={down}
        onPointerMove={(event) => {
          if (drag.current)
            setPosition({
              x: Math.max(0, drag.current.left + event.clientX - drag.current.x),
              y: Math.max(0, drag.current.top + event.clientY - drag.current.y),
            });
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
      >
        <strong>{window.config.title || window.name}</strong>
        {window.id !== 'main' && (
          <button
            aria-label={`${locale === 'zh-CN' ? '关闭窗口' : 'Close window'} ${window.name}`}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}
