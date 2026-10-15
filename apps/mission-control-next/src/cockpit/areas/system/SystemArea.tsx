import { HealthOverview } from "./HealthOverview";
import { SystemRuntime } from "./SystemRuntime";
import { SpendOverview } from "./SpendOverview";
import { SystemActivity } from "./SystemActivity";
import { SystemSessions } from "./SystemSessions";
import { SystemDashboards } from "./SystemDashboards";
import { SystemDiagnostics } from "./SystemDiagnostics";
import { SystemQuality } from "./SystemQuality";
import { SystemBrowserSessions } from "./SystemBrowserSessions";
import { SystemImprovement } from "./SystemImprovement";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { AREA_TABS } from "../../ui/area-layout";

const VIEWS = [
  { id: "health", label: "Health", path: "/system" },
  { id: "runtime", label: "Runtime", path: "/system/runtime" },
  { id: "spend", label: "Spend", path: "/system/spend" },
  { id: "quality", label: "Quality", path: "/system/quality" },
  { id: "diagnostics", label: "Diagnostics", path: "/system/diagnostics" },
  { id: "activity", label: "Activity", path: "/system/activity" },
  { id: "sessions", label: "Sessions", path: "/system/sessions" },
  { id: "dashboards", label: "Dashboards", path: "/system/dashboards" },
  { id: "browser-sessions", label: "Browser sessions", path: "/system/browser-sessions" },
] as const;

export function SystemArea() {
  const { rest, navigate } = useCockpitRoute();
  // Improvement is experimental: reachable by direct link and the Classic /ops/improvement mapping, not a tab.
  const view = rest[0] === "improvement" ? "improvement" : (VIEWS.find((item) => item.id === rest[0])?.id ?? "health");
  return (
    <>
      <nav aria-label="System views" className={AREA_TABS}>
        {VIEWS.map((item) => (
          <a
            key={item.id}
            href={item.path}
            aria-current={view === item.id ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(item.path);
            }}
            className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-fg-secondary hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg"
          >
            {item.label}
          </a>
        ))}
      </nav>
      {view === "spend" ? (
        rest[1] === "details" ? (
          <SystemRuntime section="costs" />
        ) : (
          <SpendOverview />
        )
      ) : view === "quality" ? (
        <SystemQuality />
      ) : view === "diagnostics" ? (
        <SystemDiagnostics />
      ) : view === "activity" ? (
        <SystemActivity />
      ) : view === "sessions" ? (
        <SystemSessions />
      ) : view === "dashboards" ? (
        <SystemDashboards />
      ) : view === "browser-sessions" ? (
        <SystemBrowserSessions />
      ) : view === "improvement" ? (
        <SystemImprovement />
      ) : view === "runtime" ? (
        <SystemRuntime
          section={rest[1] === "diagnostics" ? "diagnostics" : rest[1] === "workers" ? "workers" : "runtime"}
        />
      ) : (
        <HealthOverview />
      )}
    </>
  );
}
