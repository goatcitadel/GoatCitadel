import type { GatewayRuntimeConfig } from "../../config.js";
import type { ServiceContext } from "../service-context.js";
import type { Storage } from "@goatcitadel/storage";
import type { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import type { LlmService } from "../llm-service.js";
import type { RuntimeSettings } from "../gateway-service.js";

export function buildGatewayServiceContext(input: {
  storage: Storage;
  config: GatewayRuntimeConfig;
  llmService: LlmService;
  policyEngine: ToolPolicyEngine;
  publishRealtime: ServiceContext["publishRealtime"];
  requireFeatureEnabled: (flag: keyof RuntimeSettings["features"]) => void;
  isFeatureEnabled: (flag: keyof RuntimeSettings["features"]) => boolean;
  normalizeWorkspaceId: (workspaceId?: string) => string;
}): ServiceContext {
  return {
    storage: input.storage,
    config: input.config,
    llmService: input.llmService,
    policyEngine: input.policyEngine,
    gatewaySql: input.storage.gatewaySql,
    publishRealtime: input.publishRealtime,
    requireFeatureEnabled: input.requireFeatureEnabled,
    isFeatureEnabled: input.isFeatureEnabled,
    normalizeWorkspaceId: input.normalizeWorkspaceId,
  };
}
