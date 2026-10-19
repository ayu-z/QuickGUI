import { expect, test } from '@playwright/test';
import { createEmptyProject, createWidget } from '../../src/core/project';
import { createBlockInterface } from '../../src/core/functionBlocks';
import type { FlowNode } from '../../src/core/types';

test('widgets choose independent entries in one flow and the entry binding can be edited and undone', async ({
  page,
}) => {
  const project = createEmptyProject('多入口流程');
  project.variables = ['a', 'b'].map((id) => ({ id, name: id, type: 'number', initial: 0 }));
  const nodes: FlowNode[] = [];
  const edges = [];
  for (const [index, id] of ['a', 'b'].entries()) {
    const button = createWidget('button', 30 + index * 200, 40);
    button.id = `button-${id}`;
    button.props.text = id.toUpperCase();
    button.events.click = { flowId: 'main', entryNodeId: `${id}-event` };
    const display = createWidget('number', 30 + index * 200, 140);
    display.id = `value-${id}`;
    display.bindings.value = { variable: id, mode: 'oneWay' };
    project.widgets.push(button, display);
    const branch: Omit<FlowNode, 'position'>[] = [
      {
        id: `${id}-event`,
        kind: 'event' as const,
        label: id.toUpperCase(),
        config: { trigger: 'manual' },
      },
      { id: `${id}-write`, kind: 'write' as const, label: id, config: { variable: id } },
    ];
    for (const node of branch) {
      const item: FlowNode = { ...node, position: { x: index * 400, y: nodes.length * 150 } };
      item.block = createBlockInterface(item, project);
      if (item.kind === 'write') item.block.inputs[0].defaultValue = index + 1;
      nodes.push(item);
    }
    edges.push({ id, source: `${id}-event`, target: `${id}-write` });
  }
  project.flows = [{ id: 'main', name: 'Main', enabled: true, nodes, edges }];
  await page.goto('/');
  await page.locator('input[accept=".qgui,.json"]').setInputFiles({
    name: 'entries.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole('dialog', { name: '关闭当前工程', exact: true })
    .getByRole('button', { name: '保留恢复副本并关闭', exact: true })
    .click();
  await expect(page.locator('.project-switch')).toHaveText(project.name);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('.preview-modal');
  await preview.locator('[data-widget="button-a"] button').click();
  await expect(preview.locator('[data-widget="value-a"] input')).toHaveValue('1.00');
  await expect(preview.locator('[data-widget="value-b"] input')).toHaveValue('0.00');
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  const runEntry = page.getByLabel('运行入口', { exact: true });
  await expect(runEntry.locator('option')).toHaveCount(2);
  await runEntry.selectOption(JSON.stringify(['main', 'b-event']));
  await page.locator('.console-panel').getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.console-content')).toContainText('Completed: Main');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(preview.locator('[data-widget="value-a"] input')).toHaveValue('1.00');
  await expect(preview.locator('[data-widget="value-b"] input')).toHaveValue('2.00');
  await preview.locator('[data-widget="button-b"] button').click();
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('[data-design-widget="button-a"]').click();
  const entry = page.getByLabel('onClick 入口', { exact: true });
  await expect(entry).toHaveValue('a-event');
  await entry.selectOption('b-event');
  await expect(entry).toHaveValue('b-event');
  await entry.press('Tab');
  await page.locator('.workspace-tools').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(entry).toHaveValue('a-event');
});
