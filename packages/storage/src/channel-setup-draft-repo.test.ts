import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ChannelSetupDraftRepository } from "./channel-setup-draft-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepo(): ChannelSetupDraftRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-channel-drafts-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ChannelSetupDraftRepository(db);
}

describe("ChannelSetupDraftRepository", () => {
  it("creates, updates, lists and deletes drafts", () => {
    const repo = createRepo();

    const created = repo.create({
      catalogId: "channel.discord",
      connectionId: "11111111-1111-1111-1111-111111111111",
      lifecycleMode: "repair",
      label: "Discord Primary",
      enabled: true,
      draft: {
        mode: "bot",
        defaultChannelId: "123456789012345678",
      },
      hydration: {
        status: "opaque-secret",
        fieldState: {
          botToken: "configured",
          defaultChannelId: "configured",
        },
        warnings: ["Secrets are not rehydrated into the wizard."],
      },
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
    });

    assert.equal(created.catalogId, "channel.discord");
    assert.equal(created.lifecycleMode, "repair");
    assert.equal(created.hydration?.status, "opaque-secret");
    assert.equal(created.draft.defaultChannelId, "123456789012345678");

    const updated = repo.update(created.draftId, {
      enabled: false,
      label: "Discord Repair",
      draft: {
        mode: "webhook",
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        defaultChannelId: "123456789012345678",
      },
      lastFailureCategory: "credential_rejected",
      lastValidatedAt: "2026-03-29T01:00:00.000Z",
      lastTestedAt: "2026-03-29T01:05:00.000Z",
    });

    assert.equal(updated.enabled, false);
    assert.equal(updated.label, "Discord Repair");
    assert.equal(updated.lastFailureCategory, "credential_rejected");
    assert.equal(updated.lastValidatedAt, "2026-03-29T01:00:00.000Z");
    assert.equal(updated.lastTestedAt, "2026-03-29T01:05:00.000Z");
    assert.equal(updated.draft.mode, "webhook");

    const byCatalog = repo.listByCatalog("channel.discord");
    assert.equal(byCatalog.length, 1);
    assert.equal(byCatalog[0]?.draftId, created.draftId);

    const byConnection = repo.listByConnection("11111111-1111-1111-1111-111111111111");
    assert.equal(byConnection.length, 1);
    assert.equal(byConnection[0]?.draftId, created.draftId);

    const deleted = repo.delete(created.draftId);
    assert.equal(deleted, true);
    assert.equal(repo.listByCatalog("channel.discord").length, 0);
  });
});
