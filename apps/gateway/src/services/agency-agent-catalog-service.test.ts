import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImportedAgentCatalogRecord } from "@goatcitadel/contracts";
import { buildCatalogSpecialistSuggestion, importAgencyCatalog } from "./agency-agent-catalog-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }),
  );
});

async function createFixtureRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-agency-fixture-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "engineering"), { recursive: true });
  await fs.mkdir(path.join(root, "marketing"), { recursive: true });
  await fs.mkdir(path.join(root, "integrations", "claude-code"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# Agency Fixture\n");
  await fs.writeFile(
    path.join(root, "engineering", "frontend-developer.md"),
    `---
name: Frontend Developer
description: Builds polished interfaces with a performance budget
color: cyan
---

# Frontend Developer

## Your Identity & Memory
- Role: Frontend specialist

## Your Core Mission
- Ship clean UI
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "marketing", "reddit-community-builder.md"),
    `---
name: Reddit Community Builder
description: Grows Reddit-native trust without sounding robotic
services:
  - reddit
---

# Reddit Community Builder

## Your Identity & Memory
- Role: Community operator

## Secret Sauce
- Custom heuristic

## Your Core Mission
- Earn trust
`,
    "utf8",
  );
  await fs.writeFile(path.join(root, "integrations", "claude-code", "README.md"), "# Not an agent\n", "utf8");
  return root;
}

function createStorage() {
  const catalog = new Map<string, ImportedAgentCatalogRecord>();
  return {
    importedAgentCatalog: {
      list(input: { workspaceId?: string; limit?: number }) {
        const workspaceId = input.workspaceId ?? "default";
        const limit = input.limit ?? 200;
        return [...catalog.values()]
          .filter((entry) => entry.workspaceId === workspaceId)
          .sort((left, right) => left.definition.slug.localeCompare(right.definition.slug))
          .slice(0, limit);
      },
      upsertMany(records: ImportedAgentCatalogRecord[]) {
        for (const record of records) {
          catalog.set(record.entryId, record);
        }
        return records;
      },
    },
    agentProfiles: {
      list() {
        return [];
      },
    },
    chatSpecialistCandidates: {
      listBySession() {
        return [];
      },
    },
  };
}

describe("agency-agent-catalog-service", () => {
  it("imports a local Agency-style repo fixture into the dormant catalog without touching the live roster", async () => {
    const repoRoot = await createFixtureRepo();
    const storage = createStorage();
    const imported = await importAgencyCatalog({
      storage: storage as never,
      workspaceId: "default",
      repoUrl: repoRoot,
      ref: "fixture",
      now: "2026-04-20T15:00:00.000Z",
    });

    const catalogEntries = storage.importedAgentCatalog.list({ workspaceId: "default", limit: 20 });
    expect(imported.importedCount).toBe(2);
    expect(imported.divisions).toEqual(["engineering", "marketing"]);
    expect(imported.parseCounts.supported).toBe(1);
    expect(imported.parseCounts.supported_with_warnings).toBe(1);
    expect(catalogEntries).toHaveLength(2);
    expect(catalogEntries[0]?.definition.provenance.path).toMatch(/\.md$/);
    expect(storage.agentProfiles.list()).toEqual([]);
    expect(storage.chatSpecialistCandidates.listBySession()).toEqual([]);
  });

  it("builds session activation suggestions as manual-only", async () => {
    const repoRoot = await createFixtureRepo();
    const storage = createStorage();
    await importAgencyCatalog({
      storage: storage as never,
      workspaceId: "default",
      repoUrl: repoRoot,
      ref: "fixture",
      now: "2026-04-20T15:00:00.000Z",
    });
    const entry = storage.importedAgentCatalog.list({ workspaceId: "default", limit: 10 })[0]!;

    const suggestion = buildCatalogSpecialistSuggestion(entry, "cowork", ["frontend", "ui"], 0.81);

    expect(suggestion.source).toBe("catalog");
    expect(suggestion.suggestedRoutingMode).toBe("manual_only");
    expect(suggestion.suggestedStatus).toBe("drafted");
    expect(suggestion.evidence[0]?.skillRef).toBe(`catalog:${entry.entryId}`);
  });
});
