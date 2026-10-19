import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function ProjectItemSelect({
  label,
  icon: Icon,
  items,
  value,
  onSelect,
  emptyLabel,
  children,
}: {
  label: string;
  icon: LucideIcon;
  items: readonly { id: string; name: string }[];
  value: string;
  onSelect: (id: string) => void;
  emptyLabel?: string;
  children?: ReactNode;
}) {
  return (
    <header className="project-item-select">
      <Icon size={15} aria-hidden="true" />
      <select
        aria-label={label}
        title={items.find((item) => item.id === value)?.name ?? emptyLabel}
        value={value}
        disabled={!items.length}
        onChange={(event) => onSelect(event.target.value)}
      >
        {!items.length && <option value="">{emptyLabel}</option>}
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {children}
    </header>
  );
}
