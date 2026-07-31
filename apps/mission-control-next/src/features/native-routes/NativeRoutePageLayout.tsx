import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, FlaskConical, Minus, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import type { AppRoute, ReleaseSurfaceStatus } from "@next/app/route-model";
import { recordRouteDiagnostic } from "./route-diagnostics";
import { EmptyState, ErrorState, NativeButton, type AreaSlug } from "./primitives";
import {
  normalizeNativeRouteError,
  type NativeRouteError,
  type NativeRouteErrorContext,
} from "./shared/native-route-errors";

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
      <FlaskConical size={12} aria-hidden="true" />
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
  errorSecondaryAction,
  errorContext,
  children,
  area,
  metrics,
  actions,
  lead,
  releaseStatus,
  className,
}: {
  icon?: React.ComponentType<{ className?: string; size?: number | string }>;
  kicker: string;
  title: string;
  description: string;
  loading: boolean;
  error: NativeRouteError | null;
  onRetry?: () => void;
  errorSecondaryAction?: ReactNode;
  errorContext?: NativeRouteErrorContext;
  children: ReactNode;
  area?: AreaSlug;
  metrics?: NativePageMetric[];
  actions?: ReactNode;
  /**
   * Optional promoted focal card rendered between the header and the body grid.
   * Use for a single, high-priority surface that should lead the route.
   */
  lead?: ReactNode;
  /** F-M11: renders an on-surface "Experimental" badge for experimental routes. */
  releaseStatus?: ReleaseSurfaceStatus;
  className?: string;
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
  const errorPresentation = error ? normalizeNativeRouteError(error, { resourceLabel: title, ...errorContext }) : null;

  return (
    <section ref={pageRef} className={["mc-next-directory-page", className ?? ""].filter(Boolean).join(" ")}>
      <header className="mc-next-directory-header" data-native-kicker={kicker} data-area={area}>
        {Icon ? (
          <div className="mc-next-directory-icon">
            <Icon size={20} />
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
                        {metric.delta.tone === "up" ? (
                          <TrendingUp aria-hidden="true" />
                        ) : metric.delta.tone === "down" ? (
                          <TrendingDown aria-hidden="true" />
                        ) : (
                          <Minus aria-hidden="true" />
                        )}
                        <span>{metric.delta.value}</span>
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
      {lead ? <div className="mc-next-directory-lead">{lead}</div> : null}
      {/*
       * Error / loading / children are mutually exclusive (review Finding 10). Rendering
       * children beside the error banner surfaced null/stale data as legitimate-looking
       * empty-state copy ("No Charter found") that silently contradicted the error above
       * it — an operator could not tell a real fetch failure from genuinely-empty data.
       */}
      {errorPresentation ? (
        <ErrorState
          size="inline"
          title={errorPresentation.title}
          description={errorPresentation.description}
          technicalDetails={errorPresentation.technicalDetail}
          primaryAction={
            onRetry ? (
              <NativeButton variant="outline" onClick={onRetry}>
                <RefreshCw size={16} />
                Retry
              </NativeButton>
            ) : undefined
          }
          secondaryActions={errorSecondaryAction}
        />
      ) : loading ? (
        <BlocksShuffleLoader compact label="Loading current route data…" />
      ) : (
        children
      )}
    </section>
  );
}

export function NativeGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["mc-next-directory-grid-native", className ?? ""].filter(Boolean).join(" ")}>{children}</div>;
}

