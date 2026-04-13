import {
  PAGE_META,
  SPACE_META,
  VISIBLE_SPACE_PAGES,
  type OperatePage,
  type ResolvedRoute,
  type Space,
  type VisiblePage,
} from "../content/page-registry";

export type ShellNavMode = "expanded" | "compact" | "icon";

export function cycleShellNavMode(mode: ShellNavMode): ShellNavMode {
  if (mode === "expanded") {
    return "compact";
  }
  if (mode === "compact") {
    return "icon";
  }
  return "expanded";
}

export function ShellNavRail({
  route,
  visiblePage,
  navMode,
  onSelectSpace,
  onSelectOperatePage,
  onSelectVisiblePage,
  onCycleNavMode,
  detailAvailable,
  detailOpen,
  onToggleDetail,
}: {
  route: ResolvedRoute;
  visiblePage: VisiblePage;
  navMode: ShellNavMode;
  onSelectSpace: (space: Space) => void;
  onSelectOperatePage: (page: OperatePage) => void;
  onSelectVisiblePage: (page: VisiblePage) => void;
  onCycleNavMode: () => void;
  detailAvailable: boolean;
  detailOpen: boolean;
  onToggleDetail: () => void;
}) {
  const showLabels = navMode !== "icon";
  const showDescriptions = navMode === "expanded";
  const operatePageItems =
    route.space === "operate"
      ? (["surface", "tasks", "approvals"] as const).map((page) => ({
          page,
          label: PAGE_META[page].label,
          note:
            page === "surface"
              ? "Chat, Cowork, and Code stay in the segmented mode control."
              : PAGE_META[page].description,
          active: route.page === page,
        }))
      : [];

  return (
    <aside className={`shell-nav-rail shell-nav-rail-${navMode}`} aria-label="Mission Control navigation">
      <div className="shell-nav-rail-head">
        {showLabels ? (
          <div className="shell-nav-rail-copy">
            <p className="shell-bar-kicker">Mission Control</p>
            <p className="shell-nav-rail-title">Operator rail</p>
          </div>
        ) : null}
        <button
          type="button"
          className="gc-nav-button gc-nav-tier-chip shell-nav-rail-toggle"
          onClick={onCycleNavMode}
          aria-label="Cycle rail density"
          title="Cycle rail density"
        >
          {navMode === "expanded" ? "Compact" : navMode === "compact" ? "Icon" : "Expand"}
        </button>
      </div>

      <div className="shell-nav-rail-section">
        <p className="shell-nav-rail-label">Spaces</p>
        <div className="shell-nav-rail-list shell-nav-rail-space-list">
          {(Object.keys(SPACE_META) as Space[]).map((space) => {
            const meta = SPACE_META[space];
            const shortLabel = meta.label.slice(0, 1);
            return (
              <button
                key={space}
                type="button"
                className={`gc-nav-button shell-nav-rail-item shell-nav-rail-space${route.space === space ? " active" : ""}`}
                onClick={() => onSelectSpace(space)}
                aria-current={route.space === space ? "page" : undefined}
                aria-label={meta.label}
                title={meta.label}
              >
                <span className="shell-nav-rail-badge" aria-hidden="true">
                  {shortLabel}
                </span>
                {showLabels ? (
                  <span className="shell-nav-rail-item-copy">
                    <span className="shell-nav-rail-item-label">{meta.label}</span>
                    {showDescriptions ? <span className="shell-nav-rail-item-note">{meta.description}</span> : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="shell-nav-rail-section">
        <p className="shell-nav-rail-label">{SPACE_META[route.space].label}</p>
        <div className="shell-nav-rail-list">
          {route.space === "operate"
            ? operatePageItems.map((item) => (
                <button
                  key={item.page}
                  type="button"
                  className={`gc-nav-button shell-nav-rail-item shell-nav-rail-page${item.active ? " active" : ""}`}
                  onClick={() => onSelectOperatePage(item.page)}
                  aria-current={item.active ? "page" : undefined}
                  aria-label={item.label}
                  title={item.label}
                >
                  <span className="shell-nav-rail-badge" aria-hidden="true">
                    {item.label.slice(0, navMode === "compact" ? 1 : 2).toUpperCase()}
                  </span>
                  {showLabels ? (
                    <span className="shell-nav-rail-item-copy">
                      <span className="shell-nav-rail-item-label">{item.label}</span>
                      {showDescriptions ? <span className="shell-nav-rail-item-note">{item.note}</span> : null}
                    </span>
                  ) : null}
                </button>
              ))
            : VISIBLE_SPACE_PAGES[route.space].map((item) => (
                <button
                  key={item.page}
                  type="button"
                  className={`gc-nav-button shell-nav-rail-item shell-nav-rail-page${visiblePage === item.page ? " active" : ""}`}
                  onClick={() => onSelectVisiblePage(item.page)}
                  aria-current={visiblePage === item.page ? "page" : undefined}
                  aria-label={item.label}
                  title={item.label}
                >
                  <span className="shell-nav-rail-badge" aria-hidden="true">
                    {item.label.slice(0, navMode === "compact" ? 1 : 2).toUpperCase()}
                  </span>
                  {showLabels ? (
                    <span className="shell-nav-rail-item-copy">
                      <span className="shell-nav-rail-item-label">{item.label}</span>
                    </span>
                  ) : null}
                </button>
              ))}
        </div>
      </div>

      {detailAvailable ? (
        <div className="shell-nav-rail-section shell-nav-rail-section-secondary">
          <button
            type="button"
            className={`gc-nav-button shell-nav-rail-item shell-nav-rail-detail${detailOpen ? " active" : ""}`}
            onClick={onToggleDetail}
            aria-expanded={detailOpen}
            title={detailOpen ? "Hide details" : "Show details"}
          >
            <span className="shell-nav-rail-badge" aria-hidden="true">
              ?
            </span>
            {showLabels ? (
              <span className="shell-nav-rail-item-copy">
                <span className="shell-nav-rail-item-label">{detailOpen ? "Hide details" : "Show details"}</span>
                {showDescriptions ? (
                  <span className="shell-nav-rail-item-note">Guide, glossary, trace, and page rationale.</span>
                ) : null}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
