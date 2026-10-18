import { useEffect, useMemo } from 'react';
import type { Project } from '../core/types';
import { RuntimeController } from './engine';
import { RuntimeWindows } from './RuntimeWindows';
import './runtime.css';

export function RuntimeApp({
  project,
  engine,
  windowId,
}: {
  project: Project;
  engine?: RuntimeController;
  windowId?: string;
}) {
  const owned = useMemo(() => engine ?? new RuntimeController(project), [engine]);
  useEffect(() => {
    owned.applyProject(project);
  }, [project, owned]);
  useEffect(
    () => () => {
      if (!engine) owned.dispose();
    },
    [engine, owned],
  );
  return (
    <div className="qg-runtime-app">
      <RuntimeWindows project={project} engine={owned} windowId={windowId} />
    </div>
  );
}
export default RuntimeApp;
