import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  groupIssue,
  groupWidgets,
  moveIssue,
  moveWidgets,
  ungroupIssue,
  ungroupWidgets,
} from '../src/core/hierarchy';
import { createEmptyProject, createWidget } from '../src/core/project';
import { EditorStore } from '../src/core/store';
import { validateProject } from '../src/core/validation';
import { exportProject, importProject } from '../src/core/archive';
import { commandForKey, commandItems } from '../src/designer/commands';
import type { Widget } from '../src/core/types';

const widget = (id: string, x = 0, y = 0, parentId?: string, panel = false): Widget => ({
  ...createWidget(panel ? 'panel' : 'button', x, y),
  id,
  name: id,
  ...(parentId ? { parentId } : {}),
  layout: { x, y, width: 100, height: 40 },
});
const world = (widgets: Widget[], id: string): { x: number; y: number } => {
  const item = widgets.find((entry) => entry.id === id)!;
  const parent = item.parentId ? world(widgets, item.parentId) : { x: 0, y: 0 };
  return { x: parent.x + item.layout.x, y: parent.y + item.layout.y };
};
const siblings = (widgets: Widget[], parentId?: string) =>
  widgets.filter((entry) => entry.parentId === parentId).map((entry) => entry.id);
const unchanged = (widgets: Widget[], change: () => unknown) => {
  const before = structuredClone(widgets);
  expect(change).toThrow();
  expect(widgets).toEqual(before);
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('layer hierarchy', () => {
  it('reparents nested selections once and retains absolute positions, stable IDs and subtree metadata', () => {
    const source = widget('source', 100, 60, undefined, true),
      target = widget('target', 400, 200, undefined, true);
    const child = widget('child', 30, 20, source.id, true),
      nested = widget('nested', 5, 8, child.id);
    nested.bindings.text = { variable: 'stable', mode: 'oneWay' };
    nested.events.click = 'stableFlow';
    const widgets = [source, child, nested, target];
    const before = structuredClone(widgets),
      oldWorld = world(widgets, nested.id);
    const moved = moveWidgets(widgets, [child.id, nested.id], { parentId: target.id });
    expect(world(moved, nested.id)).toEqual(oldWorld);
    expect(moved.find((entry) => entry.id === child.id)).toMatchObject({
      parentId: target.id,
      layout: { x: -270, y: -120 },
    });
    expect(moved.find((entry) => entry.id === nested.id)).toEqual(nested);
    expect(widgets).toEqual(before);
    const back = moveWidgets(moved, [child.id], {});
    expect(back.find((entry) => entry.id === child.id)!.parentId).toBeUndefined();
    expect(world(back, nested.id)).toEqual(oldWorld);
  });

  it('reorders siblings and moves multiple roots without changing unrelated stacking', () => {
    const widgets = [
      widget('a'),
      widget('b'),
      widget('c'),
      widget('d'),
      widget('parent', 10, 20, undefined, true),
      widget('e', 1, 2, 'parent'),
    ];
    const moved = moveWidgets(widgets, ['a', 'c'], { beforeId: 'd' });
    expect(siblings(moved)).toEqual(['b', 'a', 'c', 'd', 'parent']);
    expect(siblings(moved, 'parent')).toEqual(['e']);
    const inside = moveWidgets(widgets, ['a', 'c'], { parentId: 'parent', beforeId: 'e' });
    expect(siblings(inside, 'parent')).toEqual(['a', 'c', 'e']);
    expect(siblings(inside)).toEqual(['b', 'd', 'parent']);
    expect(world(inside, 'a')).toEqual(world(widgets, 'a'));
  });

  it('rejects cycles, invalid parents and locked subtrees before returning a changed list', () => {
    const widgets = [
      widget('parent', 10, 20, undefined, true),
      widget('child', 1, 2, 'parent', true),
      widget('leaf', 1, 2, 'child'),
      widget('other'),
    ];
    for (const change of [
      () => moveWidgets(widgets, ['parent'], { parentId: 'child' }),
      () => moveWidgets(widgets, ['parent'], { parentId: 'parent' }),
      () => moveWidgets(widgets, ['leaf'], { parentId: 'other' }),
      () => moveWidgets(widgets, ['leaf'], { beforeId: 'child' }),
      () => moveWidgets(widgets, ['missing'], {}),
    ])
      unchanged(widgets, change);
    widgets[2].editor = { locked: true };
    unchanged(widgets, () => moveWidgets(widgets, ['parent'], {}));
    unchanged(widgets, () => groupWidgets(widgets, ['parent', 'other']));
    widgets[2].editor = {};
    widgets[0].editor = { locked: true };
    unchanged(widgets, () => moveWidgets(widgets, ['leaf'], {}));
    unchanged(widgets, () => moveWidgets(widgets, ['other'], { parentId: 'child' }));
  });

  it('permits automatic-layout sibling order but diagnoses coordinate-unsafe reparenting and scope changes', () => {
    const widgets = [
      widget('panel', 20, 40, undefined, true),
      widget('a', 1, 2, 'panel'),
      widget('b', 3, 4, 'panel'),
      widget('other', 200, 40, undefined, true),
    ];
    widgets[0].layout.mode = 'flex';
    expect(siblings(moveWidgets(widgets, ['a'], { parentId: 'panel' }), 'panel')).toEqual([
      'b',
      'a',
    ]);
    expect(moveIssue(widgets, ['a'], {})).toMatch(/absolute layout/);
    expect(moveIssue(widgets, ['other'], { parentId: 'panel' })).toMatch(/absolute layout/);
    widgets[0].layout.mode = 'absolute';
    widgets[0].resourceScopeId = 'first';
    widgets[3].resourceScopeId = 'second';
    expect(moveIssue(widgets, ['a'], { parentId: 'other' })).toMatch(/resource scope/);
    widgets[1].resourceScopeId = 'explicit';
    expect(moveIssue(widgets, ['a'], { parentId: 'other' })).toBeUndefined();
  });

  it('groups adjacent siblings into a transparent panel and losslessly ungroups them in place', () => {
    const widgets = [
      widget('background'),
      widget('a', 40, 60),
      widget('b', 180, 100, undefined, true),
      widget('nested', 8, 12, 'b'),
      widget('foreground'),
    ];
    widgets[1].bindings.text = { variable: 'value', mode: 'oneWay' };
    widgets[1].events.click = 'event';
    const before = structuredClone(widgets);
    const result = groupWidgets(widgets, ['b', 'a'], 'Controls');
    const group = result.widgets.find((entry) => entry.id === result.groupId)!;
    expect(group).toMatchObject({
      type: 'panel',
      name: 'Controls',
      layout: { x: 40, y: 60, width: 240, height: 80, mode: 'absolute' },
      style: {},
      props: { overflow: 'visible' },
    });
    expect(siblings(result.widgets)).toEqual(['background', result.groupId, 'foreground']);
    expect(siblings(result.widgets, result.groupId)).toEqual(['a', 'b']);
    for (const id of ['a', 'b', 'nested'])
      expect(world(result.widgets, id)).toEqual(world(widgets, id));
    const ungrouped = ungroupWidgets(result.widgets, [result.groupId]);
    expect(ungrouped.widgets).toEqual(widgets);
    expect(ungrouped.selectedIds).toEqual(['a', 'b']);
    expect(widgets).toEqual(before);
  });

  it('keeps nested-parent coordinates and original stacking slots when ungrouping multiple groups', () => {
    const widgets = [
      widget('parent', 100, 200, undefined, true),
      widget('a', 20, 30, 'parent'),
      widget('b', 140, 50, 'parent'),
      widget('c', 280, 70, 'parent'),
      widget('d', 420, 90, 'parent'),
    ];
    const first = groupWidgets(widgets, ['a', 'b']);
    const second = groupWidgets(first.widgets, ['c', 'd']);
    const ungrouped = ungroupWidgets(second.widgets, [first.groupId, second.groupId]);
    expect(ungrouped.widgets).toEqual(widgets);
    expect(ungrouped.selectedIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('groups nonadjacent layers at the highest selected slot while retaining relative stacking', () => {
    const widgets = [
      widget('a', 10, 20),
      widget('b', 80, 40),
      widget('c', 150, 60),
      widget('d', 220, 80),
    ];
    expect(groupIssue(widgets, ['a', 'c'])).toBeUndefined();
    const grouped = groupWidgets(widgets, ['c', 'a']);
    expect(siblings(grouped.widgets)).toEqual(['b', grouped.groupId, 'd']);
    expect(siblings(grouped.widgets, grouped.groupId)).toEqual(['a', 'c']);
    expect(grouped.widgets.find((entry) => entry.id === 'b')).toBe(widgets[1]);
    expect(grouped.widgets.find((entry) => entry.id === 'd')).toBe(widgets[3]);
    for (const id of ['a', 'b', 'c', 'd'])
      expect(world(grouped.widgets, id)).toEqual(world(widgets, id));
    const flattened = ungroupWidgets(grouped.widgets, [grouped.groupId]);
    expect(flattened.widgets).toEqual([widgets[1], widgets[0], widgets[2], widgets[3]]);
    expect(widgets.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects cross-parent and automatic-layout groups with clear diagnostics', () => {
    const widgets = [
      widget('a'),
      widget('b'),
      widget('c'),
      widget('parent', 0, 0, undefined, true),
      widget('child', 0, 0, 'parent'),
    ];
    expect(groupIssue(widgets, ['a', 'child'])).toMatch(/same parent/);
    expect(groupIssue(widgets, ['a'])).toMatch(/at least two/);
    widgets.push(widget('child2', 100, 0, 'parent'));
    widgets[3].layout.mode = 'grid';
    expect(groupIssue(widgets, ['child', 'child2'])).toMatch(/absolute layout/);
  });

  it('refuses to discard rendering, state, bindings, events, clipping or scoped container semantics', () => {
    const original = groupWidgets([widget('a'), widget('b', 150, 0)], ['a', 'b']);
    const patches: Partial<Widget>[] = [
      { resourceScopeId: 'isolated' },
      { style: { background: '#ffffff' } },
      { style: { padding: 8 } },
      { style: { opacity: 0.5 } },
      { style: { color: '#ffffff' } },
      { states: { hover: { background: '#fff' } } },
      { bindings: { visible: { variable: 'show', mode: 'oneWay' } } },
      { events: { click: 'flow' } },
      { props: { enabled: false, overflow: 'visible' } },
      { props: { enabled: true, visible: true, overflow: 'hidden' } },
      { editor: { hidden: true } },
      { layout: { x: 0, y: 0, width: 100, height: 100, mode: 'flex' } },
    ];
    for (const patch of patches) {
      const widgets = structuredClone(original.widgets);
      Object.assign(
        widgets.find((entry) => entry.id === original.groupId)!,
        patch,
      );
      expect(ungroupIssue(widgets, [original.groupId])).toMatch(/Ungrouping/);
      unchanged(widgets, () => ungroupWidgets(widgets, [original.groupId]));
    }
  });

  it('preserves strict export validation and one editor history entry per structural change', () => {
    const project = createEmptyProject();
    project.widgets = [widget('a', 20, 30), widget('b', 140, 50)];
    const memory = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    });
    vi.useFakeTimers();
    const store = new EditorStore(project);
    try {
      let groupId = '';
      store.update((next) => {
        const result = groupWidgets(next.widgets, ['a', 'b']);
        next.widgets = result.widgets;
        groupId = result.groupId;
      });
      const grouped = store.getSnapshot().project!;
      expect(store.getSnapshot().past).toHaveLength(1);
      expect(validateProject(grouped)).toEqual(grouped);
      expect(importProject(exportProject(grouped))).toEqual(grouped);
      store.setDraft('a', '{ unfinished CODE');
      store.undo();
      expect(store.getSnapshot().project!.widgets).toEqual(project.widgets);
      expect(store.getDraft('a')).toBe('{ unfinished CODE');
      store.redo();
      expect(store.getSnapshot().project!.widgets).toEqual(grouped.widgets);
      store.update((next) => {
        next.widgets = ungroupWidgets(next.widgets, [groupId]).widgets;
      });
      expect(store.getSnapshot().past).toHaveLength(2);
      expect(store.getSnapshot().project!.widgets).toEqual(project.widgets);
    } finally {
      store.dispose();
    }
  });

  it('exposes group commands and platform shortcuts with safe disabled states', () => {
    const widgets = [widget('a'), widget('b', 120, 0)];
    expect(
      commandForKey({ key: 'g', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }),
    ).toBe('group');
    expect(
      commandForKey({ key: 'G', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false }),
    ).toBe('ungroup');
    const items = commandItems(widgets, ['a', 'b'], 'zh-CN');
    expect(items.find((item) => item.id === 'group')?.disabled).toBe(false);
    expect(items.find((item) => item.id === 'ungroup')?.disabled).toBe(true);
    expect(items.find((item) => item.id === 'ungroup')?.reason).toMatch(/transparent/);
    const grouped = groupWidgets(widgets, ['a', 'b']);
    expect(
      commandItems(grouped.widgets, [grouped.groupId], 'en').find((item) => item.id === 'ungroup')
        ?.disabled,
    ).toBe(false);
  });
});
