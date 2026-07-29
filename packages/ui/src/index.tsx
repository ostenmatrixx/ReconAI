import type { ReactNode } from "react";

export type OperationalStatus =
  "healthy" | "attention" | "stale" | "running" | "resolved" | "failed";

export function StatusLabel({
  status,
  children,
}: {
  readonly status: OperationalStatus;
  readonly children: ReactNode;
}) {
  const symbol: Readonly<Record<OperationalStatus, string>> = {
    healthy: "✓",
    attention: "!",
    stale: "◷",
    running: "↻",
    resolved: "✓",
    failed: "×",
  };
  return (
    <span className={`status status--${status}`}>
      <span aria-hidden="true" className="status__symbol">
        {symbol[status]}
      </span>
      {children}
    </span>
  );
}

export function EvidencePair({
  label,
  source,
  normalized,
}: {
  readonly label: string;
  readonly source: ReactNode;
  readonly normalized: ReactNode;
}) {
  return (
    <div className="evidence-pair">
      <dt>{label}</dt>
      <dd>
        <span className="evidence-pair__caption">Source</span>
        {source}
      </dd>
      <dd>
        <span className="evidence-pair__caption">Normalized</span>
        {normalized}
      </dd>
    </div>
  );
}

export function VisuallyHidden({ children }: { readonly children: ReactNode }) {
  return <span className="visually-hidden">{children}</span>;
}
