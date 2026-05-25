import type React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { BlocksShuffleLoader } from "../../../components/BlocksShuffleLoader";
import { NativeCard, NativeList } from "../NativeRoutePageLayout";
import { EmptyState } from "../primitives";
import type { NativeLoadIssue, Notice } from "./native-helpers";

export function LibrarySectionShell({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  if (loading) {
    return <BlocksShuffleLoader compact label="Loading current route data…" />;
  }
  if (error) {
    return (
      <div className="mc-next-directory-alert">
        <AlertTriangle className="h-4 w-4" />
        <span>{error}</span>
      </div>
    );
  }
  return <>{children}</>;
}

export function LibraryFieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="mc-next-settings-field-grid">{children}</div>;
}

export function LibraryField({
  label,
  children,
  span = 1,
}: {
  label: string;
  children: React.ReactNode;
  span?: 1 | 2;
}) {
  return (
    <label className={`mc-next-settings-field${span === 2 ? " span-2" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function LibraryButtonRow({ children }: { children: React.ReactNode }) {
  return <div className="mc-next-settings-button-row">{children}</div>;
}

export function LibraryMetricGrid({ items }: { items: Array<{ label: string; value: string; meta?: string }> }) {
  return (
    <div className="mc-next-settings-metric-grid">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="mc-next-settings-metric">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.meta ? <p>{item.meta}</p> : null}
        </div>
      ))}
    </div>
  );
}

export function LibrarySelectableList({
  items,
  selectedId,
  onSelect,
  emptyLabel,
  maxHeight = "min(56vh, 34rem)",
  compact = true,
}: {
  items: Array<{ id: string; title: string; meta?: string; body?: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  emptyLabel: string;
  maxHeight?: string;
  compact?: boolean;
}) {
  if (!items.length) {
    return <LibraryEmptyState label={emptyLabel} />;
  }
  return (
    <div
      className={["mc-next-settings-selectable-list", compact ? "is-compact" : "", maxHeight ? "is-scrollable" : ""]
        .filter(Boolean)
        .join(" ")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`mc-next-settings-selectable${selectedId === item.id ? " active" : ""}`}
          onClick={() => onSelect(item.id)}
        >
          <div className="mc-next-settings-selectable-head">
            <strong>{item.title}</strong>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.body ? <p>{item.body}</p> : null}
        </button>
      ))}
    </div>
  );
}

export function LibraryActionList({
  items,
  emptyLabel = "Nothing here yet.",
  maxHeight = "min(50vh, 30rem)",
  compact = true,
}: {
  items: Array<{
    id?: string;
    label: string;
    description: string;
    meta?: string;
    actionLabel?: string;
    onClick?: () => void;
  }>;
  emptyLabel?: string;
  maxHeight?: string;
  compact?: boolean;
}) {
  if (!items.length) {
    return <LibraryEmptyState label={emptyLabel} />;
  }
  return (
    <div
      className={["mc-next-settings-action-list", compact ? "is-compact" : "", maxHeight ? "is-scrollable" : ""]
        .filter(Boolean)
        .join(" ")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {items.map((item) => (
        <div key={item.id ?? `${item.label}-${item.meta ?? ""}`} className="mc-next-settings-action-row">
          <div className="mc-next-settings-action-copy">
            <strong>{item.label}</strong>
            <p>{item.description}</p>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.onClick ? (
            <button type="button" className="mc-next-settings-filter" onClick={item.onClick}>
              {item.actionLabel ?? "Open"}
            </button>
          ) : item.actionLabel ? (
            <span className="mc-next-settings-chip">{item.actionLabel}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function LibraryFilterBar({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mc-next-settings-filter-bar">
      {options.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`mc-next-settings-filter${value === item.id ? " active" : ""}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function LibraryCodeBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mc-next-settings-code-block">
      <span>{label}</span>
      <pre>{children}</pre>
    </div>
  );
}

export function LibraryEmptyState({ label }: { label: string }) {
  return <EmptyState title={label} size="compact" />;
}

export function LibraryNotice({ notice }: { notice: Notice }) {
  return <div className={`mc-next-settings-notice ${notice.tone}`}>{notice.message}</div>;
}

export function LibraryLoadWarnings({ issues, onRetry }: { issues: NativeLoadIssue[]; onRetry?: () => void }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <NativeCard title="Some data could not load" subtitle="The rest of this route is still usable.">
      <NativeList
        items={issues.map((issue) => ({
          title: issue.label,
          meta: "Load warning",
          body: issue.message,
        }))}
        emptyLabel="All data loaded."
      />
      {onRetry ? (
        <div className="mc-next-settings-actions">
          <button type="button" className="mc-next-secondary-button" onClick={() => void onRetry()}>
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      ) : null}
    </NativeCard>
  );
}
