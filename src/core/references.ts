import type { Project, Variable } from './types';
import { listProjectWindows } from './windows';

export function variableReferences(project: Project, variable: Variable): string[] {
  const keys = new Set([variable.id, variable.name]),
    found: string[] = [];
  const widgets = [
    ...listProjectWindows(project).flatMap((window) => window.widgets),
    ...project.modules.flatMap((module) => module.widgets),
  ];
  for (const widget of widgets) {
    if (Object.values(widget.bindings).some((binding) => keys.has(binding.variable)))
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
          keys.has(series.variableId),
      )
    )
      found.push(widget.name);
  }
  for (const flow of project.flows)
    if (
      flow.nodes.some(
        (node) => typeof node.config.variable === 'string' && keys.has(node.config.variable),
      )
    )
      found.push(flow.name);
  for (const script of project.scripts)
    if (Object.values(script.variableAliases ?? {}).includes(variable.id)) found.push(script.name);
  for (const scope of project.resourceScopes ?? [])
    if (scope.localeVariableId === variable.id) found.push(`locale: ${scope.id}`);
  return [...new Set(found)];
}
