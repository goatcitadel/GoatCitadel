import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConflictError } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { ManagedSourceInstallRepository } from "./managed-source-install-repo.js";

const files: string[] = [];
afterEach(() => {
  for (const file of files.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(candidate, { force: true });
  }
});

function fixture(repo: ManagedSourceInstallRepository, label: string) {
  return repo.createCandidate({
    label,
    canonicalRoot: `F:\\source\\${label}`,
    repositoryIdentitySha256: "a".repeat(64),
    baselineSha: "b".repeat(40),
    baselineTree: "c".repeat(40),
    platform: "win32",
    volumeId: "fixed-volume-f",
  });
}

describe("ManagedSourceInstallRepository", () => {
  it("keeps candidate registration CAS-bound and permits only one active v1 install", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-managed-source-${randomUUID()}.db`);
    files.push(dbPath);
    const database = createDatabase({ dbPath });
    const repo = new ManagedSourceInstallRepository(database);
    const first = fixture(repo, "primary");
    const active = repo.activate(first.installId, first.revision);
    assert.equal(active.status, "active");
    assert.equal(active.revision, 2);
    assert.equal(repo.getActive()?.installId, first.installId);
    assert.throws(() => repo.activate(first.installId, first.revision), ConflictError);

    const second = fixture(repo, "secondary");
    assert.throws(() => repo.activate(second.installId, second.revision), ConflictError);
    assert.equal(repo.deleteCandidate(second.installId, second.revision), true);
    database.close();
  });
});
