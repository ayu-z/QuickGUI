import { createProject } from './project';
import { createSerialAssistantProject } from '../examples/serialAssistant';
import type { Locale, Project } from './types';

export const projectExamples: {
  id: string;
  label: Record<Locale, string>;
  create: (locale: Locale) => Project;
}[] = [
  {
    id: 'pump-station',
    label: { 'zh-CN': '打开泵站示例', en: 'Open pump station example' },
    create: (locale) => ({ ...createProject(), locale }),
  },
  {
    id: 'serial-assistant',
    label: { 'zh-CN': '打开串口助手示例', en: 'Open serial assistant example' },
    create: createSerialAssistantProject,
  },
];
