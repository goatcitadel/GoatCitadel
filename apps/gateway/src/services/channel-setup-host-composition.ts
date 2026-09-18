import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import type { IntegrationDiagnosticsService } from "./integration-diagnostics-service.js";
import type { IntegrationChannelService } from "./integration-channel-service.js";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";

/** Bind setup to the same connection, diagnostics and secret custody owners. */
export function composeChannelSetupHost(
  gateway: Pick<GatewayRouteCompositionPort, "storage" | "recentChannelSetupTests" | "secretStore" | "recordDevDiagnostic">,
  integrationDiagnostics: IntegrationDiagnosticsService,
  integrationChannel: IntegrationChannelService,
): ChannelSetupHost {
  return {
    storage: gateway.storage,
    recentChannelSetupTests: gateway.recentChannelSetupTests,
    commitChannelSetupConnection: (draftId, expectedRevision, input, onCommitted) =>
      integrationChannel.finalizeChannelSetupConnection(draftId, expectedRevision, input, onCommitted),
    ...(gateway.secretStore ? { channelSecrets: new ChannelSecretCustodyService(gateway.secretStore) } : {}),
    buildIntegrationConnectionChecks: (connection) =>
      integrationDiagnostics.buildIntegrationConnectionChecks(connection),
    createIntegrationConnection: (input) => integrationChannel.createIntegrationConnection(input),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    runIntegrationConnectionLiveChecks: (connection, options) =>
      integrationDiagnostics.runIntegrationConnectionLiveChecks(connection, options),
    updateIntegrationConnection: (connectionId, patch) =>
      integrationChannel.updateIntegrationConnection(connectionId, patch),
  };
}
