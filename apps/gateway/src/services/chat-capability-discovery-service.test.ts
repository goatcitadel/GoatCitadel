import { describe, expect, it, vi } from "vitest";
import type { CapabilityCatalogEntry, ChatSessionRecord, ToolInvokeRequest } from "@goatcitadel/contracts";
import { ChatCapabilityDiscoveryService } from "./chat-capability-discovery-service.js";

function fixture() {
  const session = { sessionId: "session-1", workspaceId: "workspace-1" } as ChatSessionRecord;
  const entry: CapabilityCatalogEntry = {
    capabilityId: "calendar.read",
    title: "Read calendar",
    summary: "Calendar events",
    kind: "tool",
    category: "built_in",
    callable: true,
    toolName: "calendar.read",
  };
  const host = {
    requireEnabled: vi.fn(async () => undefined),
    requireSession: vi.fn(async () => session),
    listCatalog: vi.fn(async () => [entry]),
    listSkills: vi.fn(async () => []),
    listLifecycle: vi.fn(async () => []),
  };
  const request = {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    args: { query: "calendar", skillId: "inactive" },
  } as ToolInvokeRequest;
  return { host, request, session, service: new ChatCapabilityDiscoveryService(host) };
}

describe("Chat read-only capability discovery owner", () => {
  it("reads only the canonical workspace callable catalog and observes revocation on the next read", async () => {
    const { host, request, service } = fixture();
    expect(await service.discover(request)).toMatchObject({
      discoveryOnly: true,
      capabilities: [{ toolName: "calendar.read" }],
    });
    expect(host.listCatalog).toHaveBeenCalledWith("callable", "ALL", "workspace-1");
    host.listCatalog.mockResolvedValue([]);
    expect(await service.discover(request)).toMatchObject({ capabilities: [] });
    expect(host.requireSession).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "missing_workspace", "request_scope", "policy_scope"])(
    "refuses %s before catalog or skill reads",
    async (failure) => {
      const { host, request, session, service } = fixture();
      if (failure === "disabled") host.requireEnabled.mockRejectedValue(new Error("disabled"));
      if (failure === "missing_workspace") session.workspaceId = undefined;
      if (failure === "request_scope") request.workspaceId = "workspace-2";
      if (failure === "policy_scope") request.policyContext = { workspaceId: "workspace-2" };
      await expect(service.discover(request)).rejects.toThrow();
      await expect(service.readSkill(request)).rejects.toThrow();
      expect(host.listCatalog).not.toHaveBeenCalled();
      expect(host.listSkills).not.toHaveBeenCalled();
      expect(host.listLifecycle).not.toHaveBeenCalled();
    },
  );

  it("refuses inactive skill content rather than treating its name as authority", async () => {
    const { host, request, service } = fixture();
    await expect(service.readSkill(request)).rejects.toThrow(/not currently callable/);
    expect(host.listCatalog).toHaveBeenCalledWith("callable", "ALL", "workspace-1");
    expect(host.listSkills).toHaveBeenCalledWith("ALL", "workspace-1");
  });
});
