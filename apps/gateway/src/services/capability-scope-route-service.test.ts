import { describe, expect, it, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase, CapabilityScopeRepository } from "@goatcitadel/storage";
import type { CapabilityScopeAssignment } from "@goatcitadel/contracts";
import { CapabilityScopeResolver } from "./capability-scope-resolver.js";
import {
  CapabilityScopeRouteService,
  type CapabilityRegistryEntry,
} from "./capability-scope-route-service.js";

const createdFiles: string[] = [];

function cleanup() {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
}

function createRepo(): CapabilityScopeRepository {
  const dbPath = path.join(os.tmpdir(), `gc-capscope-svc-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new CapabilityScopeRepository(createDatabase({ dbPath }));
}

const REGISTRY: Record<string, CapabilityRegistryEntry[]> = {
  skill: [
    { ref: "skill-a", label: "Skill A" },
    { ref: "skill-b", label: "Skill B" },
    { ref: "skill-c", label: "Skill C" },
  ],
  integration: [{ ref: "conn-1", label: "Connection 1" }],
  mcp_server: [{ ref: "mcp-1", label: "MCP Server 1" }],
};

function makeResolverFromRepo(repo: CapabilityScopeRepository) {
  return new CapabilityScopeResolver({
    listAssignmentsForScope: (kind, id) => repo.listForScope(kind, id),
    listAllSkillIds: () => REGISTRY.skill.map((e) => e.ref),
    listAllIntegrationIds: () => REGISTRY.integration.map((e) => e.ref),
    listAllMcpServerIds: () => REGISTRY.mcp_server.map((e) => e.ref),
    isDisabled: () => false,
  });
}

function makeResolverFromRows(rows: CapabilityScopeAssignment[]) {
  return new CapabilityScopeResolver({
    listAssignmentsForScope: (kind, id) => rows.filter((r) => r.scopeKind === kind && r.scopeId === id),
    listAllSkillIds: () => REGISTRY.skill.map((e) => e.ref),
    listAllIntegrationIds: () => REGISTRY.integration.map((e) => e.ref),
    listAllMcpServerIds: () => REGISTRY.mcp_server.map((e) => e.ref),
    isDisabled: () => false,
  });
}

function makeSvc(repo: CapabilityScopeRepository, extraRows: CapabilityScopeAssignment[] = []) {
  // Resolver reads live from repo so updateScope effects are visible; extra static rows
  // simulate external scope assignments (e.g. citadel rows when testing workspace views).
  const resolver = extraRows.length === 0
    ? makeResolverFromRepo(repo)
    : makeResolverFromRows(extraRows);
  return new CapabilityScopeRouteService({
    repo,
    resolver,
    listRegistry: (type) => REGISTRY[type] ?? [],
    resolveCitadelId: (_workspaceId) => "personal",
  });
}

describe("CapabilityScopeRouteService.getView", () => {
  beforeEach(cleanup);

  it("unconfigured citadel → mode:inherit, all items available+inherited, effectiveRefs=all", () => {
    const repo = createRepo();
    const svc = makeSvc(repo);
    const view = svc.getView("citadel", "personal", "skill");
    expect(view.mode).toBe("inherit");
    expect(view.items).toHaveLength(3);
    expect(view.items.every((i) => i.available && i.inherited)).toBe(true);
    expect(view.effectiveRefs.sort()).toEqual(["skill-a", "skill-b", "skill-c"]);
  });

  it("after updateScope → mode:curated, effectiveRefs = only enabled refs", () => {
    const repo = createRepo();
    const svc = makeSvc(repo);
    const updated = svc.updateScope("citadel", "personal", {
      resourceType: "skill",
      assignments: [
        { resourceRef: "skill-a", enabled: true },
        { resourceRef: "skill-b", enabled: false },
      ],
    });
    expect(updated.mode).toBe("curated");
    expect(updated.effectiveRefs).toEqual(["skill-a"]);
    const viewA = updated.items.find((i) => i.resourceRef === "skill-a");
    const viewB = updated.items.find((i) => i.resourceRef === "skill-b");
    expect(viewA?.enabled).toBe(true);
    expect(viewB?.enabled).toBe(false);
    expect(updated.items.every((i) => !i.inherited)).toBe(true);
  });

  it("resetScope removes rows → mode:inherit again", () => {
    const repo = createRepo();
    const svc = makeSvc(repo);
    svc.updateScope("citadel", "personal", {
      resourceType: "skill",
      assignments: [{ resourceRef: "skill-a", enabled: true }],
    });
    const reset = svc.resetScope("citadel", "personal", "skill");
    expect(reset.mode).toBe("inherit");
    expect(reset.items.every((i) => i.inherited)).toBe(true);
  });

  it("workspace view candidate set = citadel-effective (intersection D4)", () => {
    const repo = createRepo();
    // Citadel has only skill-a in scope
    const rows: CapabilityScopeAssignment[] = [
      {
        assignmentId: "r1",
        scopeKind: "citadel",
        scopeId: "personal",
        resourceType: "skill",
        resourceRef: "skill-a",
        enabled: true,
        createdAt: "t",
        updatedAt: "t",
      },
    ];
    const svc = makeSvc(repo, rows);
    const wsView = svc.getView("workspace", "default", "skill");
    // Workspace inherits citadel — candidate set is only skill-a (in citadel scope)
    expect(wsView.items.map((i) => i.resourceRef)).toEqual(["skill-a"]);
    expect(wsView.mode).toBe("inherit");
  });
});
