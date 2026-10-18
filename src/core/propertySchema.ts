import { z } from 'zod';
import type { Json } from './types';
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]),
);
export const propertyDefinitionSchema = z
  .object({
    key: z.string().min(1),
    label: z.object({ zh: z.string(), en: z.string() }).strict(),
    group: z.enum(['content', 'behavior', 'data', 'appearance']),
    type: z.enum(['string', 'number', 'boolean', 'json']),
    editor: z.enum([
      'text',
      'textarea',
      'number',
      'toggle',
      'select',
      'color',
      'asset',
      'options',
      'series',
      'columns',
      'json',
    ]),
    initialValue: json,
    fallbackValue: json,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().positive().optional(),
    integer: z.boolean().optional(),
    enum: z.array(z.union([z.string(), z.number().finite()])).optional(),
    reference: z.enum(['asset', 'variable', 'module']).optional(),
    binding: z
      .object({
        modes: z.array(z.enum(['oneWay', 'twoWay', 'once'])),
        variableTypes: z.array(z.enum(['number', 'string', 'boolean', 'json'])),
        writeEvent: z.string().optional(),
      })
      .strict()
      .optional(),
    target: z.string().optional(),
    stateful: z.boolean().optional(),
  })
  .strict();
