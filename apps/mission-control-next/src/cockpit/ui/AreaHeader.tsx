import { createContext, useContext, type ReactNode } from "react";
import { OverflowTabs } from "./OverflowTabs";

export interface AreaTab {
  id: string;
  label: string;
  href: string;
}
interface AreaTabsValue {
  label: string;
  tabs: readonly AreaTab[];
  current: string;
  navigate: (href: string) => void;
}

const AreaTabsContext = createContext<AreaTabsValue | null>(null);

/**
 * An area (Inbox, Work, Capabilities, Library, System, Settings) supplies its view tabs here; the page it renders draws them in its
 * AreaHeader, under the page title, so every page reads title row then one tab row in the same column.
 */
export function AreaTabsProvider({ children, ...value }: AreaTabsValue & { children: ReactNode }) {
  return <AreaTabsContext.Provider value={value}>{children}</AreaTabsContext.Provider>;
}

/**
 * The one page header (DESIGN.md › Page anatomy): the h1, a short description and the page's actions (primary action,
 * Refresh) on one row, then the area's tab row. No eyebrow, no second navigation row; the page body uses the same
 * column (`AREA_COLUMN`).
 */
export function AreaHeader({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: ReactNode;
  /** Extra header content under the description, kept short (one status line). */
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const area = useContext(AreaTabsContext);
  return (
    <header data-area-header="" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* basis-64: on a phone the actions wrap under the title instead of squeezing it into a narrow column. */}
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="font-display text-xl font-semibold text-fg">{title}</h1>
          {description ? <p className="mt-1 max-w-3xl text-sm text-fg-secondary">{description}</p> : null}
          {children}
        </div>
        {/* min-w-0 max-w-full: a wide action row (search, links, buttons) wraps instead of overflowing a phone. */}
        {actions ? (
          <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {area ? (
        <OverflowTabs label={area.label} tabs={area.tabs} current={area.current} navigate={area.navigate} />
      ) : null}
    </header>
  );
}
