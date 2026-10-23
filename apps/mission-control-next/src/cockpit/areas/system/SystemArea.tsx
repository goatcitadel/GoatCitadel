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
import { SYSTEM_VIEWS as VIEWS } from "./system-views";

const TABS = VIEWS.map((item) => ({ id: item.id, label: item.label, href: item.path }));

export function SystemArea() {
  const { rest, navigate } = useCockpitRoute();
  // Improvement is experimental: reachable by direct link and the Classic /ops/improvement mapping, not a tab.
  const view = rest[0] === "improvement" ? "improvement" : (VIEWS.find((item) => item.id === rest[0])?.id ?? "health");
  return (
    <AreaTabsProvider
      label="System views"
      tabs={TABS}
      current={view === "runtime" && rest[1] === "diagnostics" ? "diagnostics" : view}
      navigate={(href) => navigate(href)}
    >
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
