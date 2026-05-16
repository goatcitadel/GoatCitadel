import { describe, expect, it, vi } from "vitest";
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

  it("does not leak claim existence to non-owners", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    expect(() => service.approveClaim({ pluginId: "missing", toolName: "missing", approvedBy: "intruder-2" })).toThrow(
      /owner/i,
    );
    // Even though the claim does not exist, a non-owner receives the owner-scope error,
    // not a "no claim" error.
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

  it("rejects approval when another plugin already has an approved override for the same toolName", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({
      pluginId: "first",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    service.approveClaim({ pluginId: "first", toolName: "web_search", approvedBy: "owner-1" });
    service.registerOverrideClaim({
      pluginId: "second",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    expect(() => service.approveClaim({ pluginId: "second", toolName: "web_search", approvedBy: "owner-1" })).toThrow(
      /already.*approved.*first/i,
    );
  });

  it("allows approving a different toolName even when one plugin already has an approved override", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({
      pluginId: "first",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    service.approveClaim({ pluginId: "first", toolName: "web_search", approvedBy: "owner-1" });
    service.registerOverrideClaim({
      pluginId: "second",
      toolName: "shell_exec",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    const approved = service.approveClaim({
      pluginId: "second",
      toolName: "shell_exec",
      approvedBy: "owner-1",
    });
    expect(approved.status).toBe("approved");
  });

  it("allows re-approving the SAME plugin's claim (idempotent)", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({
      pluginId: "first",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    const first = service.approveClaim({ pluginId: "first", toolName: "web_search", approvedBy: "owner-1" });
    // No revoke in between — same plugin claim, idempotent re-approve
    const second = service.approveClaim({ pluginId: "first", toolName: "web_search", approvedBy: "owner-1" });
    expect(second.status).toBe("approved");
    expect(second.pluginId).toBe(first.pluginId);
  });

  it("after revoke, a new plugin can be approved for the same toolName", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({
      pluginId: "first",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    service.approveClaim({ pluginId: "first", toolName: "web_search", approvedBy: "owner-1" });
    service.revokeClaim({ pluginId: "first", toolName: "web_search", revokedBy: "owner-1" });
    service.registerOverrideClaim({
      pluginId: "second",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    const approved = service.approveClaim({
      pluginId: "second",
      toolName: "web_search",
      approvedBy: "owner-1",
    });
    expect(approved.status).toBe("approved");
    expect(approved.pluginId).toBe("second");
  });

  it("registerHandler associates an executor with a plugin+tool, resolveActiveHandler returns it only when approved", async () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    const handler = vi.fn(async (_args: Record<string, unknown>) => ({
      outcome: "executed" as const,
      result: { ok: true },
      auditEventId: "evt-1",
      policyReason: "plugin override",
    }));

    // No claim yet — resolveActiveHandler returns undefined even if handler registered
    service.registerHandler({ pluginId: "p", toolName: "web_search", handler });
    expect(service.resolveActiveHandler("web_search")).toBeUndefined();

    // Pending claim — still undefined (not approved)
    service.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    expect(service.resolveActiveHandler("web_search")).toBeUndefined();

    // Approved — resolveActiveHandler returns the handler
    service.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
    const resolved = service.resolveActiveHandler("web_search");
    expect(resolved).toBeDefined();
    const result = await resolved!({ q: "test" });
    expect(result).toEqual({
      outcome: "executed",
      result: { ok: true },
      auditEventId: "evt-1",
      policyReason: "plugin override",
    });
  });

  it("resolveActiveHandler returns undefined when claim is approved but no handler registered", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    service.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
    expect(service.resolveActiveHandler("web_search")).toBeUndefined();
  });

  it("unregisterHandler removes the handler", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerHandler({ pluginId: "p", toolName: "web_search", handler: vi.fn() });
    service.unregisterHandler({ pluginId: "p", toolName: "web_search" });
    service.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    service.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
    expect(service.resolveActiveHandler("web_search")).toBeUndefined();
  });

  it("revoke disables the handler resolution even if handler still registered", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    const handler = vi.fn();
    service.registerHandler({ pluginId: "p", toolName: "web_search", handler });
    service.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    service.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
    service.revokeClaim({ pluginId: "p", toolName: "web_search", revokedBy: "owner-1" });
    expect(service.resolveActiveHandler("web_search")).toBeUndefined();
  });
});
