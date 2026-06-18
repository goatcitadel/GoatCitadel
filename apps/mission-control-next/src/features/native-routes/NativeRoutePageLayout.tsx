import { useEffect, useRef, type ReactNode } from "react";
import { ArrowRight, FlaskConical, RefreshCw } from "lucide-react";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import type { AppRoute, ReleaseSurfaceStatus } from "@next/app/route-model";
import { recordRouteDiagnostic } from "./route-diagnostics";
import { EmptyState, ErrorState, NativeButton, type AreaSlug } from "./primitives";

/**
 * F-M11: on-surface "Experimental" badge for routes scoped `experimental` in
 * ROUTE_RELEASE_SCOPE. Embedded route headers previously carried no scope
 * signal (only the always-visible footer pill), so an experimental surface read
 * as release-complete once you were on it.
 */
export function ReleaseScopeBadge({ status }: { status?: ReleaseSurfaceStatus }) {
  if (status !== "experimental" && status !== "needs_release_polish") {
    return null;
  }
  const label = status === "experimental" ? "Experimental" : "Needs release polish";
  return (
    <span className="mc-next-experimental-badge" data-release-status={status} role="note" aria-label={label}>
      <FlaskConical className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

export type NativePageMetric = {
  label: string;
  value: string;
  delta?: { value: string; tone: "up" | "down" | "neutral" };
  flash?: boolean;
};

export function NativePageFrame({
  icon: Icon,
  kicker,
  title,
  description,
  loading,
  error,
  onRetry,
  children,
  area,
  metrics,
  actions,
  releaseStatus,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  kicker: string;
  title: string;
  description: string;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  children: ReactNode;
  area?: AreaSlug;
  metrics?: NativePageMetric[];
  actions?: ReactNode;
  /** F-M11: renders an on-surface "Experimental" badge for experimental routes. */
  releaseStatus?: ReleaseSurfaceStatus;
}) {
  const pageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    recordRouteDiagnostic({
      level: "debug",
      event: "native.route.frame.mounted",
      message: "Native route frame mounted.",
      context: { kicker, title, loading, hasError: Boolean(error) },
      route: kicker,
    });
  }, [error, kicker, loading, title]);

  useEffect(() => {
    if (loading || typeof window === "undefined") {
      return;
    }
    const frame = pageRef.current;
    if (!frame) {
      return;
    }
    const handle = window.requestAnimationFrame(() => {
      const viewportHeight = window.innerHeight || 0;
      const routeHeight = Math.round(frame.getBoundingClientRect().height);
      const scrollContainers = frame.querySelectorAll("[data-native-scroll='true']").length;
      if (viewportHeight > 0 && routeHeight > viewportHeight * 1.75) {
        recordRouteDiagnostic({
          level: "warn",
          event: "native.route.layout.tall",
          message: "Native route is taller than the expected review viewport.",
          context: {
            title,
            routeHeight,
            viewportHeight,
            scrollContainers,
          },
          route: kicker,
        });
      }
    });
    return () => window.cancelAnimationFrame(handle);
  }, [kicker, loading, title]);

  const hasHeadRow = Boolean(metrics?.length) || Boolean(actions);

  return (
    <section ref={pageRef} className="mc-next-directory-page">
      <header className="mc-next-directory-header" data-native-kicker={kicker} data-area={area}>
        {Icon ? (
          <div className="mc-next-directory-icon">
            <Icon className="h-5 w-5" />
          </div>
        ) : null}
        <div className="mc-next-directory-copy">
          <p>{kicker}</p>
          <div className="mc-next-directory-title-row">
            <h1>{title}</h1>
            <ReleaseScopeBadge status={releaseStatus} />
          </div>
          <span>{description}</span>
        </div>
        {hasHeadRow ? (
          <div className="mc-next-directory-head-row">
            {metrics?.length ? (
              <div className="mc-next-directory-head-metrics">
                {metrics.map((metric) => (
                  <div
                    key={metric.label}
                    className="mc-next-directory-head-metric"
                    data-mc-approval-flash={metric.flash ? "true" : undefined}
                  >
                    <span className="mc-next-directory-head-metric-label">{metric.label}</span>
                    <strong className="mc-next-directory-head-metric-value">{metric.value}</strong>
                    {metric.delta ? (
                      <em className="mc-next-directory-head-metric-delta" data-tone={metric.delta.tone}>
                        {metric.delta.value}
                      </em>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {actions ? <div className="mc-next-directory-head-actions">{actions}</div> : null}
          </div>
        ) : null}
      </header>
      {error ? (
        <ErrorState
          size="inline"
          description={error}
          primaryAction={
            onRetry ? (
              <NativeButton variant="outline" onClick={onRetry}>
                <RefreshCw className="h-4 w-4" />
                Retry
              </NativeButton>
            ) : undefined
          }
        />
      ) : null}
      {loading ? <BlocksShuffleLoader compact label="Loading current route data…" /> : children}
    </section>
  );
}

export function NativeGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["mc-next-directory-grid-native", className ?? ""].filter(Boolean).join(" ")}>{children}</div>;
}

export function NativeCard({
  title,
  subtitle,
  stats,
  children,
  actions,
  headerAccessory,
  density = "standard",
  scrollBody = false,
  bodyMaxHeight,
  className,
}: {
  title: string;
  subtitle: string;
  stats?: Array<{ label: string; value: string }>;
  children: ReactNode;
  actions?: ReactNode;
  /**
   * Optional element rendered inline next to the title — used by Settings to
   * surface the "Unsaved" indicator beside the section title. Kept distinct
   * from `actions` (top-right) so the indicator stays adjacent to the heading.
   */
  headerAccessory?: ReactNode;
  density?: "standard" | "compact";
  scrollBody?: boolean;
  bodyMaxHeight?: string;
  className?: string;
}) {
  return (
    <article
      className={["mc-next-directory-card", density === "compact" ? "is-compact" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="mc-next-directory-card-head">
        <div>
          {headerAccessory ? (
            <div className="mc-next-directory-card-title-row">
              <h2>{title}</h2>
              {headerAccessory}
            </div>
          ) : (
            <h2>{title}</h2>
          )}
          <p>{subtitle}</p>
        </div>
        {stats?.length ? (
          <div className="mc-next-directory-stats">
            {stats.map((item) => (
              <div key={`${item.label}-${item.value}`}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        {actions ? <div className="mc-next-directory-card-actions">{actions}</div> : null}
      </div>
      <div
        className={scrollBody ? "mc-next-directory-card-body is-scrollable" : "mc-next-directory-card-body"}
        data-native-scroll={scrollBody ? "true" : undefined}
        style={bodyMaxHeight ? { maxHeight: bodyMaxHeight } : undefined}
      >
        {children}
      </div>
    </article>
  );
}

export function NativeList({
  items,
  emptyLabel = "Nothing here yet.",
  density = "standard",
  maxHeight,
  ariaLabel,
}: {
  items: Array<{ title: string; meta?: string; body?: string }>;
  emptyLabel?: string;
  density?: "standard" | "compact";
  maxHeight?: string;
  ariaLabel?: string;
}) {
  if (items.length === 0) {
    return <EmptyState size="compact" title={emptyLabel} />;
  }
  return (
    <div
      className={["mc-next-directory-list", density === "compact" ? "is-compact" : "", maxHeight ? "is-scrollable" : ""]
        .filter(Boolean)
        .join(" ")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
      aria-label={ariaLabel}
    >
      {items.map((item, index) => (
        <div key={`${item.title}-${item.meta ?? ""}-${index}`} className="mc-next-directory-list-item">
          <div className="mc-next-directory-list-head">
            <strong>{item.title}</strong>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.body ? <p>{item.body}</p> : null}
        </div>
      ))}
    </div>
  );
}

export function QuickJumpCard({
  title,
  subtitle,
  actions,
  navigate,
  compact = false,
}: {
  title: string;
  subtitle: string;
  actions: Array<{ label: string; route: AppRoute; onSelect?: () => void }>;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  compact?: boolean;
}) {
  return (
    <article
      className={[
        "mc-next-directory-card",
        "mc-next-directory-card-compact",
        compact ? "is-compact mc-next-directory-quickjump-inline" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="mc-next-directory-card-head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="mc-next-directory-actions">
        {actions.map((item) => (
          <button
            key={item.label}
            type="button"
            className="mc-next-directory-action"
            onClick={() => {
              item.onSelect?.();
              navigate(item.route);
            }}
          >
            <span>{item.label}</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        ))}
      </div>
    </article>
  );
}
