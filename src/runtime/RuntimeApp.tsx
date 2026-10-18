import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Json, Project, Widget } from '../core/types';
import { RuntimeController } from './engine';
import { Scene } from './WidgetRenderer';
import './runtime.css';

export function RuntimeApp({ project, engine }: { project: Project; engine?: RuntimeController }) {
  const owned = useMemo(() => engine ?? new RuntimeController(project), [engine]);
  const snapshot = useSyncExternalStore(owned.subscribe, owned.getSnapshot);
  const activeProject = owned.getProject();
  useEffect(() => {
    owned.applyProject(project);
  }, [project, owned]);
  useEffect(
    () => () => {
      if (!engine) owned.dispose();
    },
    [engine, owned],
  );
  const onEvent = (widget: Widget, event: string, payload: Json) => {
    try {
      const binding = widget.bindings.value;
      if (event === 'change' && binding?.mode === 'twoWay')
        owned.setVariable(binding.variable, payload);
      const flow = widget.events[event];
      if (flow)
        void owned.runFlow(flow, payload).catch((error) => owned.log(String(error), 'error'));
    } catch (error) {
      owned.log(String(error), 'error');
    }
  };
  return (
    <div className="qg-runtime-app">
      <Scene project={activeProject} values={snapshot.values} onEvent={onEvent} />
    </div>
  );
}
export default RuntimeApp;
