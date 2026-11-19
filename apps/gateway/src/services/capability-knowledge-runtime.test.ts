import { expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import { createCapabilityKnowledge } from "./capability-knowledge-runtime.js";

it("keeps discovery gated and binds runtime methods for explanations", async () => {
  const runtime = {
    config: {
      assistant: { web: { firecrawl: { enabled: false }, search: undefined } },
      toolPolicy: { sandbox: { networkAllowlist: [] } },
    } as unknown as GatewayRuntimeConfig,
    requireFeatureEnabled: vi.fn(async () => undefined),
    async requireChatSession() {
      expect(this).toBe(runtime);
      return { sessionId: "session", workspaceId: "workspace" } as ChatSessionRecord;
    },
    async inspectToolAccess() {
      expect(this).toBe(runtime);
      return { allowed: true, requiresApproval: false, reasonCodes: [] };
    },
    async getChatSessionPrefs() {
      expect(this).toBe(runtime);
      return { toolAutonomy: "safe_auto" as const, planningMode: "off" as const };
    },
  };
  const listCatalog = vi.fn(async () => [
    {
      capabilityId: "tool:fs.read",
      kind: "tool" as const,
      category: "built_in" as const,
      title: "fs.read",
      summary: "Read files",
      toolName: "fs.read",
      callable: true,
    },
  ]);
  const knowledge = createCapabilityKnowledge({
    runtime,
    skills: { listCatalog, listSkills: vi.fn(async () => []) },
    connectors: () => undefined,
    codeMode: {
      getCodeModeReadiness: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    },
    profiles: { findByTurn: vi.fn(async () => undefined) },
    lifecycle: { list: vi.fn(async () => []) },
  });
  const request = {
    toolName: "capabilities.explain",
    sessionId: "session",
    agentId: "assistant",
    args: { query: "fs.read" },
  };
  const explained = await knowledge.explanation.explain(request);
  expect(explained.capabilities[0]?.state).toBe("ready");
  expect(explained.issues.length).toBeGreaterThan(0);
  expect(runtime.requireFeatureEnabled).not.toHaveBeenCalled();
  await knowledge.discovery.discover(request);
  expect(runtime.requireFeatureEnabled).toHaveBeenCalledWith("boundedToolExposureV1Enabled");
  expect(listCatalog).toHaveBeenCalledWith("callable", "workspace");
});
