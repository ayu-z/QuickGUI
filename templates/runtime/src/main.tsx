import { createRoot } from 'react-dom/client';
import { RuntimeApp } from './runtime/RuntimeApp';
import { createRuntime } from './runtime/controller';
import { isDesktop } from './native/bridge';
import { validateProject } from './core/validation';
import projectData from '../project.json';
import './runtime/runtime.css';

const project = validateProject(projectData);
const windowId = new URLSearchParams(location.search).get('windowId') ?? 'main';
document.title =
  windowId === 'main'
    ? project.window.title
    : (project.windows?.find((window) => window.id === windowId)?.config.title ?? project.name);
const engine = createRuntime(project, { attachOnly: isDesktop() && windowId !== 'main' });
createRoot(document.getElementById('root')!).render(
  <RuntimeApp project={project} engine={engine} windowId={isDesktop() ? windowId : undefined} />,
);
