import {
  fetchExternalConnectorServices,
  fetchExternalSideEffectRuns,
  fetchGoogleMeetPrerequisiteStatus,
  fetchGoogleMeetSessions,
  fetchIntegrationCatalog,
  fetchIntegrationConnections,
  fetchIntegrationPlugins,
  fetchSettings,
} from "@goatcitadel/mission-control-shared/api/client";
import { nativeLoad, nativeLoadIssues } from "../SettingsShared";
export async function readIntegrationSettingsSnapshot(
  activeWorkspaceId: string,
  requested: { plugins: boolean; connectors: boolean; history: boolean; meet: boolean },
) {
  const [catalog, connections, plugins, meetStatus, meetSessions, sideEffectRuns, externalConnectors, runtimeSettings] =
    await Promise.all([
      nativeLoad("Integration catalog", fetchIntegrationCatalog(), { items: [] }),
      nativeLoad("Integration connections", fetchIntegrationConnections(), { items: [] }),
      nativeLoad(
        "Integration plugins",
        requested.plugins ? fetchIntegrationPlugins() : Promise.resolve({ items: [] }),
        { items: [] },
      ),
      nativeLoad(
        "Google Meet prerequisites",
        requested.meet ? fetchGoogleMeetPrerequisiteStatus() : Promise.resolve(null),
        null,
      ),
      nativeLoad("Google Meet sessions", requested.meet ? fetchGoogleMeetSessions(50) : Promise.resolve([]), []),
      nativeLoad(
        "External side-effect runs",
        requested.history
          ? fetchExternalSideEffectRuns({ workspaceId: activeWorkspaceId, limit: 25 })
          : Promise.resolve({ items: [], summary: undefined }),
        {
          items: [],
        },
      ),
      nativeLoad(
        "Dormant external connector catalog",
        requested.connectors
          ? fetchExternalConnectorServices({ workspaceId: activeWorkspaceId, includeActions: true, limit: 50 })
          : Promise.resolve({ items: [] }),
        { items: [] },
      ),
      nativeLoad("Runtime settings", fetchSettings(), null),
    ]);
  return {
    issues: nativeLoadIssues([
      catalog,
      connections,
      plugins,
      meetStatus,
      meetSessions,
      sideEffectRuns,
      externalConnectors,
      runtimeSettings,
    ]),
    catalog: (catalog.data.items ?? []).filter((item) => item.kind !== "channel"),
    connections: (connections.data.items ?? []).filter((item) => item.kind !== "channel"),
    channelConnections: (connections.data.items ?? []).filter((item) => item.kind === "channel"),
    plugins: plugins.data.items,
    meetStatus: meetStatus.data,
    meetSessions: Array.isArray(meetSessions.data) ? meetSessions.data : [],
    sideEffectRuns: sideEffectRuns.data.items,
    sideEffectSummary: sideEffectRuns.data.summary,
    externalConnectorServices: externalConnectors.data.items,
    connectorDiagnosticsEnabled: runtimeSettings.data?.features?.connectorDiagnosticsV1Enabled === true,
  };
}
