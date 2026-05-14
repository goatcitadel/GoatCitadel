import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import type { AppRoute } from "@next/app/route-model";
import { recordRouteDiagnostic } from "./route-diagnostics";

export function NativePageFrame({
  icon: Icon,
  kicker,
  title,
  description,
  loading,
  error,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  kicker: string;
  title: string;
  description: string;
  loading: boolean;
  error: string | null;
  children: ReactNode;
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

  return (
    <section ref={pageRef} className="mc-next-directory-page">
      <header className="mc-next-directory-header" data-native-kicker={kicker}>
        <div className="mc-next-directory-icon">
          <Icon className="h-5 w-5" />
        </div>
        <div className="mc-next-directory-copy">
          <p>{kicker}</p>
          <h1>{title}</h1>
          <span>{description}</span>
        </div>
      </header>
      {error ? (
        <div className="mc-next-directory-alert">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
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
          <h2>{title}</h2>
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
    return <p className="mc-next-directory-empty">{emptyLabel}</p>;
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
