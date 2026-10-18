export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ComponentContext {
  locale: string;
  theme: { mode: 'light' | 'dark' | 'system'; tokens: Record<string, string> };
  translations: Record<string, string>;
  interactive: boolean;
  width: number;
  height: number;
  t: (key: string) => string;
}
export interface ComponentProps {
  props: Record<string, Json>;
  emit: (event: string, payload?: Json) => void;
  context: ComponentContext;
}
