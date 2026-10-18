import { describe, expect, it } from 'vitest';
import { createWidget } from '../src/core/project';
import {
  arrangementPatches,
  canArrange,
  inheritedFlag,
  reorderedWidgets,
  selectionRoots,
} from '../src/designer/commands';
import { resizeLayout } from '../src/designer/CanvasEditor';

const widgets = () =>
  ['a', 'b', 'c'].map((id, index) => ({
    ...createWidget('button', 40 + index * 180, 40 + index * 80),
    id,
    layout: { x: 40 + index * 180, y: 40 + index * 80, width: 100, height: 40 },
  }));
describe('canvas command geometry', () => {
  it('normalizes nested selections to independent subtree roots and inherits editor locks', () => {
    const [parent, child] = widgets();
    parent.type = 'panel';
    child.parentId = parent.id;
    parent.editor = { locked: true };
    expect(selectionRoots([parent, child], [parent.id, child.id])).toEqual([parent]);
    expect(inheritedFlag(child, [parent, child], 'locked')).toBe(true);
  });
  it('aligns and distributes only unlocked siblings in absolute layout', () => {
    const list = widgets();
    list[1].layout.x = 250;
    expect(
      arrangementPatches(list, ['a', 'b', 'c'], 'align-top').map((item) => item.patch.layout!.y),
    ).toEqual([40, 40, 40]);
    expect(
      arrangementPatches(list, ['a', 'b', 'c'], 'distribute-x').map((item) => item.patch.layout!.x),
    ).toEqual([40, 220, 400]);
    list[1].parentId = 'another';
    expect(canArrange(list, ['a', 'b'])).toBe(false);
    list[1].parentId = undefined;
    list[0].editor = { locked: true };
    expect(canArrange(list, ['a', 'b'])).toBe(false);
  });
  it('reorders selected siblings without rewriting IDs or parent relationships', () => {
    const list = widgets();
    expect(reorderedWidgets(list, ['a'], 'front').map((w) => w.id)).toEqual(['b', 'c', 'a']);
    expect(reorderedWidgets(list, ['b', 'c'], 'back').map((w) => w.id)).toEqual(['b', 'c', 'a']);
    expect(reorderedWidgets(list, ['b'], 'raise').map((w) => w.id)).toEqual(['a', 'c', 'b']);
    expect(reorderedWidgets(list, ['b'], 'lower').map((w) => w.id)).toEqual(['b', 'a', 'c']);
    expect(list.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });
  it('resizes eight directions with fixed opposite edges and preserves Shift aspect ratio', () => {
    const layout = { x: 100, y: 100, width: 120, height: 60 };
    for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const) {
      const result = resizeLayout(layout, direction, 24, 12, true, 1);
      expect(result.width / result.height).toBeCloseTo(2);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    }
    const west = resizeLayout(layout, 'w', 20, 0, false, 1);
    expect(west.x + west.width).toBe(220);
    const north = resizeLayout(layout, 'n', 0, 20, false, 1);
    expect(north.y + north.height).toBe(160);
    const bounded = resizeLayout(layout, 'w', -500, 0, true, 1);
    expect(bounded.x).toBe(0);
    expect(bounded.x + bounded.width).toBe(220);
    expect(bounded.y + bounded.height / 2).toBe(130);
    expect(bounded.width / bounded.height).toBeCloseTo(2);
  });
});
