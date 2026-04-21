import {
  SPACE_META,
  VISIBLE_SPACE_PAGES,
  type ResolvedRoute,
  type Space,
  type VisiblePage,
} from "../content/page-registry";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";

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

/** Pages excluded from the nav rail for operate space — handled via in-page mode tabs */
const OPERATE_INLINE_PAGES = new Set(["chat", "cowork", "code"]);

export function ShellNavRail({
  route,
  visiblePage,
  navMode,
  approvalsCount,
  onSelectSpace,
  onSelectVisiblePage,
  onCycleNavMode,
}: {
  route: ResolvedRoute;
  visiblePage: VisiblePage;
  navMode: ShellNavMode;
  approvalsCount: number;
  onSelectSpace: (space: Space) => void;
  onSelectVisiblePage: (page: VisiblePage) => void;
  onCycleNavMode: () => void;
}) {
  const showLabels = navMode !== "icon";
  const showDescriptions = navMode === "expanded";

  /** For operate space, only show Tasks + Approvals (modes handled inline) */
  const currentSpacePages = VISIBLE_SPACE_PAGES[route.space].filter((item) => !OPERATE_INLINE_PAGES.has(item.page));

  return (
    <aside
      className={cn("shell-nav-rail mc-shell-nav-rail", `shell-nav-rail-${navMode}`)}
      aria-label="Mission Control navigation"
    >
      <div className="shell-nav-rail-head mc-shell-nav-rail-head">
        {showLabels ? (
          <div className="shell-nav-rail-copy">
            <p className="shell-bar-kicker">Mission Control</p>
            <p className="shell-nav-rail-title">Navigation</p>
          </div>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gc-nav-button gc-nav-tier-chip shell-nav-rail-toggle"
          onClick={onCycleNavMode}
          aria-label="Cycle rail density"
          title="Cycle rail density"
        >
          {navMode === "expanded" ? "Compact" : navMode === "compact" ? "Icon" : "Expand"}
        </Button>
      </div>
      <Separator className="bg-border/60" />
      <ScrollArea className="mc-shell-nav-rail-scroll">
        {/* Spaces */}
        <div className="shell-nav-rail-section">
          {showLabels ? <p className="shell-nav-rail-label">Spaces</p> : null}
          <div className="shell-nav-rail-list shell-nav-rail-space-list">
            {(Object.keys(SPACE_META) as Space[]).map((space) => {
              const meta = SPACE_META[space];
              const shortLabel = meta.label.slice(0, 1);
              return (
                <Button
                  key={space}
                  type="button"
                  variant="ghost"
                  className={cn(
                    "gc-nav-button shell-nav-rail-item shell-nav-rail-space justify-start whitespace-normal text-left",
                    route.space === space && "active",
                  )}
                  onClick={() => onSelectSpace(space)}
                  aria-current={route.space === space ? "page" : undefined}
                  aria-label={meta.label}
                  title={meta.label}
                >
                  <Badge variant="outline" className="shell-nav-rail-badge" aria-hidden="true">
                    {shortLabel}
                  </Badge>
                  {showLabels ? (
                    <span className="shell-nav-rail-item-copy">
                      <span className="shell-nav-rail-item-label">{meta.label}</span>
                      {showDescriptions ? <span className="shell-nav-rail-item-note">{meta.description}</span> : null}
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
        </div>

        {/* Pages for current space */}
        {currentSpacePages.length > 0 ? (
          <div className="shell-nav-rail-section">
            {showLabels ? <p className="shell-nav-rail-label">{SPACE_META[route.space].label}</p> : null}
            <div className="shell-nav-rail-list">
              {currentSpacePages.map((item) => {
                const isApprovals = item.page === "approvals";
                const badgeLabel = item.label.slice(0, navMode === "compact" ? 1 : 2).toUpperCase();
                return (
                  <Button
                    key={item.page}
                    type="button"
                    variant="ghost"
                    className={cn(
                      "gc-nav-button shell-nav-rail-item shell-nav-rail-page justify-start whitespace-normal text-left",
                      visiblePage === item.page && "active",
                    )}
                    onClick={() => onSelectVisiblePage(item.page)}
                    aria-current={visiblePage === item.page ? "page" : undefined}
                    aria-label={item.label}
                    title={item.label}
                  >
                    <Badge variant="outline" className="shell-nav-rail-badge" aria-hidden="true">
                      {badgeLabel}
                    </Badge>
                    {showLabels ? (
                      <span className="shell-nav-rail-item-copy">
                        <span className="shell-nav-rail-item-label">{item.label}</span>
                        {isApprovals && approvalsCount > 0 ? (
                          <span
                            className="shell-nav-rail-item-note signal-approvals-count"
                            aria-label={`${approvalsCount} pending`}
                          >
                            {approvalsCount} pending
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}
      </ScrollArea>
    </aside>
  );
}
