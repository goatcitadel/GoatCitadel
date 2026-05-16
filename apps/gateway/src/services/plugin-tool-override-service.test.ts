import { describe, expect, it } from "vitest";
import { PluginToolOverrideService } from "./plugin-tool-override-service.js";

describe("PluginToolOverrideService", () => {
  const baseInput = (overrides?: Partial<{ pluginId: string; toolName: string; override: boolean }>) => ({
    pluginId: "search-plus",
    toolName: "web_search",
    override: true,
    claimedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  });

  it("records a pending override on registration", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim(baseInput());
    const claims = service.listClaims();
    expect(claims).toEqual([
      expect.objectContaining({
        pluginId: "search-plus",
        toolName: "web_search",
        status: "pending_owner_approval",
      }),
    ]);
  });

  it("approving a claim transitions status and records approver + timestamp", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim(baseInput());
    const approved = service.approveClaim({
      pluginId: "search-plus",
      toolName: "web_search",
      approvedBy: "owner-1",
    });
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("owner-1");
    expect(approved.approvedAt).toBeDefined();
  });

  it("rejects approval by non-owner with ConflictError", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim(baseInput());
    expect(() =>
      service.approveClaim({ pluginId: "search-plus", toolName: "web_search", approvedBy: "intruder-2" }),
    ).toThrow(/owner/i);
  });

  it("rejects approval for non-existent claim with ValidationError", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    expect(() => service.approveClaim({ pluginId: "missing", toolName: "missing", approvedBy: "owner-1" })).toThrow(
      /no override claim/i,
    );
  });

  it("resolveActiveOverride returns the approved plugin for the tool", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim(baseInput());
    service.approveClaim({ pluginId: "search-plus", toolName: "web_search", approvedBy: "owner-1" });
    expect(service.resolveActiveOverride("web_search")).toEqual(expect.objectContaining({ pluginId: "search-plus" }));
  });

  it("resolveActiveOverride returns undefined when claim is pending", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim(baseInput());
    expect(service.resolveActiveOverride("web_search")).toBeUndefined();
  });

  it("resolveActiveOverride returns undefined when override flag is false", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim(baseInput({ override: false }));
    service.approveClaim({ pluginId: "search-plus", toolName: "web_search", approvedBy: "owner-1" });
    expect(service.resolveActiveOverride("web_search")).toBeUndefined();
  });

  it("revoke flips status to revoked and disables override", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim(baseInput());
    service.approveClaim({ pluginId: "search-plus", toolName: "web_search", approvedBy: "owner-1" });
    const revoked = service.revokeClaim({
      pluginId: "search-plus",
      toolName: "web_search",
      revokedBy: "owner-1",
    });
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).toBeDefined();
    expect(service.resolveActiveOverride("web_search")).toBeUndefined();
  });

  it("registering again on a revoked claim re-creates a pending claim", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim(baseInput());
    service.approveClaim({ pluginId: "search-plus", toolName: "web_search", approvedBy: "owner-1" });
    service.revokeClaim({ pluginId: "search-plus", toolName: "web_search", revokedBy: "owner-1" });
    const re = service.registerOverrideClaim(baseInput());
    expect(re.status).toBe("pending_owner_approval");
  });

  it("registering again on a pending or approved claim is a no-op (returns existing)", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    const first = service.registerOverrideClaim(baseInput());
    const second = service.registerOverrideClaim(baseInput());
    expect(second).toEqual(first);
  });
});
