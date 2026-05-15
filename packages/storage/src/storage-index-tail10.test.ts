import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "./index.js";

test("Storage defaults to an in-memory sqlite database and handles empty session cleanup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-storage-tail10-"));
  const storage = new Storage({
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });

  try {
    assert.equal(storage.db.dialect, "sqlite");
    assert.equal(
      storage.runImmediateTransaction(() => "committed"),
      "committed",
    );
    assert.deepEqual(storage.deleteChatSessionData("missing-session"), {
      sessionId: "missing-session",
      deleted: false,
      cleanupRelPaths: [],
      attachments: [],
    });
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Storage honors injected database, transcript, and audit adapters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-storage-tail10-injected-"));
  const owner = new Storage({
    transcriptsDir: path.join(root, "owner-transcripts"),
    auditDir: path.join(root, "owner-audit"),
  });
  const transcripts = {
    append: async () => 0,
    read: async () => [],
    delete: async () => undefined,
  };
  const audit = {
    append: async () => undefined,
    list: async () => [],
  };
  const storage = new Storage({
    db: owner.db,
    transcripts: transcripts as never,
    audit: audit as never,
    transcriptsDir: path.join(root, "unused-transcripts"),
    auditDir: path.join(root, "unused-audit"),
  });

  try {
    assert.equal(storage.db, owner.db);
    assert.equal(storage.transcripts, transcripts);
    assert.equal(storage.audit, audit);
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
