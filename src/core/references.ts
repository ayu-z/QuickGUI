import type { Project, Variable } from './types';
import { listProjectWindows } from './windows';
import { getFlowNodeReferences } from './flowV4';

export function variableReferences(project: Project, variable: Variable): string[] {
  const found: string[] = [];
  const referencesVariable = (key: string) =>
    (
      project.variables.find((entry) => entry.id === key) ??
      project.variables.find((entry) => entry.name === key)
    )?.id === variable.id;
  const widgets = [
    ...listProjectWindows(project).flatMap((window) => window.widgets),
    ...project.modules.flatMap((module) => module.widgets),
  ];
  for (const widget of widgets) {
    if (Object.values(widget.bindings).some((binding) => referencesVariable(binding.variable)))
      found.push(widget.name);
    if (
      widget.type === 'chart' &&
      Array.isArray(widget.props.series) &&
      widget.props.series.some(
        (series) =>
          series &&
          typeof series === 'object' &&
          !Array.isArray(series) &&
          typeof series.variableId === 'string' &&
          referencesVariable(series.variableId),
      )
    )
      found.push(widget.name);
  }
  for (const flow of project.flows)
    if (
      flow.nodes.some((node) =>
        getFlowNodeReferences(node).some(
          (reference) => reference.kind === 'variable' && referencesVariable(reference.id),
        ),
      )
    )
      found.push(flow.name);
  for (const script of project.scripts)
    if (Object.values(script.variableAliases ?? {}).includes(variable.id)) found.push(script.name);
  for (const scope of project.resourceScopes ?? [])
    if (scope.localeVariableId === variable.id) found.push(`locale: ${scope.id}`);
  return [...new Set(found)];
}
export function connectionReferences(
  project: Project,
  connection: string | { id: string },
): string[] {
  const id = typeof connection === 'string' ? connection : connection.id;
  return project.flows
    .filter((flow) =>
      flow.nodes.some((node) =>
        getFlowNodeReferences(node).some(
          (reference) => reference.kind === 'connection' && reference.id === id,
        ),
      ),
    )
    .map((flow) => flow.name);
}
