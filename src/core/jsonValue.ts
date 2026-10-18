import type { Json, JsonPath, Variable } from './types';

export function cloneJson(value: Json): Json {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32) throw new Error('JSON depth exceeds 32');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null) throw new Error('Invalid JSON value');
    if (ancestors.has(item)) throw new Error('Cyclic JSON value');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error('JSON objects must have own data properties');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new Error('JSON array holes are not allowed');
        visit(item[i], depth + 1);
      }
    } else
      for (const key of Object.keys(item)) visit((item as Record<string, unknown>)[key], depth + 1);
    ancestors.delete(item);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > 1024 * 1024)
    throw new Error('JSON value exceeds 1 MiB');
  return JSON.parse(encoded) as Json;
}

export function validateJsonPath(path: unknown): asserts path is JsonPath {
  if (
    !Array.isArray(path) ||
    path.length > 32 ||
    path.some(
      (part) =>
        typeof part !== 'string' &&
        !(typeof part === 'number' && Number.isSafeInteger(part) && part >= 0),
    )
  )
    throw new Error('JSON path requires strings or nonnegative safe integer indices, depth <= 32');
}

function child(value: Json, part: string | number): Json {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Array.isArray(value) ? typeof part !== 'number' : typeof part !== 'string') ||
    !Object.hasOwn(value, part)
  )
    throw new Error(`Missing JSON path segment: ${String(part)}`);
  return (value as Record<string | number, Json>)[part];
}

export function readJsonPath(value: Json, path: JsonPath): Json {
  validateJsonPath(path);
  let current = value;
  for (const part of path) current = child(current, part);
  return cloneJson(current);
}

export function replaceJsonPath(value: Json, path: JsonPath, replacement: Json): Json {
  validateJsonPath(path);
  if (!path.length) return cloneJson(replacement);
  const next = cloneJson(value);
  let current = next;
  for (const part of path.slice(0, -1)) current = child(current, part);
  const last = path[path.length - 1];
  child(current, last);
  Object.defineProperty(current, last, {
    value: cloneJson(replacement),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return cloneJson(next);
}

export function variableValue(variable: Variable, value: Json): Json {
  if (variable.type === 'json') return cloneJson(value);
  if (typeof value !== variable.type || (typeof value === 'number' && !Number.isFinite(value)))
    throw new Error(`Expected ${variable.type}: ${variable.name}`);
  return value;
}

export function equalJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equalJson((a as Record<string, Json>)[key], (b as Record<string, Json>)[key]),
    )
  );
}

export function assertJsonValue(value: unknown): asserts value is Json {
  cloneJson(value as Json);
}
export function assertJsonPath(path: JsonPath): void {
  validateJsonPath(path);
}
export const getValueAtPath = readJsonPath;
export const setValueAtPath = replaceJsonPath;
