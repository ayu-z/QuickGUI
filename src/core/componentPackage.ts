import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import type { ComponentModule, Json, Project, ResourceScope } from './types';
import { propertyDefinitionSchema } from './propertySchema';
import { themeSchema } from './themePresets';

export const COMPONENT_PACKAGE_LIMIT = 16_000_000;
const SOURCE_FILE_LIMIT = 1_000_000;
const SOURCE_TOTAL_LIMIT = 6_000_000;
const BUNDLE_LIMIT = 8_000_000;
const EXPANDED_LIMIT = 20_000_000;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]),
);
const propertyName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)
  .refine(
    (key) => !['__proto__', 'constructor', 'prototype'].includes(key),
    'Reserved property name',
  );
const eventName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/);
const canonicalJson = (value: Json): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

export function isSafeComponentPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    !/^[/.]|[\\:\u0000-\u001f\u007f]/.test(path) &&
    path
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !['__proto__', 'constructor', 'prototype'].includes(part),
      )
  );
}

export const componentManifestSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,99}$/),
    name: z.string().min(1).max(200),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
    entry: z.string().refine(isSafeComponentPath),
    styles: z.string().refine(isSafeComponentPath).optional(),
    width: z.number().positive().max(10_000),
    height: z.number().positive().max(10_000),
    props: z.record(propertyName, json),
    propertyDefinitions: z.record(propertyName, propertyDefinitionSchema).optional(),
    events: z
      .array(eventName)
      .max(64)
      .refine((events) => new Set(events).size === events.length, 'Event names must be unique'),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.schemaVersion === 1 && manifest.propertyDefinitions)
      ctx.addIssue({
        code: 'custom',
        message: 'Property definitions require component manifest v2',
      });
  });
const packageResourcesSchema = z
  .object({
    id: z.string(),
    theme: themeSchema,
    translations: z.record(z.record(z.string())),
    locale: z.enum(['zh-CN', 'en']),
    localeVariableId: z.string().optional(),
    assetAliases: z.record(z.string()).optional(),
    assets: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            mime: z.string(),
            data: z.string().max(20_000_000),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const reactImplementationSchema = z
  .object({
    kind: z.literal('react'),
    files: z.record(z.string().max(SOURCE_FILE_LIMIT)),
    bundle: z.string().min(1).max(BUNDLE_LIMIT),
    events: z.array(eventName).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const entries = Object.entries(value.files);
    if (!entries.length || entries.length > 128)
      context.addIssue({
        code: 'custom',
        message: 'A component must contain between 1 and 128 source files',
        path: ['files'],
      });
    if (!Object.hasOwn(value.files, 'manifest.json'))
      context.addIssue({
        code: 'custom',
        message: 'Source files must include manifest.json',
        path: ['files'],
      });
    let total = 0;
    for (const [path, text] of entries) {
      if (!isSafeComponentPath(path))
        context.addIssue({
          code: 'custom',
          message: `Unsafe component source path: ${path}`,
          path: ['files', path],
        });
      const bytes = utf8Bytes(text);
      total += bytes;
      if (bytes > SOURCE_FILE_LIMIT)
        context.addIssue({
          code: 'custom',
          message: 'Source file exceeds 1 MB',
          path: ['files', path],
        });
    }
    if (total > SOURCE_TOTAL_LIMIT)
      context.addIssue({
        code: 'custom',
        message: 'Component sources exceed 6 MB',
        path: ['files'],
      });
    if (utf8Bytes(value.bundle) > BUNDLE_LIMIT)
      context.addIssue({
        code: 'custom',
        message: 'Component bundle exceeds 8 MB',
        path: ['bundle'],
      });
    if (new Set(value.events).size !== value.events.length)
      context.addIssue({
        code: 'custom',
        message: 'Component event names must be unique',
        path: ['events'],
      });
    try {
      const manifest = componentManifestSchema.parse(
        JSON.parse(value.files['manifest.json'] ?? 'null'),
      );
      if (!Object.hasOwn(value.files, manifest.entry))
        context.addIssue({
          code: 'custom',
          message: 'Manifest entry is missing from component sources',
          path: ['files'],
        });
      if (
        manifest.styles &&
        (!manifest.styles.endsWith('.css') || !Object.hasOwn(value.files, manifest.styles))
      )
        context.addIssue({
          code: 'custom',
          message: 'Manifest stylesheet is missing or is not CSS',
          path: ['files'],
        });
      if (
        manifest.events.length !== value.events.length ||
        manifest.events.some((event) => !value.events.includes(event))
      )
        context.addIssue({
          code: 'custom',
          message: 'Manifest event declarations differ from the component bundle metadata',
          path: ['events'],
        });
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Component source manifest is invalid',
        path: ['files', 'manifest.json'],
      });
    }
  });

const packageModuleSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,99}$/),
    name: z.string().min(1).max(200),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
    width: z.number().positive().max(10_000),
    height: z.number().positive().max(10_000),
    widgets: z.array(z.never()).length(0),
    exposedProps: z.record(
      propertyName,
      z
        .object({ widgetId: z.literal('$component'), property: propertyName, default: json })
        .strict(),
    ),
    implementation: reactImplementationSchema,
    propertyDefinitions: z.record(propertyName, propertyDefinitionSchema).optional(),
  })
  .strict()
  .superRefine((module, context) => {
    let manifest: z.infer<typeof componentManifestSchema>;
    try {
      manifest = componentManifestSchema.parse(
        JSON.parse(module.implementation.files['manifest.json']),
      );
    } catch {
      return;
    }
    for (const key of ['id', 'name', 'version', 'width', 'height'] as const)
      if (manifest[key] !== module[key])
        context.addIssue({
          code: 'custom',
          message: `Component ${key} differs from its source manifest`,
          path: [key],
        });
    const defaults = Object.fromEntries(
      Object.entries(module.exposedProps).map(([key, value]) => [key, value.default]),
    );
    if (
      canonicalJson(defaults) !== canonicalJson(manifest.props) ||
      Object.entries(module.exposedProps).some(([key, value]) => key !== value.property)
    )
      context.addIssue({
        code: 'custom',
        message: 'Component property defaults differ from its source manifest',
        path: ['exposedProps'],
      });
    if (
      canonicalJson((module.propertyDefinitions ?? {}) as unknown as Json) !==
      canonicalJson((manifest.propertyDefinitions ?? {}) as unknown as Json)
    )
      context.addIssue({
        code: 'custom',
        message: 'Component property definitions differ from its source manifest',
        path: ['propertyDefinitions'],
      });
  });

/** Parse only; importing this package does not execute its JavaScript. The host must obtain trust consent before mounting it. */
export function importComponentPackage(bytes: Uint8Array): ComponentModule {
  if (bytes.byteLength > COMPONENT_PACKAGE_LIMIT)
    throw new Error('Component package exceeds 16 MB');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new Error('Expected a .qgcomponent ZIP archive');
  let oversized = false;
  const files = unzipSync(bytes, {
    filter: (entry) => {
      if (entry.name !== 'module.json') return false;
      if (entry.originalSize > EXPANDED_LIMIT) {
        oversized = true;
        return false;
      }
      return true;
    },
  });
  if (oversized) throw new Error('Expanded component package exceeds 20 MB');
  if (!files['module.json']) throw new Error('Component archive is missing module.json');
  if (files['module.json'].byteLength > EXPANDED_LIMIT)
    throw new Error('Expanded component package exceeds 20 MB');
  const raw = JSON.parse(strFromU8(files['module.json']));
  if (raw && Object.hasOwn(raw, 'schemaVersion')) {
    const envelope = z
      .object({
        schemaVersion: z.literal(2),
        module: packageModuleSchema,
        resources: packageResourcesSchema.optional(),
      })
      .strict()
      .parse(raw);
    return {
      ...envelope.module,
      ...(envelope.resources ? { embeddedResourceScope: envelope.resources as ResourceScope } : {}),
    } as ComponentModule;
  }
  return packageModuleSchema.parse(raw) as ComponentModule;
}

export function exportComponentPackage(module: ComponentModule, project?: Project): Uint8Array {
  const { packageIdentity, resourceScopeId, embeddedResourceScope, ...portable } = module;
  const parsed = packageModuleSchema.parse({ ...portable, ...packageIdentity });
  const resources =
    project?.resourceScopes?.find((scope) => scope.id === resourceScopeId) ??
    embeddedResourceScope ??
    (project
      ? {
          id: `package_${module.id}`,
          theme: project.theme,
          translations: project.translations ?? {},
          locale: project.locale,
          assets: project.assets,
        }
      : undefined);
  const scopeAssets = Object.entries(resources?.assetAliases ?? {}).flatMap(([id, target]) => {
    const asset =
      project?.assets.find((asset) => asset.id === target) ??
      resources?.assets?.find((asset) => asset.id === target);
    return asset ? [{ ...asset, id }] : [];
  });
  const portableAssets = new Map<string, Project['assets'][number]>();
  for (const asset of [...(resources?.assets ?? []), ...scopeAssets, ...(project?.assets ?? [])])
    if (!portableAssets.has(asset.id)) portableAssets.set(asset.id, asset);
  const portableResources = resources
    ? packageResourcesSchema.parse({
        ...resources,
        localeVariableId: undefined,
        assetAliases: undefined,
        assets: [...portableAssets.values()],
      })
    : undefined;
  const modern = Boolean(packageIdentity || parsed.propertyDefinitions || resources);
  const json = strToU8(
    JSON.stringify(
      modern
        ? {
            schemaVersion: 2,
            module: parsed,
            ...(portableResources ? { resources: portableResources } : {}),
          }
        : parsed,
      null,
      2,
    ),
  );
  if (json.byteLength > EXPANDED_LIMIT) throw new Error('Expanded component package exceeds 20 MB');
  const bytes = zipSync({ 'module.json': json }, { level: 6 });
  if (bytes.byteLength > COMPONENT_PACKAGE_LIMIT)
    throw new Error('Component package exceeds 16 MB');
  return bytes;
}
