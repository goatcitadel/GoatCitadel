import {
  redactStructuredSecrets,
  type DeploymentProfile,
  type ToolAccessEvaluateRequest,
  type ToolAccessEvaluateResponse,
  type ToolCatalogEntry,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { ChatToolCallCount } from "@goatcitadel/storage";
import { evaluateDeploymentProfileToolAccess } from "../browser-runtime-guardrails.js";
import { buildToolAccessProbeArgs } from "./chat-turn-agent-runner.js";
import { CapabilityToolsService, type CapabilityToolsSources } from "./capability-tools-service.js";
import { CapabilityToolUsageService } from "./capability-tool-usage-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

const log = logger.child("capability-tools");

/** The existing owner of each source the Capabilities Tools tab reads. Each is read-only here. */
export interface CapabilityToolsOwners {
  chatToolRuns: { countCallsByToolSince(sinceIso: string): Promise<readonly ChatToolCallCount[]> };
}

/** Wires the tool call counts to the chat tool run history. */
export function composeCapabilityToolUsage({ chatToolRuns }: CapabilityToolsOwners): CapabilityToolUsageService {
  return new CapabilityToolUsageService((sinceIso) => chatToolRuns.countCallsByToolSince(sinceIso));
}

/** The existing owner of each source the Capabilities tool group list reads. Each is read-only here. */
export interface CapabilityToolListOwners {
  tools: {
    listToolCatalog(): readonly Pick<ToolCatalogEntry, "toolName" | "description" | "riskLevel">[];
    /** The non-recording probe: it writes no access decision and publishes no event. */
    inspectToolAccess(request: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateResponse>;
    resolveToolPolicyContext: CapabilityToolsSources["resolvePolicyContext"];
  };
  settings: {
    getSettings(): Promise<Pick<RuntimeSettings, "revision" | "switchedOffToolGroups" | "pluginToolGroupHolds">>;
  };
  /** The install's deployment profile, read on every list. */
  deploymentProfile(): DeploymentProfile;
  /** The folder the write tools' probes aim at, the way Chat's own probes do. */
  safeWriteFallbackDir(): string;
}

/** Wires the tool group list to the policy probe, the Settings switches and this install's deployment profile. */
export function composeCapabilityTools({
  tools,
  settings,
  deploymentProfile,
  safeWriteFallbackDir,
}: CapabilityToolListOwners): CapabilityToolsService {
  return new CapabilityToolsService({
    listToolCatalog: () => tools.listToolCatalog(),
    readSettings: async () => {
      const current = await settings.getSettings();
      return {
        revision: current.revision,
        switchedOffToolGroups: current.switchedOffToolGroups,
        // Each plugin that holds a group off, so the group can name it.
        pluginToolGroupHolds: current.pluginToolGroupHolds,
      };
    },
    resolvePolicyContext: (input) => tools.resolveToolPolicyContext(input),
    inspectAccess: (request) => tools.inspectToolAccess(request),
    probeArgs: (toolName) => buildToolAccessProbeArgs(toolName, safeWriteFallbackDir()),
    isBlockedByInstall: (toolName, args) =>
      evaluateDeploymentProfileToolAccess(deploymentProfile(), toolName, args) !== null,
    reportError: reportFailedRuleChecks,
  });
}

/** The operator sees a plain line; the real error stays in the redacted server log, once per list. */
function reportFailedRuleChecks(error: unknown, failedProbes: number): void {
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.error("tool rule checks failed", { err: redactStructuredSecrets(diagnostic).value, failedProbes });
}
