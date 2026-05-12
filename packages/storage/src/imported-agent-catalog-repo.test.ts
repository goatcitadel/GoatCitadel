import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ImportedAgentCatalogRepository } from "./imported-agent-catalog-repo.js";
import type { ImportedAgentCatalogRecord } from "@goatcitadel/contracts";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  }
});

function createRepo(): ImportedAgentCatalogRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-agent-catalog-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new ImportedAgentCatalogRepository(createDatabase({ dbPath }));
}

function buildRecord(overrides: Partial<ImportedAgentCatalogRecord> = {}): ImportedAgentCatalogRecord {
  return {
    entryId: "catalog-frontend",
    workspaceId: "default",
    division: "engineering",
    state: "disabled",
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-20T12:00:00.000Z",
    definition: {
      definitionId: "definition-frontend",
      slug: "frontend-developer",
      frontmatter: {
        name: "Frontend Developer",
        description: "Builds user interfaces",
        color: "cyan",
        services: ["vercel"],
      },
      rawMarkdown: "# Frontend Developer",
      bodyMarkdown: "## Your Core Mission\n- Ship good UI",
      sectionOrder: ["core-mission"],
      sectionMap: {
        "core-mission": {
          key: "core-mission",
          slug: "core-mission",
          heading: "Your Core Mission",
          level: 2,
          kind: "operations",
          content: "- Ship good UI",
          canonicalKey: "core-mission",
        },
      },
      parseStatus: "supported",
      parseWarnings: [],
      provenance: {
        provider: "agency_agents",
        repoUrl: "https://github.com/msitarzewski/agency-agents",
        ref: "main",
        commit: "abc123",
        path: "engineering/frontend-developer.md",
        sha256: "sha-frontend",
        importedAt: "2026-04-20T12:00:00.000Z",
      },
    },
    ...overrides,
  };
}

describe("ImportedAgentCatalogRepository", () => {
  it("upserts catalog entries and filters by workspace, division, and search", () => {
    const repo = createRepo();
    repo.upsertMany([
      buildRecord(),
      buildRecord({
        entryId: "catalog-qa",
        division: "engineering",
        definition: {
          ...buildRecord().definition,
          definitionId: "definition-qa",
          slug: "reality-checker",
          frontmatter: {
            name: "Reality Checker",
            description: "Pressure-tests delivery plans",
          },
          provenance: {
            ...buildRecord().definition.provenance,
            path: "engineering/reality-checker.md",
            sha256: "sha-qa",
          },
        },
      }),
      buildRecord({
        entryId: "catalog-marketing",
        division: "marketing",
        definition: {
          ...buildRecord().definition,
          definitionId: "definition-reddit",
          slug: "reddit-community-builder",
          frontmatter: {
            name: "Reddit Community Builder",
            description: "Builds Reddit-native audience trust",
          },
          provenance: {
            ...buildRecord().definition.provenance,
            path: "marketing/reddit-community-builder.md",
            sha256: "sha-reddit",
          },
        },
      }),
    ]);

    assert.equal(repo.list({ workspaceId: "default", limit: 10 }).length, 3);
    assert.equal(repo.list({ workspaceId: "default", division: "marketing", limit: 10 }).length, 1);
    assert.equal(repo.list({ workspaceId: "default", search: "reddit trust", limit: 10 }).length, 1);
    assert.deepEqual(repo.listDivisions("default"), ["engineering", "marketing"]);
  });

  it("tracks lifecycle state changes without mutating parse metadata", () => {
    const repo = createRepo();
    repo.upsertMany([buildRecord()]);

    const activated = repo.patchState("catalog-frontend", { state: "active" }, "2026-04-20T13:00:00.000Z");
    assert.equal(activated.state, "active");
    assert.equal(activated.activatedAt, "2026-04-20T13:00:00.000Z");
    assert.equal(activated.definition.parseStatus, "supported");

    const retired = repo.patchState("catalog-frontend", { state: "retired" }, "2026-04-20T14:00:00.000Z");
    assert.equal(retired.state, "retired");
    assert.equal(retired.retiredAt, "2026-04-20T14:00:00.000Z");
  });

  it("filters by lifecycle and parse status while validating missing or unsafe inputs", () => {
    const repo = createRepo();
    repo.upsertMany([
      buildRecord(),
      buildRecord({
        entryId: "catalog-active",
        state: "active",
        activatedAt: "2026-04-20T13:00:00.000Z",
        definition: {
          ...buildRecord().definition,
          definitionId: "definition-active",
          slug: "active-agent",
          provenance: {
            ...buildRecord().definition.provenance,
            path: "engineering/active-agent.md",
            sha256: "sha-active",
          },
        },
      }),
    ]);

    assert.throws(
      () => repo.get("missing-catalog-entry"),
      /Imported agent catalog entry missing-catalog-entry not found/,
    );
    assert.equal(repo.list({ state: "active" }).length, 1);
    assert.equal(repo.list({ parseStatus: "supported" }).length, 2);
    assert.equal(repo.list({ state: "all", parseStatus: "all", limit: Number.NaN }).length, 2);
    assert.throws(() => repo.list({ workspaceId: "bad/workspace" }), /workspaceId contains unsupported characters/);
    assert.throws(() => repo.upsertMany([buildRecord({ entryId: " " })]), /entryId is required/);

    const internal = repo as unknown as {
      listDivisionsStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.listDivisionsStmt = { all: () => [{ division: " engineering " }, { division: "" }, { division: 42 }] };
    assert.deepEqual(repo.listDivisions("default"), ["engineering"]);
  });
});
