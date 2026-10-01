import { buildNavigationTarget, isRailItemActive, type AppRoute, type RailItem } from "./route-model";

export interface RailGroupTabsSection {
  id: string;
  label?: string;
  items: RailItem[];
}

export function RailGroupTabs({
  route,
  sections,
  navigate,
}: {
  route: AppRoute;
  sections: readonly RailGroupTabsSection[];
  navigate: (route: AppRoute) => void;
}) {
  const active = sections.find((section) => section.items.some((item) => isRailItemActive(route, item)));
  if (!active?.label || active.items.length < 2) return null;

  return (
    <nav className="mc-next-section-tabs" aria-label={`${active.label} sections`}>
      {active.items.map((item) => {
        const current = isRailItemActive(route, item);
        return (
          <button
            key={item.id}
            type="button"
            className={`mc-next-section-tab${current ? " active" : ""}`}
            aria-current={current ? "page" : undefined}
            onClick={() => navigate(buildNavigationTarget(route, item))}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
