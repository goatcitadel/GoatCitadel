import { HealthOverview } from "./HealthOverview";
import { SystemRuntime } from "./SystemRuntime";
import { SpendOverview } from "./SpendOverview";
import { SpendDetails } from "./SpendDetails";
import { SystemWorkers } from "./workers/SystemWorkers";
import { SystemActivity } from "./SystemActivity";
import { SystemSessions } from "./SystemSessions";
import { SystemDashboards } from "./SystemDashboards";
import { SystemDiagnostics } from "./SystemDiagnostics";
import { SystemQuality } from "./SystemQuality";
import { SystemBrowserSessions } from "./SystemBrowserSessions";
import { SystemImprovement } from "./SystemImprovement";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { AreaTabsProvider } from "../../ui/AreaHeader";

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
const TABS = VIEWS.map((item) => ({ id: item.id, label: item.label, href: item.path }));

export function SystemArea() {
  const { rest, navigate } = useCockpitRoute();
  // Improvement is experimental: reachable by direct link and the Classic /ops/improvement mapping, not a tab.
  const view = rest[0] === "improvement" ? "improvement" : (VIEWS.find((item) => item.id === rest[0])?.id ?? "health");
  return (
    <AreaTabsProvider label="System views" tabs={TABS} current={view} navigate={(href) => navigate(href)}>
      {view === "spend" ? (
        rest[1] === "details" ? (
          <SpendDetails />
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
      ) : view === "runtime" && rest[1] === "diagnostics" ? (
        // Runtime diagnostics folded into System › Diagnostics; old bookmarks keep working.
        <SystemDiagnostics />
      ) : view === "runtime" && rest[1] === "workers" ? (
        <SystemWorkers />
      ) : view === "runtime" ? (
        <SystemRuntime />
      ) : (
        <HealthOverview />
      )}
    </AreaTabsProvider>
  );
}
