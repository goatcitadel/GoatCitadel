import { describe, expect, it } from "vitest";

import { BUILTIN_AGENT_ROSTER, buildAgentDirectory, inferRoleId, type RuntimeAgent } from "./agent-roster";

function agent(overrides: Partial<RuntimeAgent>): RuntimeAgent {
  return {
    agentId: overrides.agentId ?? `agent:${overrides.roleId ?? "custom"}`,
    roleId: overrides.roleId ?? "custom",
    name: overrides.name ?? "Custom Agent",
    title: overrides.title ?? "Custom Title",
    summary: overrides.summary ?? "Custom summary",
    specialties: overrides.specialties ?? ["General"],
    defaultTools: overrides.defaultTools ?? ["session.status"],
    aliases: overrides.aliases ?? [],
    status: overrides.status ?? "inactive",
    sessionCount: overrides.sessionCount ?? 0,
    activeSessions: overrides.activeSessions ?? 0,
    lastUpdatedAt: overrides.lastUpdatedAt,
    isBuiltin: overrides.isBuiltin ?? false,
    editable: overrides.editable ?? true,
    lifecycleStatus: overrides.lifecycleStatus ?? "active",
  };
}

describe("agent roster helpers", () => {
  it("resolves built-in roles from ids, names, aliases, and loose text", () => {
    expect(inferRoleId()).toBeUndefined();
    expect(inferRoleId("   ")).toBeUndefined();
    expect(inferRoleId("architect")).toBe("architect");
    expect(inferRoleId("Architect Goat")).toBe("architect");
    expect(inferRoleId("please assign a staff engineer")).toBe("architect");
    expect(inferRoleId("verification lead")).toBe("qa");
    expect(inferRoleId("operator assistant")).toBe("assistant");
    expect(inferRoleId("no matching role")).toBeUndefined();
  });

  it("returns editable fallback records when no runtime agents exist", () => {
    const records = buildAgentDirectory([]);

    expect(records).toHaveLength(BUILTIN_AGENT_ROSTER.length);
    expect(records.map((record) => record.agentId)).toContain("fallback:architect");
    expect(records.every((record) => record.status === "ready")).toBe(true);
    expect(records.every((record) => record.isBuiltin)).toBe(true);
    expect(records.every((record) => record.editable)).toBe(true);
    expect(records.find((record) => record.roleId === "coder")).toMatchObject({
      name: "Coder Goat",
      sessionCount: 0,
      activeSessions: 0,
      runtimeAgentId: undefined,
      runtimeName: undefined,
    });
  });

  it("normalizes runtime records and sorts by activity, built-in priority, then name", () => {
    const records = buildAgentDirectory([
      agent({
        agentId: "ready-custom",
        roleId: "custom",
        name: "Zulu Custom",
        sessionCount: 0,
        activeSessions: 0,
      }),
      agent({
        agentId: "idle-coder",
        roleId: "coder",
        name: "Runtime Coder",
        status: "inactive",
        sessionCount: 3,
        activeSessions: 0,
        isBuiltin: true,
      }),
      agent({
        agentId: "active-ops",
        roleId: "ops",
        name: "Runtime Ops",
        status: "active",
        sessionCount: 5,
        activeSessions: 2,
        isBuiltin: true,
      }),
      agent({
        agentId: "idle-architect",
        roleId: "architect",
        name: "Runtime Architect",
        sessionCount: 1,
        activeSessions: 0,
        isBuiltin: true,
      }),
      agent({
        agentId: "ready-alpha",
        roleId: "unknown-alpha",
        name: "Alpha Custom",
      }),
    ]);

    expect(records.map((record) => record.agentId)).toEqual([
      "active-ops",
      "idle-architect",
      "idle-coder",
      "ready-alpha",
      "ready-custom",
    ]);
    expect(records[0]).toMatchObject({
      status: "active",
      runtimeAgentId: "active-ops",
      runtimeName: "Runtime Ops",
    });
    expect(records[1]).toMatchObject({
      status: "idle",
      runtimeAgentId: undefined,
      runtimeName: "Runtime Architect",
    });
    expect(records.at(-1)).toMatchObject({
      status: "ready",
      isBuiltin: false,
      lifecycleStatus: "active",
    });
  });
});
