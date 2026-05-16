import type { ReactNode } from "react";

export type AreaSlug = "chat" | "cowork" | "code" | "projects" | "library" | "ops" | "settings";

export type StageHeaderMetric = {
  label: string;
  value: string;
  delta?: { value: string; tone: "up" | "down" | "neutral" };
};

export type StageHeaderProps = {
  area: AreaSlug;
  eyebrow: string;
  title: string;
  description?: string;
  metrics?: StageHeaderMetric[];
  actions?: ReactNode;
  children?: ReactNode;
};

export function StageHeader({ area, eyebrow, title, description, metrics, actions, children }: StageHeaderProps) {
  const hasRow = Boolean(metrics?.length) || Boolean(actions);
  return (
    <header className="mc-next-stage-head" data-area={area}>
      <span className="mc-next-stage-head-eyebrow">
        <span className="mc-next-stage-head-eyebrow-dot" aria-hidden="true" />
        <span>{eyebrow}</span>
      </span>
      <h1>{title}</h1>
      {description ? <p className="mc-next-stage-head-sub">{description}</p> : null}
      {hasRow ? (
        <div className="mc-next-stage-head-row">
          {metrics?.length ? (
            <div className="mc-next-stage-head-metrics">
              {metrics.map((metric) => (
                <div key={metric.label} className="mc-next-stage-head-metric">
                  <span className="mc-next-stage-head-metric-label">{metric.label}</span>
                  <strong className="mc-next-stage-head-metric-value">{metric.value}</strong>
                  {metric.delta ? (
                    <em className="mc-next-stage-head-metric-delta" data-tone={metric.delta.tone}>
                      {metric.delta.value}
                    </em>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {actions ? <div className="mc-next-stage-head-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </header>
  );
}
