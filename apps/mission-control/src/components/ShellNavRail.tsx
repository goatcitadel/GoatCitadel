import {
  PAGE_META,
  SPACE_META,
  VISIBLE_SPACE_PAGES,
  type OperatePage,
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

export function ShellNavRail({
  route,
  visiblePage,
  navMode,
  onSelectSpace,
  onSelectOperatePage,
  onSelectVisiblePage,
  onCycleNavMode,
}: {
  route: ResolvedRoute;
  visiblePage: VisiblePage;
  navMode: ShellNavMode;
  onSelectSpace: (space: Space) => void;
  onSelectOperatePage: (page: OperatePage) => void;
  onSelectVisiblePage: (page: VisiblePage) => void;
  onCycleNavMode: () => void;
}) {
  const showLabels = navMode !== "icon";
  const showDescriptions = navMode === "expanded";
  const operatePageItems =
    route.space === "operate"
      ? (["surface", "tasks", "approvals"] as const).map((page) => ({
          page,
          label: PAGE_META[page].label,
          note:
            page === "surface" ? "Chat, Cowork, and Code stay in the mode switch above." : PAGE_META[page].description,
          active: route.page === page,
        }))
      : [];

  return (
    <aside
      className={cn("shell-nav-rail mc-shell-nav-rail", `shell-nav-rail-${navMode}`)}
      aria-label="Mission Control navigation"
    >
      <div className="shell-nav-rail-head mc-shell-nav-rail-head">
        {showLabels ? (
          <div className="shell-nav-rail-copy">
            <p className="shell-bar-kicker">Mission Control</p>
            <p className="shell-nav-rail-title">Operator rail</p>
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
        <div className="shell-nav-rail-section">
          <p className="shell-nav-rail-label">Spaces</p>
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

        <div className="shell-nav-rail-section">
          <p className="shell-nav-rail-label">{SPACE_META[route.space].label}</p>
          <div className="shell-nav-rail-list">
            {route.space === "operate"
              ? operatePageItems.map((item) => (
                  <Button
                    key={item.page}
                    type="button"
                    variant="ghost"
                    className={cn(
                      "gc-nav-button shell-nav-rail-item shell-nav-rail-page justify-start whitespace-normal text-left",
                      item.active && "active",
                    )}
                    onClick={() => onSelectOperatePage(item.page)}
                    aria-current={item.active ? "page" : undefined}
                    aria-label={item.label}
                    title={item.label}
                  >
                    <Badge variant="outline" className="shell-nav-rail-badge" aria-hidden="true">
                      {item.label.slice(0, navMode === "compact" ? 1 : 2).toUpperCase()}
                    </Badge>
                    {showLabels ? (
                      <span className="shell-nav-rail-item-copy">
                        <span className="shell-nav-rail-item-label">{item.label}</span>
                        {showDescriptions && item.active ? (
                          <span className="shell-nav-rail-item-note">{item.note}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </Button>
                ))
              : VISIBLE_SPACE_PAGES[route.space].map((item) => (
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
                      {item.label.slice(0, navMode === "compact" ? 1 : 2).toUpperCase()}
                    </Badge>
                    {showLabels ? (
                      <span className="shell-nav-rail-item-copy">
                        <span className="shell-nav-rail-item-label">{item.label}</span>
                      </span>
                    ) : null}
                  </Button>
                ))}
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
}
