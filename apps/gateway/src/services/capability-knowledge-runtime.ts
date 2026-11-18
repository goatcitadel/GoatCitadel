import type { AsyncStorage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { CapabilityExplanationService, type CapabilityExplanationHost } from "./capability-explanation-service.js";
import {
  ChatCapabilityDiscoveryService,
  type ChatCapabilityDiscoveryHost,
} from "./chat-capability-discovery-service.js";
import { applyRuntimeBrowserBackendDefaults } from "./runtime-browser-backend-defaults.js";
import type { WorkspaceTurnSkills } from "./workspace-turn-skills.js";

interface CapabilityKnowledgePorts {
  runtime: {
    config: GatewayRuntimeConfig;
    requireFeatureEnabled(flag: "boundedToolExposureV1Enabled"): Promise<void>;
    requireChatSession: ChatCapabilityDiscoveryHost["requireSession"];
    inspectToolAccess: CapabilityExplanationHost["inspectToolAccess"];
    getChatSessionPrefs: CapabilityExplanationHost["getSessionPrefs"];
  };
  skills: Pick<WorkspaceTurnSkills, "listCatalog" | "listSkills">;
  connectors(): { list: CapabilityExplanationHost["listConnectors"] } | undefined;
  codeMode: Pick<CapabilityExplanationHost, "getCodeModeReadiness">;
  profiles: Pick<AsyncStorage["chatTurnCapabilityProfiles"], "findByTurn">;
  lifecycle: Pick<AsyncStorage["skillLifecycle"], "list">;
}

/** Read-only knowledge wiring; callbacks retain live configuration and workspace observations. */
export function createCapabilityKnowledge(ports: CapabilityKnowledgePorts) {
  const shared = {
    requireSession: (sessionId: string) => ports.runtime.requireChatSession(sessionId),
    listCatalog: (...args: Parameters<WorkspaceTurnSkills["listCatalog"]>) => ports.skills.listCatalog(...args),
  };
  const explanation = new CapabilityExplanationService({
    ...shared,
    listConnectors: async (workspaceId) => {
      const connectors = ports.connectors();
      if (!connectors) throw new Error("Capability connector observations are unavailable.");
      return await connectors.list(workspaceId);
    },
    inspectToolAccess: (request) => ports.runtime.inspectToolAccess(request),
    getSessionPrefs: (sessionId) => ports.runtime.getChatSessionPrefs(sessionId),
    getCodeModeReadiness: () => ports.codeMode.getCodeModeReadiness(),
    getTurnProfile: async (turnId) => (await ports.profiles.findByTurn(turnId)) ?? undefined,
    getSearchBackend: async () => {
      const config = ports.runtime.config;
      const probe = applyRuntimeBrowserBackendDefaults(
        {
          toolName: "browser.search",
          args: { query: "capability probe" } as Record<string, unknown>,
          agentId: "assistant",
          sessionId: "capability-probe",
        },
        config.assistant.web,
        config.toolPolicy?.sandbox?.networkAllowlist ?? [],
      );
      return {
        backend: probe.args.backend === "firecrawl" ? "firecrawl" : "native",
        fallbackToNative: probe.args.firecrawlFallbackToNative === true,
      };
    },
  });
  const discovery = new ChatCapabilityDiscoveryService({
    ...shared,
    requireEnabled: () => ports.runtime.requireFeatureEnabled("boundedToolExposureV1Enabled"),
    listSkills: (workspaceId) => ports.skills.listSkills(workspaceId),
    listLifecycle: (...args: Parameters<ChatCapabilityDiscoveryHost["listLifecycle"]>) => ports.lifecycle.list(...args),
  });
  return { explanation, discovery };
}
