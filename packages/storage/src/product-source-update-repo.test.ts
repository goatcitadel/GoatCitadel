import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { ProductSourceUpdateRepository } from "./product-source-update-repo.js";

const created: string[] = [];
const A = "a".repeat(64);
const B = "b".repeat(64);

afterEach(() => {
  for (const file of created.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

describe("ProductSourceUpdateRepository", () => {
  it("persists immutable manifests and an append-only CAS journal", () => {
    const file = path.join(os.tmpdir(), `goatcitadel-source-update-${randomUUID()}.db`);
    created.push(file);
    const db = createDatabase({ dbPath: file });
    const repository = new ProductSourceUpdateRepository(db);
    const input = {
      planId: "plan-source-1",
      installId: "install-1",
      installRevision: 2,
      baseSha: A,
      baseTree: B,
      patchSha256: A,
      patchArtifactRelPath: "evolution/plan-source-1/update.patch",
      rollbackSha256: B,
      rollbackArtifactRelPath: "evolution/plan-source-1/rollback.patch",
      changedFiles: [
        { path: "apps/gateway/src/main.ts", changeKind: "modified" as const, beforeSha256: A, afterSha256: B },
      ],
      validations: [{ proofId: "git_diff_check", status: "passed" as const, exitCode: 0 }],
      riskClass: "protected_core" as const,
      protectedAreas: ["evolution_control_plane"],
      codeModeRunId: "code-run-1",
      manifestSha256: A,
    };

    const manifest = repository.createManifest(input);
    assert.equal(repository.createManifest(input).manifestId, manifest.manifestId);
    assert.deepEqual(
      repository.listEvents(manifest.manifestId).map((event) => event.eventType),
      ["staged"],
    );

    const requested = repository.appendEvent(manifest.manifestId, {
      expectedSequence: 1,
      eventType: "base_approval_requested",
      idempotencyKey: "base-approval:approval-1",
      payload: { approvalId: "approval-1" },
    });
    assert.equal(requested.sequence, 2);
    assert.equal(
      repository.appendEvent(manifest.manifestId, {
        expectedSequence: 999,
        eventType: "base_approval_requested",
        idempotencyKey: "base-approval:approval-1",
      }).eventId,
      requested.eventId,
    );
    assert.throws(
      () =>
        repository.appendEvent(manifest.manifestId, {
          expectedSequence: 1,
          eventType: "apply_launched",
          idempotencyKey: "apply:1",
        }),
      /journal changed/u,
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE product_source_update_manifests SET base_sha = ? WHERE manifest_id = ?")
          .run(B, manifest.manifestId),
      /immutable/u,
    );
    assert.throws(
      () => db.prepare("DELETE FROM product_source_update_events WHERE manifest_id = ?").run(manifest.manifestId),
      /append-only/u,
    );
    db.close();
  });
});
