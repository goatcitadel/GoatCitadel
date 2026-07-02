import { describe, expect, it } from "vitest";
import type { CapabilityScopeAssignment } from "@goatcitadel/contracts";
import { CapabilityScopeResolver, computeEffectiveSet, isCapabilityAllowed } from "./capability-scope-resolver.js";

function row(
  scopeKind: "citadel" | "workspace",
  resourceType: "skill" | "integration" | "mcp_server",
  resourceRef: string,
  enabled: boolean,
): CapabilityScopeAssignment {
  return {
    assignmentId: `id-${scopeKind}-${resourceRef}`,
    scopeKind,
    scopeId: "x",
    resourceType,
    resourceRef,
    enabled,
    createdAt: "t",
    updatedAt: "t",
  };
}

const ALL = new Set(["a", "b", "c"]);

describe("computeEffectiveSet", () => {
  it("returns ALL when both scopes inherit (non-breaking default)", () => {
    expect(computeEffectiveSet(ALL, [], [])).toBe("ALL");
  });

  it("citadel allow-list narrows; workspace inherits citadel", () => {
    const result = computeEffectiveSet(ALL, [row("citadel", "skill", "a", true)], []);
    expect(result).not.toBe("ALL");
    expect([...(result as Set<string>)].sort()).toEqual(["a"]);
  });

  it("workspace narrows within citadel (intersection)", () => {
    const result = computeEffectiveSet(
      ALL,
      [row("citadel", "skill", "a", true), row("citadel", "skill", "b", true)],
      [row("workspace", "skill", "b", true), row("workspace", "skill", "c", true)],
    );
    // c is excluded: not in citadel-effective (D4)
    expect([...(result as Set<string>)].sort()).toEqual(["b"]);
  });

  it("curated-to-empty: rows exist but all disabled → empty set", () => {
    const result = computeEffectiveSet(ALL, [row("citadel", "skill", "a", false)], []);
    expect(result).not.toBe("ALL");
    expect([...(result as Set<string>)]).toEqual([]);
  });

  it("drops dangling refs not present in the live registry", () => {
    const result = computeEffectiveSet(ALL, [row("citadel", "skill", "gone", true)], []);
    expect([...(result as Set<string>)]).toEqual([]);
  });

  it("citadel inherits, workspace curates → workspace ∩ global", () => {
    const result = computeEffectiveSet(ALL, [], [row("workspace", "skill", "a", true)]);
    expect([...(result as Set<string>)].sort()).toEqual(["a"]);
  });
});

describe("isCapabilityAllowed", () => {
  it("allows everything when ALL", () => {
    expect(isCapabilityAllowed("ALL", "anything")).toBe(true);
  });
  it("checks membership otherwise", () => {
    expect(isCapabilityAllowed(new Set(["a"]), "a")).toBe(true);
    expect(isCapabilityAllowed(new Set(["a"]), "b")).toBe(false);
  });
});

describe("CapabilityScopeResolver", () => {
  function makeResolver(rows: CapabilityScopeAssignment[], opts: { disabled?: boolean } = {}) {
    return new CapabilityScopeResolver({
      listAssignmentsForScope: (kind, id) => rows.filter((r) => r.scopeKind === kind && r.scopeId === id),
      listAllSkillIds: () => ["a", "b", "c"],
      listAllIntegrationIds: () => ["i1", "i2"],
      listAllMcpServerIds: () => ["m1", "m2"],
      isDisabled: () => Boolean(opts.disabled),
    });
  }

  it("resolves ALL for every type when unconfigured", () => {
    const r = makeResolver([]).resolve("personal", "default");
    expect(r.skills).toBe("ALL");
    expect(r.integrations).toBe("ALL");
    expect(r.mcpServers).toBe("ALL");
  });

  it("scopes mcpServers by citadel grant", () => {
    const rows: CapabilityScopeAssignment[] = [
      {
        assignmentId: "1",
        scopeKind: "citadel",
        scopeId: "personal",
        resourceType: "mcp_server",
        resourceRef: "m1",
        enabled: true,
        createdAt: "t",
        updatedAt: "t",
      },
    ];
    const r = makeResolver(rows).resolve("personal", "default");
    expect(r.mcpServers).not.toBe("ALL");
    expect([...(r.mcpServers as Set<string>)]).toEqual(["m1"]);
    expect(r.skills).toBe("ALL"); // other types untouched
  });

  it("fail-open: returns ALL when the kill-switch disables scoping", () => {
    const rows: CapabilityScopeAssignment[] = [
      {
        assignmentId: "1",
        scopeKind: "citadel",
        scopeId: "personal",
        resourceType: "mcp_server",
        resourceRef: "m1",
        enabled: true,
        createdAt: "t",
        updatedAt: "t",
      },
    ];
    const r = makeResolver(rows, { disabled: true }).resolve("personal", "default");
    expect(r.mcpServers).toBe("ALL");
  });

  it("fail-closed: returns empty capability sets when a dependency throws", () => {
    const resolver = new CapabilityScopeResolver({
      listAssignmentsForScope: () => {
        throw new Error("boom");
      },
      listAllSkillIds: () => [],
      listAllIntegrationIds: () => [],
      listAllMcpServerIds: () => [],
      isDisabled: () => false,
    });
    const r = resolver.resolve("personal", "default");
    expect([...(r.skills as Set<string>)]).toEqual([]);
    expect([...(r.integrations as Set<string>)]).toEqual([]);
    expect([...(r.mcpServers as Set<string>)]).toEqual([]);
  });
});
