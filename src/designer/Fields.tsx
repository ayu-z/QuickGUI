import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="qg-field">
      <span className="qg-field-label">{label}</span>
      {children}
      {hint && <span className="qg-field-hint">{hint}</span>}
    </label>
  );
}
export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="qg-inspector-section">
      <div className="qg-section-title">
        <ChevronDown size={12} />
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  commitOnBlur = false,
  integer = false,
  mixed = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  commitOnBlur?: boolean;
  integer?: boolean;
  mixed?: boolean;
}) {
  const [draft, setDraft] = useState(mixed ? '' : String(value));
  const cancelled = useRef(false);
  useEffect(() => setDraft(mixed ? '' : String(value)), [value, mixed]);
  return (
    <input
      type="number"
      aria-label={label}
      value={draft}
      min={min}
      max={max}
      step={step}
      placeholder={mixed ? '—' : undefined}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (!text.trim()) return;
        const number = Number(text);
        if (
          !commitOnBlur &&
          Number.isFinite(number) &&
          (!integer || Number.isInteger(number)) &&
          number >= (min ?? -Infinity) &&
          number <= (max ?? Infinity)
        )
          onChange(number);
      }}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        const number = Number(draft);
        if (!draft.trim() || !Number.isFinite(number)) {
          setDraft(String(value));
          return;
        }
        const clamped = Math.max(
          min ?? -Infinity,
          Math.min(max ?? Infinity, integer ? Math.round(number) : number),
        );
        setDraft(String(clamped));
        if (clamped !== value) onChange(clamped);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && commitOnBlur) {
          cancelled.current = true;
          setDraft(mixed ? '' : String(value));
          event.currentTarget.blur();
        }
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
export function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="qg-toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      <span className="qg-toggle-track" aria-hidden="true" />
    </label>
  );
}
