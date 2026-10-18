import { useEffect, useRef, useState } from 'react';
import type { ComponentModule, Json, Project } from '../core/types';

export interface CustomComponentContext {
  locale: string;
  theme: Project['theme'];
  translations: Record<string, string>;
  interactive: boolean;
  width: number;
  height: number;
  t: (key: string) => string;
}
interface ComponentInstance {
  update: (props: Record<string, Json>, context: CustomComponentContext) => void;
  unmount: () => void;
}
interface ComponentEntry {
  mount: (
    container: HTMLElement,
    props: Record<string, Json>,
    emit: (event: string, payload?: Json) => void,
    context: CustomComponentContext,
  ) => ComponentInstance;
}
const entries = new Map<string, Promise<ComponentEntry>>();
async function loadComponent(bundle: string): Promise<ComponentEntry> {
  let loading = entries.get(bundle);
  if (!loading) {
    const url = URL.createObjectURL(new Blob([bundle], { type: 'text/javascript' }));
    loading = import(/* @vite-ignore */ url)
      .then((entry: ComponentEntry) => {
        if (typeof entry.mount !== 'function')
          throw new Error('The component bundle must export mount()');
        return entry;
      })
      .catch((error) => {
        entries.delete(bundle);
        throw error;
      })
      .finally(() => URL.revokeObjectURL(url));
    entries.set(bundle, loading);
    if (entries.size > 8) entries.delete(entries.keys().next().value!);
  }
  return loading;
}

export function CustomComponent({
  module,
  props,
  project,
  locale = project.locale,
  interactive,
  width,
  height,
  onEmit,
}: {
  module: ComponentModule;
  props: Record<string, Json>;
  project: Project;
  locale?: string;
  interactive: boolean;
  width: number;
  height: number;
  onEmit: (event: string, payload: Json) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<ComponentInstance | null>(null);
  const [error, setError] = useState('');
  const context: CustomComponentContext = {
    locale,
    interactive,
    width,
    height,
    theme: { mode: project.theme.mode, tokens: { ...project.theme.tokens } },
    translations: { ...project.translations?.[locale] },
    t: (key) =>
      project.translations?.[locale]?.[key] ?? project.translations?.[project.locale]?.[key] ?? key,
  };
  const latest = useRef({ props, context, onEmit, events: module.implementation?.events ?? [] });
  latest.current = { props, context, onEmit, events: module.implementation?.events ?? [] };
  const bundle = module.implementation?.bundle;
  useEffect(() => {
    if (!bundle || !host.current) return;
    const container = host.current;
    let cancelled = false;
    let mounted: ComponentInstance | null = null;
    setError('');
    void loadComponent(bundle)
      .then((entry) => {
        if (cancelled) return;
        const current = latest.current;
        mounted = entry.mount(
          container,
          structuredClone(current.props),
          (event, payload = null) => {
            if (cancelled || !latest.current.context.interactive) return;
            if (!latest.current.events.includes(event)) {
              setError(`Undeclared component event: ${event}`);
              return;
            }
            try {
              const serialized = JSON.stringify(payload);
              if (serialized === undefined || serialized.length > 100_000)
                throw new Error('Component event payload must be JSON within 100 KB');
              latest.current.onEmit(event, JSON.parse(serialized) as Json);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          },
          current.context,
        );
        if (
          !mounted ||
          typeof mounted.update !== 'function' ||
          typeof mounted.unmount !== 'function'
        )
          throw new Error('Component mount() must return update() and unmount()');
        instance.current = mounted;
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      try {
        mounted?.unmount();
      } catch (cause) {
        console.error('Component cleanup failed', cause);
      }
      if (instance.current === mounted) instance.current = null;
    };
  }, [bundle]);
  useEffect(() => {
    try {
      instance.current?.update(structuredClone(props), context);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [props, project.theme, project.translations, locale, interactive, width, height]);

  return (
    <div
      style={{ width: '100%', height: '100%', position: 'relative' }}
      data-qg-component={module.id}
    >
      <div
        ref={host}
        inert={!interactive}
        style={{ width: '100%', height: '100%', overflow: 'hidden' }}
      />
      {error && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            padding: 12,
            color: '#f87171',
            background: '#271d20',
            fontSize: 11,
            overflow: 'auto',
          }}
        >
          <strong>{locale === 'zh-CN' ? '组件运行失败' : 'Component failed'}</strong>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error}</pre>
        </div>
      )}
    </div>
  );
}
