import { createRoot } from 'react-dom/client';
import { RuntimeApp } from './runtime/RuntimeApp';
import { createRuntime } from './runtime/controller';
import { applyWindow, isDesktop } from './native/bridge';
import { validateProject } from './core/validation';
import projectData from '../project.json';
import './runtime/runtime.css';

const project = validateProject(projectData);
document.title = project.window.title;
const engine = createRuntime(project);
if (isDesktop()) {
  const config = {
    ...project.window,
    icon:
      project.assets.find((asset) => asset.id === project.window.icon)?.data ?? project.window.icon,
  };
  applyWindow(config).catch((error) => console.error('Window configuration:', error));
}
createRoot(document.getElementById('root')!).render(
  <RuntimeApp project={project} engine={engine} />,
);
