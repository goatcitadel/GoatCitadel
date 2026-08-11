import { useId, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { BlocksShuffleLoader } from "../../../components/BlocksShuffleLoader";
import { NativeCard, NativeList } from "../NativeRoutePageLayout";
import {
  EmptyState,
  ErrorState,
  FilterPillGroup,
  NativeButton,
  NativeMetricGrid,
  NativeSelectableList,
  NoticeBanner,
} from "../primitives";
import type { NativeLoadIssue, Notice } from "./native-helpers";
import { normalizeNativeRouteError, type NativeRouteError, type NativeRouteErrorContext } from "./native-route-errors";
import { labelDirectFormControls } from "./field-accessibility";

export function LibrarySectionShell({
  loading,
  error,
  onRetry,
  errorSecondaryAction,
  errorContext,
  persistentHeader,
  children,
}: {
  loading: boolean;
  error: NativeRouteError | null;
  /** F-M12: wired to the section's reload() so the error path offers retry. */
  onRetry?: () => void;
  errorSecondaryAction?: ReactNode;
  errorContext?: NativeRouteErrorContext;
  /** Route-truth content such as an Experimental badge that must survive loading and error states. */
  persistentHeader?: ReactNode;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <>
        {persistentHeader}
        <BlocksShuffleLoader compact label="Loading current route data…" />
      </>
    );
  }
  if (error) {
    const presentation = normalizeNativeRouteError(error, errorContext);
    return (
      <>
        {persistentHeader}
        <ErrorState
          size="inline"
          title={presentation.title}
          description={presentation.description}
          technicalDetails={presentation.technicalDetail}
          primaryAction={
            onRetry ? (
              <NativeButton variant="outline" onClick={() => onRetry()}>
                <RefreshCw size={16} />
                Retry
              </NativeButton>
            ) : undefined
          }
          secondaryActions={errorSecondaryAction}
        />
      </>
    );
  }
  return (
    <>
      {persistentHeader}
      {children}
    </>
  );
}

export function LibraryFieldGrid({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-field-grid">{children}</div>;
}

export function LibraryField({ label, children, span = 1 }: { label: string; children: ReactNode; span?: 1 | 2 }) {
  const labelId = useId();
  return (
    <label className={`mc-next-settings-field${span === 2 ? " span-2" : ""}`}>
      <span id={labelId}>{label}</span>
      {labelDirectFormControls(children, labelId)}
    </label>
  );
}

export function LibraryButtonRow({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-button-row">{children}</div>;
}

export function LibraryMetricGrid({ items }: { items: Array<{ label: string; value: string; meta?: ReactNode }> }) {
  // Delegates to the canonical NativeMetricGrid primitive.
  return <NativeMetricGrid items={items} />;
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
  // Delegates to the canonical NativeSelectableList primitive.
  return (
    <NativeSelectableList
      items={items}
      selectedId={selectedId}
      onSelect={onSelect}
      emptyLabel={emptyLabel}
      maxHeight={maxHeight}
      density={compact ? "compact" : "standard"}
    />
  );
}

export function LibraryActionList({
  items,
  emptyLabel = "Nothing here yet.",
  maxHeight = "min(50vh, 30rem)",
  compact = true,
  ariaLabel,
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
  /** Contextual landmark name. Required so pages with multiple lists never emit duplicate generic regions. */
  ariaLabel: string;
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
      role={maxHeight ? "region" : undefined}
      aria-label={maxHeight ? ariaLabel : undefined}
      tabIndex={maxHeight ? 0 : undefined}
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

export function LibraryActionCardGrid({
  items,
  emptyLabel = "No action cards available yet.",
}: {
  items: Array<{
    id?: string;
    label: string;
    value: string;
    description: string;
    meta?: string;
    actionLabel?: string;
    onClick?: () => void;
    tone?: "neutral" | "info" | "success" | "warning" | "danger";
  }>;
  emptyLabel?: string;
}) {
  if (!items.length) {
    return <LibraryEmptyState label={emptyLabel} />;
  }
  return (
    <div className="mc-next-library-action-card-grid">
      {items.map((item) => (
        <article
          key={item.id ?? `${item.label}-${item.value}`}
          className="mc-next-library-action-card"
          data-tone={item.tone ?? "neutral"}
        >
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <p>{item.description}</p>
          {item.meta ? <em>{item.meta}</em> : null}
          {item.onClick ? (
            <button type="button" className="mc-next-settings-filter" onClick={item.onClick}>
              {item.actionLabel ?? "Open"}
            </button>
          ) : item.actionLabel ? (
            <b>{item.actionLabel}</b>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function LibraryFilterBar({
  options,
  value,
  onChange,
  label = "Filter library records",
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const filterId = useId();
  return (
    <FilterPillGroup
      label={label}
      idPrefix={`library-filter-${filterId}`}
      value={value}
      options={options.map((item) => ({ value: item.id, label: item.label }))}
      onChange={onChange}
    />
  );
}

export function LibraryCodeBlock({ label, children }: { label: string; children: ReactNode }) {
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
  // Routed through the shared NoticeBanner so library notices share the same
  // a11y-correct surfaces as routes/settings (error/warning -> role=alert,
  // success/info -> polite runtime-notice channel).
  return <NoticeBanner tone={notice.tone} message={notice.message} />;
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
          <NativeButton variant="secondary" onClick={() => void onRetry()}>
            <RefreshCw size={16} />
            Retry
          </NativeButton>
        </div>
      ) : null}
    </NativeCard>
  );
}
