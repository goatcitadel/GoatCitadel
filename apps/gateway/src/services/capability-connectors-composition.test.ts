import { describe, expect, it, vi } from "vitest";
import type { DeploymentProfile } from "@goatcitadel/contracts";
import { composeCapabilityConnectors, type CapabilityConnectorsOwners } from "./capability-connectors-composition.js";

function owners(deploymentProfile: DeploymentProfile): CapabilityConnectorsOwners {
  return {
    mcp: { listMcpTemplates: vi.fn(async () => []), listMcpServers: vi.fn(async () => []) },
    integrations: {
      listIntegrationCatalog: vi.fn(async () => []),
      listIntegrationConnections: vi.fn(async () => []),
      getGoogleWorkspaceOAuthStatus: vi.fn(),
    },
    webSearchCredentials: { listStatuses: vi.fn(() => []) },
    settings: {
      getSettings: vi.fn(async () => ({
        chatFeatureAvailability: { staticMcp: true, durableExecution: true },
        web: { firecrawl: { enabled: false, baseUrl: "" } },
      })) as unknown as CapabilityConnectorsOwners["settings"]["getSettings"],
    },
    capabilityScope: { getView: vi.fn(async () => ({ effectiveRefs: [] }) as never) },
    deploymentProfile: () => deploymentProfile,
    recordDevDiagnostic: vi.fn(),
  };
}

describe("composeCapabilityConnectors", () => {
  it.each([
    ["local_dev", true],
    ["trusted_local", true],
    ["remote_hardened", false],
  ] as const)("reads the %s install's profile to say whether approval settings apply", async (profile, available) => {
    const response = await composeCapabilityConnectors(owners(profile)).list("default");
    expect(response.approvalReliefAvailable).toBe(available);
    expect(response.issues).toEqual([]);
  });
});
