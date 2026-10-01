import { HealthOverview } from "./HealthOverview";
import { SpendOverview } from "./SpendOverview";
import { SystemActivity } from "./SystemActivity";
import { SystemDashboards } from "./SystemDashboards";
import { SystemDiagnostics } from "./SystemDiagnostics";
import { SystemQuality } from "./SystemQuality";
import { useCockpitRoute } from "../../app/use-cockpit-route";

const VIEWS = [
  { id: "health", label: "Health", path: "/system" },
  { id: "spend", label: "Spend", path: "/system/spend" },
  { id: "quality", label: "Quality", path: "/system/quality" },
  { id: "diagnostics", label: "Diagnostics", path: "/system/diagnostics" },
  { id: "activity", label: "Activity", path: "/system/activity" },
  { id: "dashboards", label: "Dashboards", path: "/system/dashboards" },
] as const;

export function SystemArea() {
  const { rest, navigate } = useCockpitRoute();
  const view = VIEWS.find((item) => item.id === rest[0])?.id ?? "health";
  return <>
    <nav aria-label="System views" className="mx-auto flex max-w-5xl gap-1 overflow-x-auto border-b border-line-subtle px-4 pt-3 sm:px-6">
      {VIEWS.map((item) => <a
        key={item.id} href={item.path} aria-current={view === item.id ? "page" : undefined}
        onClick={(event) => { event.preventDefault(); navigate(item.path); }}
        className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-fg-secondary hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg"
      >{item.label}</a>)}
    </nav>
    {view === "spend" ? <SpendOverview /> : view === "quality" ? <SystemQuality />
      : view === "diagnostics" ? <SystemDiagnostics /> : view === "activity" ? <SystemActivity />
        : view === "dashboards" ? <SystemDashboards /> : <HealthOverview />}
  </>;
}
