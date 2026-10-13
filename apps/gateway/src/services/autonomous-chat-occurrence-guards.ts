import type { ChatAutonomousTurnDeps } from "./chat-autonomous-turn-service.js";

/** Both occurrence variants use current feature flags and the same live tool owner. */
export function createAutonomousOccurrenceAuthorityHost(
  deps: Pick<ChatAutonomousTurnDeps, "storage" | "isFeatureEnabled" | "listToolCatalog">,
) {
  return {
    storage: deps.storage,
    isFeatureEnabled: (flag: string) =>
      deps.isFeatureEnabled(
        flag as "autonomyV1Disabled" | "scheduledChatTurnsV1Enabled" | "proactiveHeartbeatTurnsV1Enabled",
      ),
    listToolNames: () => deps.listToolCatalog().map((tool) => tool.toolName),
  };
}
