import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import type { AppRoute } from "@next/app/route-model";

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
  return (
    <section className="mc-next-directory-page">
      <header className="mc-next-directory-header">
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

export function NativeGrid({ children }: { children: ReactNode }) {
  return <div className="mc-next-directory-grid-native">{children}</div>;
}

export function NativeCard({
  title,
  subtitle,
  stats,
  children,
}: {
  title: string;
  subtitle: string;
  stats?: Array<{ label: string; value: string }>;
  children: ReactNode;
}) {
  return (
    <article className="mc-next-directory-card">
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
      </div>
      {children}
    </article>
  );
}

export function NativeList({
  items,
  emptyLabel = "Nothing here yet.",
}: {
  items: Array<{ title: string; meta?: string; body?: string }>;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <p className="mc-next-directory-empty">{emptyLabel}</p>;
  }
  return (
    <div className="mc-next-directory-list">
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
}: {
  title: string;
  subtitle: string;
  actions: Array<{ label: string; route: AppRoute; onSelect?: () => void }>;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
}) {
  return (
    <article className="mc-next-directory-card mc-next-directory-card-compact">
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
