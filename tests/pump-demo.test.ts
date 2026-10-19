import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/project';
import { validateProject } from '../src/core/validation';
import { exportProject, importProject } from '../src/core/archive';
import { RuntimeController } from '../src/runtime/engine';
import type { Project } from '../src/core/types';

const fixture = JSON.parse(
  readFileSync(new URL('../examples/pump-station/quickgui.json', import.meta.url), 'utf8'),
) as Project;

describe('pump station FB demo', () => {
  it('ships the same editable current-model project as the welcome example', () => {
    const project = createProject();
    expect({ ...project, id: fixture.id }).toEqual(fixture);
    expect(validateProject(fixture)).toEqual(fixture);
    expect(importProject(exportProject(project))).toEqual(project);
    expect(project.widgets.every((widget) => widget.definitionVersion === 2)).toBe(true);
    expect(project.flows.flatMap((flow) => flow.nodes).every((node) => node.block)).toBe(true);
  });

  it('calculates both outputs from fresh shared inputs and fans RPM out to display and logging', async () => {
    const engine = new RuntimeController(fixture);
    try {
      for (const [speed, rated, rpm, margin] of [
        [65, 3000, 1950, 35],
        [20, 4500, 900, 80],
        [0, 3000, 0, 100],
        [100, 3000, 3000, 0],
        [65, 0, 0, 35],
      ]) {
        engine.setVariable('speed', speed);
        engine.setVariable('rated_rpm', rated);
        await engine.runFlow('calculate-speed');
        const snapshot = engine.getSnapshot();
        expect(snapshot.values.target_rpm.value).toBe(rpm);
        expect(snapshot.values.speed_margin.value).toBe(margin);
        const logs = snapshot.logs.filter((log) => log.nodeId === 'log-target-rpm');
        expect(Number(logs.at(-1)?.message)).toBe(rpm);
        expect(snapshot.logs.some((log) => log.level === 'error')).toBe(false);
      }
      expect(
        engine.getSnapshot().logs.filter((log) => log.nodeId === 'log-target-rpm'),
      ).toHaveLength(5);
      await engine.runFlow('start-cycle');
      await engine.runFlow('start-cycle');
      expect(engine.getSnapshot().values.cycles.value).toBe(2);
    } finally {
      engine.dispose();
    }
  });
});
