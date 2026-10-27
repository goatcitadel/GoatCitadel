import { describe, expect, it } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import { onlyApprovalPostureChanged, sameConfiguration } from "./mcp-server-state-helpers.js";

function server(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "server-1",
    label: "Fixture MCP",
    transport: "stdio",
    command: "node",
    args: ["fixture.js"],
    authType: "none",
    enabled: true,
    category: "development",
    trustTier: "restricted",
    costTier: "unknown",
    policy: normalizeMcpPolicy(),
    status: "connected",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

const withPosture = (approvalPosture: "everything_asks" | "reads_free" | "nothing_asks") => ({
  policy: { ...normalizeMcpPolicy(), approvalPosture },
});
const packChange = { planId: "plan-1", revision: 1, phase: "apply" as const, created: true };

describe("onlyApprovalPostureChanged", () => {
  it("is true when the setting is the only difference, including a first choice", () => {
    expect(onlyApprovalPostureChanged(server(), server(withPosture("reads_free")))).toBe(true);
    expect(onlyApprovalPostureChanged(server(withPosture("reads_free")), server(withPosture("nothing_asks")))).toBe(
      true,
    );
    expect(sameConfiguration(server(), server(withPosture("reads_free")))).toBe(false);
  });

  it("ignores runtime state and pack bookkeeping on either side", () => {
    const previous = server({ packChange, status: "connected", connectionRevision: "a".repeat(64), lastError: "x" });
    const next = server({
      ...withPosture("reads_free"),
      status: "disconnected",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(onlyApprovalPostureChanged(previous, next)).toBe(true);
    expect(onlyApprovalPostureChanged(next, previous)).toBe(true);
  });

  it("is false when nothing differs, or when only pack bookkeeping differs", () => {
    expect(onlyApprovalPostureChanged(server(), server())).toBe(false);
    expect(onlyApprovalPostureChanged(server(withPosture("reads_free")), server(withPosture("reads_free")))).toBe(
      false,
    );
    expect(onlyApprovalPostureChanged(server({ packChange }), server())).toBe(false);
    expect(
      onlyApprovalPostureChanged(
        server({ ...withPosture("reads_free"), packChange }),
        server({ ...withPosture("reads_free"), packChange: { ...packChange, revision: 2 } }),
      ),
    ).toBe(false);
  });

  it.each([
    { args: ["other.js"] },
    { command: "other-node" },
    { enabled: false },
    { label: "Renamed" },
    { trustTier: "trusted" as const },
    { transport: "http" as const, url: "https://example.invalid/mcp" },
  ])("is false when another field changes with the setting: %j", (patch) => {
    expect(onlyApprovalPostureChanged(server(), server({ ...withPosture("reads_free"), ...patch }))).toBe(false);
  });

  it("is false when another policy field changes with the setting", () => {
    const next = server({
      policy: { ...normalizeMcpPolicy({ blockedToolPatterns: ["write*"] }), approvalPosture: "reads_free" },
    });
    expect(onlyApprovalPostureChanged(server(), next)).toBe(false);
  });
});
