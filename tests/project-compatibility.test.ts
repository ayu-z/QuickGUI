import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { createProject, createWidget } from '../src/core/project';
import { validateProject } from '../src/core/validation';
import { exportProject, importProject } from '../src/core/archive';
import type { Project } from '../src/core/types';

function fixture(): Project {
  const project = createProject();
  project.locale = 'en';
  project.widgets[0].bindings.text = { variable: project.variables[0].id, mode: 'oneWay' };
  const child = createWidget('text');
  project.modules.push({
    id: 'legacy-module',
    name: 'Legacy module',
    version: '1.0.0',
    width: 240,
    height: 100,
    widgets: [child],
    exposedProps: { text: { widgetId: child.id, property: 'text', default: 'Legacy text' } },
  });
  project.assets.push({
    id: 'legacy-icon',
    name: 'icon.png',
    mime: 'image/png',
    data: 'data:image/png;base64,aGVsbG8=',
  });
  project.connections.push({
    id: 'legacy-service',
    name: 'Service',
    protocol: 'http',
    config: { url: 'http://localhost:8080' },
  });
  return project;
}

function freezeDeep(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeDeep(child);
  Object.freeze(value);
}

describe('project compatibility without silent data loss', () => {
  it.each([5, 99, '1', '2', null])(
    'rejects unsupported schemaVersion %s before interpreting the project',
    (schemaVersion) => {
      const input = { ...fixture(), schemaVersion, futureSubsystem: { mustNotDisappear: true } };
      const original = structuredClone(input);
      freezeDeep(input);
      expect(() => validateProject(input)).toThrow(/Unsupported project schemaVersion/);
      expect(() => validateProject(input)).toThrow(/original file has not been modified/);
      expect(input).toEqual(original);
    },
  );

  it('reports a missing version without inventing a migration or changing the input', () => {
    const { schemaVersion: _version, ...input } = fixture();
    const original = structuredClone(input);
    freezeDeep(input);
    expect(() => validateProject(input)).toThrow(/missing schemaVersion/);
    expect(() => validateProject(input)).toThrow(/original file has not been modified/);
    expect(input).toEqual(original);
  });

  const unknownFields: Array<{ name: string; path: string; add: (project: Project) => void }> = [
    {
      name: 'top-level feature',
      path: '$.futureFeature',
      add: (project) => Object.assign(project, { futureFeature: { retain: true } }),
    },
    {
      name: 'window platform metadata',
      path: '$.window.platformHint',
      add: (project) => Object.assign(project.window, { platformHint: 'future-platform' }),
    },
    {
      name: 'widget layout metadata',
      path: '$.widgets[0].layout.constraints',
      add: (project) =>
        Object.assign(project.widgets[0].layout, { constraints: { horizontal: 'stretch' } }),
    },
    {
      name: 'binding descriptor',
      path: '$.widgets[0].bindings.text.converter',
      add: (project) =>
        Object.assign(project.widgets[0].bindings.text, { converter: 'future-converter' }),
    },
    {
      name: 'alarm metadata',
      path: '$.variables[0].alarm.hysteresis',
      add: (project) => Object.assign(project.variables[0].alarm!, { hysteresis: 2 }),
    },
    {
      name: 'flow position metadata',
      path: '$.flows[0].nodes[0].position.coordinateSpace',
      add: (project) =>
        Object.assign(project.flows[0].nodes[0].position, { coordinateSpace: 'future-space' }),
    },
    {
      name: 'module property descriptor',
      path: '$.modules[0].exposedProps.text.validation',
      add: (project) =>
        Object.assign(project.modules[0].exposedProps.text, { validation: 'future-rule' }),
    },
    {
      name: 'nested module widget metadata',
      path: '$.modules[0].widgets[0].accessibility',
      add: (project) =>
        Object.assign(project.modules[0].widgets[0], { accessibility: { role: 'status' } }),
    },
    {
      name: 'asset metadata',
      path: '$.assets[0].license',
      add: (project) => Object.assign(project.assets[0], { license: 'future-license-field' }),
    },
  ];

  it.each(unknownFields)(
    'rejects unknown $name with its path and leaves the input untouched',
    ({ path, add }) => {
      const input = fixture();
      add(input);
      const original = structuredClone(input);
      freezeDeep(input);
      expect(() => validateProject(input)).toThrow(path);
      expect(() => validateProject(input)).toThrow(/newer designer/);
      expect(() => validateProject(input)).toThrow(/Do not save over the original file/);
      expect(input).toEqual(original);
    },
  );

  it('reports all unknown paths and gives a readable Chinese compatibility message', () => {
    const input = fixture();
    input.locale = 'zh-CN';
    Object.assign(input, { futureFeature: true });
    Object.assign(input.theme, { futurePalette: 'new' });
    expect(() => validateProject(input)).toThrow('$.futureFeature');
    expect(() => validateProject(input)).toThrow('$.theme.futurePalette');
    expect(() => validateProject(input)).toThrow('较新版本的设计器');
    expect(() => validateProject(input)).toThrow('请勿保存覆盖原件');
    expect(() => validateProject(input)).toThrow('原文件未修改');
  });

  it('preserves input bytes when project import rejects an unsupported field', () => {
    const project = fixture();
    Object.assign(project.publish, { futurePackageFormat: 'v-next' });
    const bytes = strToU8(JSON.stringify(project)),
      original = bytes.slice();
    expect(() => importProject(bytes)).toThrow('$.publish.futurePackageFormat');
    expect(bytes).toEqual(original);
  });

  it('opens and round-trips a valid older v1 project without newer optional fields', () => {
    const old = fixture();
    delete old.translations;
    const original = structuredClone(old);
    freezeDeep(old);
    const parsed = validateProject(old);
    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(old);
    expect(importProject(exportProject(parsed))).toEqual(original);
    expect(old).toEqual(original);
  });

  it('retains open property/configuration maps and their nested custom data', () => {
    const project = fixture();
    project.widgets[0].props.vendorExtension = {
      nested: { futureValue: 7 },
      labels: ['a', 'b'],
      enabled: true,
    };
    project.widgets[0].style.opacity = 0.7;
    project.widgets[0].states.vendorState = { color: '#123456' };
    project.flows[0].nodes[0].config.vendorOptions = { interval: 125, features: ['custom'] };
    project.connections[0].config.vendorProtocol = { channel: 'new', retry: { limit: 3 } };
    project.theme.tokens['vendor.brand.accent'] = '#345678';
    project.translations = {
      en: { 'vendor.new.label': 'Retained' },
      'zh-CN': { 'vendor.new.label': '保留' },
    };
    expect(validateProject(project)).toEqual(project);
    expect(importProject(exportProject(project))).toEqual(project);
  });
});
