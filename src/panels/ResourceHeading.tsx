import type { ReactNode } from 'react';

export function ResourceHeading({
  icon,
  title,
  summary,
  children,
}: {
  icon: ReactNode;
  title: string;
  summary: string;
  children?: ReactNode;
}) {
  return (
    <header className="resource-heading">
      <div className="resource-heading-title">
        {icon}
        <h2>{title}</h2>
      </div>
      <div className="resource-heading-actions">
        <span className="resource-heading-count">{summary}</span>
        {children}
      </div>
    </header>
  );
}