export function NativeCard({
  id,
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
  id?: string;
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
      id={id}
      tabIndex={id ? -1 : undefined}
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

export type NativeSectionIndexItem = {
  id: string;
  label: string;
};

export function NativeSectionIndex({
  items,
  label = "On this page",
}: {
  items: NativeSectionIndexItem[];
  label?: string;
}) {
  const itemIds = items.map((item) => item.id).join("|");
  useEffect(() => {
    const hash = globalThis.location?.hash.replace(/^#/, "") ?? "";
    if (!hash || !itemIds.split("|").includes(hash)) {
      return;
    }
    globalThis.document?.getElementById(hash)?.scrollIntoView?.({ block: "start" });
  }, [itemIds]);

  if (items.length < 2) {
    return null;
  }
  return (
    <nav className="mc-next-section-index" aria-label={label}>
      <span>{label}</span>
      <div className="mc-next-section-index-links">
        {items.map((item) => (
          <a key={item.id} href={`#${item.id}`}>
            {item.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

export function NativeDisclosureCard({
  id,
  title,
  subtitle,
  children,
  stats,
  defaultOpen = false,
  className,
  revealOnOpen = false,
}: {
  id: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  stats?: Array<{ label: string; value: string }>;
  defaultOpen?: boolean;
  className?: string;
  revealOnOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) {
      setIsOpen(true);
    }
  }, [defaultOpen]);

  return (
    <details
      id={id}
      className={["mc-next-disclosure-card", className ?? ""].filter(Boolean).join(" ")}
      open={isOpen}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setIsOpen(nextOpen);
        if (revealOnOpen && nextOpen) {
          event.currentTarget.scrollIntoView({ block: "nearest" });
        }
      }}
    >
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="mc-next-disclosure-card-body">
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
        {children}
      </div>
    </details>
  );
}

export type NativeListItem = { title: string; meta?: string; body?: string; actions?: ReactNode };

const NATIVE_LIST_DEFAULT_WINDOW_THRESHOLD = 50;

function nativeListItemKey(item: NativeListItem, index: number): string {
  return `${item.title}-${item.meta ?? ""}-${index}`;
}

function renderNativeListItem(item: NativeListItem): ReactNode {
  return (
    <>
      <div className="mc-next-directory-list-head">
        <strong>{item.title}</strong>
        {item.meta ? <span>{item.meta}</span> : null}
      </div>
      {item.body ? <p>{item.body}</p> : null}
      {item.actions ? <div className="mc-next-runtime-actions">{item.actions}</div> : null}
    </>
  );
}

export function NativeList({
  items,
  emptyLabel = "Nothing here yet.",
  density = "standard",
  maxHeight,
  ariaLabel,
  virtualized = false,
  windowThreshold = NATIVE_LIST_DEFAULT_WINDOW_THRESHOLD,
}: {
  items: NativeListItem[];
  emptyLabel?: string;
  density?: "standard" | "compact";
  maxHeight?: string;
  ariaLabel?: string;
  /**
   * Opt in to true windowing for high-cardinality lists. Default behavior is
   * unchanged (every item rendered) so the many small/SSR-asserted callers of
   * this shared primitive are untouched. Windowing only engages when this is
   * set, `maxHeight` bounds the scroller, and the item count crosses
   * `windowThreshold` — small lists still render plainly to avoid Virtuoso's
   * measurement overhead (and so jsdom/test renders stay complete below it).
   */
  virtualized?: boolean;
  /** Item count above which a `virtualized` list switches to Virtuoso. */
  windowThreshold?: number;
}) {
  if (items.length === 0) {
    return <EmptyState size="compact" title={emptyLabel} />;
  }

  // Window only when explicitly opted in, the scroller is height-bounded, and
  // the list is actually long. Otherwise fall through to the original markup.
  if (virtualized && maxHeight && items.length > windowThreshold) {
    return (
      <Virtuoso
        data={items}
        computeItemKey={(index, item) => nativeListItemKey(item, index)}
        itemContent={(_index, item) => (
          <div
            className={[
              "mc-next-directory-list-item",
              "mc-next-directory-list-item-virtual",
              density === "compact" ? "is-compact" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {renderNativeListItem(item)}
          </div>
        )}
        className={["mc-next-directory-list-virtuoso", density === "compact" ? "is-compact" : ""]
          .filter(Boolean)
          .join(" ")}
        data-native-scroll="true"
        aria-label={ariaLabel}
        style={{ maxHeight }}
        increaseViewportBy={{ top: 320, bottom: 480 }}
      />
    );
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
        <div key={nativeListItemKey(item, index)} className="mc-next-directory-list-item">
          {renderNativeListItem(item)}
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
        "mc-next-directory-quickjump-card",
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
          <NativeButton
            key={item.label}
            variant="secondary"
            className="mc-next-directory-action"
            onClick={() => {
              item.onSelect?.();
              navigate(item.route);
            }}
          >
            <span>{item.label}</span>
            <ArrowRight size={16} />
          </NativeButton>
        ))}
      </div>
    </article>
  );
}
