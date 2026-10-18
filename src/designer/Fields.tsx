import { useEffect, useState, type ReactNode } from 'react';
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
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="number"
      aria-label={label}
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (!text.trim()) return;
        const number = Number(text);
        if (Number.isFinite(number) && number >= (min ?? -Infinity) && number <= (max ?? Infinity))
          onChange(number);
      }}
      onBlur={() => {
        const number = Number(draft);
        if (!draft.trim() || !Number.isFinite(number)) {
          setDraft(String(value));
          return;
        }
        const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, number));
        setDraft(String(clamped));
        if (clamped !== value) onChange(clamped);
      }}
      onKeyDown={(event) => {
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
