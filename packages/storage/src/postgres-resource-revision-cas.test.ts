import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ConflictError } from "@goatcitadel/contracts";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { WorkspaceRepository } from "./workspace-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real Postgres fences stale workspace and chat-project revisions",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_resource_cas_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const migrationPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: migrationPool },
    );
    let clientA: PostgresSyncDatabaseClient | undefined;
    let clientB: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      clientA = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-resource-cas-a-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientB = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-resource-cas-b-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientA.prepare("SELECT 1 AS ready").get();
      clientB.prepare("SELECT 1 AS ready").get();

      const workspacesA = new WorkspaceRepository(clientA);
      const workspacesB = new WorkspaceRepository(clientB);
      const workspace = workspacesA.create({ name: `CAS ${suffix}` });
      const staleWorkspace = workspacesB.get(workspace.workspaceId);
      assert.equal(workspacesA.updateWithRevision(workspace.workspaceId, { name: "Winner" }, 1).revision, 2);
      assert.throws(
        () => workspacesB.updateWithRevision(workspace.workspaceId, { name: "Stale" }, staleWorkspace.revision),
        (error: unknown) => error instanceof ConflictError && error.code === "WRITE_CONFLICT",
      );
      assert.equal(workspacesA.get(workspace.workspaceId).name, "Winner");

      const projectsA = new ChatProjectRepository(clientA);
      const projectsB = new ChatProjectRepository(clientB);
      const project = projectsA.create({
        workspaceId: workspace.workspaceId,
        name: "CAS Project",
        workspacePath: "repo",
      });
      const staleProject = projectsB.get(project.projectId);
      const winner = projectsA.updateWithRevision(project.projectId, { color: "teal" }, project.revision);
      assert.equal(winner.revision, 2);
      assert.throws(
        () => projectsB.hardDeleteWithRevision(project.projectId, staleProject.revision),
        (error: unknown) => error instanceof ConflictError && error.code === "WRITE_CONFLICT",
      );
      assert.equal(projectsA.get(project.projectId).color, "teal");
    } finally {
      clientB?.close();
      clientA?.close();
      await migrationPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);
