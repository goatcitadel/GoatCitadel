import { type ReactNode } from "react";

/**
 * Canonical in-body metric grid — the single home for the compact
 * "label / value / meta" stat tiles that were duplicated as
 * `SettingsMetricGrid` (settings/SettingsShared) and `LibraryMetricGrid`
 * (shared/library-primitives, used across cowork/library/ops).
 *
 * Emits the existing `mc-next-settings-metric*` classes (un-renamed; shared by
 * ~20 sites — a neutral rename is a separate CSS cleanup), so adoption is
 * visually neutral. For page-header metrics use NativePageFrame's `metrics`
 * prop instead; this is for in-card stat grids.
 */
export interface NativeMetricGridItem {
  label: string;
  value: string;
  meta?: ReactNode;
}

export function NativeMetricGrid({ items }: { items: NativeMetricGridItem[] }) {
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
