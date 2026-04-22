import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ChatSessionPrefsRepository } from "./chat-session-prefs-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createRepo(): ChatSessionPrefsRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-prefs-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ChatSessionPrefsRepository(db);
}

describe("ChatSessionPrefsRepository", () => {
  it("returns defaults when ensuring a missing row", () => {
    const repo = createRepo();
    const prefs = repo.ensure("sess-1");

    assert.equal(prefs.mode, "chat");
    assert.equal(prefs.planningMode, "off");
    assert.equal(prefs.webMode, "auto");
    assert.equal(prefs.memoryMode, "auto");
    assert.equal(prefs.thinkingLevel, "standard");
    assert.equal(prefs.toolAutonomy, "safe_auto");
    assert.equal(prefs.providerId, undefined);
    assert.equal(prefs.model, undefined);
    assert.equal(prefs.imageProviderId, undefined);
    assert.equal(prefs.imageModel, undefined);
    assert.equal(prefs.visionFallbackModel, undefined);
    assert.equal(prefs.orchestrationEnabled, true);
    assert.equal(prefs.orchestrationIntensity, "balanced");
    assert.equal(prefs.orchestrationVisibility, "summarized");
    assert.equal(prefs.orchestrationProviderPreference, "balanced");
    assert.equal(prefs.orchestrationReviewDepth, "standard");
    assert.equal(prefs.orchestrationParallelism, "auto");
    assert.equal(prefs.codeAutoApply, "aggressive_auto");
  });

  it("round-trips patched base chat prefs fields", () => {
    const repo = createRepo();
    const patched = repo.patch(
      "sess-1",
      {
        mode: "cowork",
        planningMode: "advisory",
        providerId: "glm",
        model: "glm-5",
        imageProviderId: "google",
        imageModel: "gemini-3.1-flash-image-preview",
        webMode: "quick",
        memoryMode: "off",
        thinkingLevel: "minimal",
        toolAutonomy: "manual",
        visionFallbackModel: "glm-vision",
        orchestrationEnabled: false,
        orchestrationIntensity: "deep",
        orchestrationVisibility: "explicit",
        orchestrationProviderPreference: "quality",
        orchestrationReviewDepth: "strict",
        orchestrationParallelism: "parallel",
        codeAutoApply: "manual",
      },
      "2026-03-07T00:00:00.000Z",
    );

    assert.equal(patched.mode, "cowork");
    assert.equal(patched.planningMode, "advisory");
    assert.equal(patched.providerId, "glm");
    assert.equal(patched.model, "glm-5");
    assert.equal(patched.imageProviderId, "google");
    assert.equal(patched.imageModel, "gemini-3.1-flash-image-preview");
    assert.equal(patched.webMode, "quick");
    assert.equal(patched.memoryMode, "off");
    assert.equal(patched.thinkingLevel, "minimal");
    assert.equal(patched.toolAutonomy, "manual");
    assert.equal(patched.visionFallbackModel, "glm-vision");
    assert.equal(patched.orchestrationEnabled, false);
    assert.equal(patched.orchestrationIntensity, "deep");
    assert.equal(patched.orchestrationVisibility, "explicit");
    assert.equal(patched.orchestrationProviderPreference, "quality");
    assert.equal(patched.orchestrationReviewDepth, "strict");
    assert.equal(patched.orchestrationParallelism, "parallel");
    assert.equal(patched.codeAutoApply, "manual");

    const reloaded = repo.get("sess-1");
    assert.equal(reloaded?.planningMode, "advisory");
    assert.equal(reloaded?.toolAutonomy, "manual");
    assert.equal(reloaded?.imageProviderId, "google");
    assert.equal(reloaded?.imageModel, "gemini-3.1-flash-image-preview");
    assert.equal(reloaded?.visionFallbackModel, "glm-vision");
    assert.equal(reloaded?.orchestrationEnabled, false);
    assert.equal(reloaded?.orchestrationIntensity, "deep");
    assert.equal(reloaded?.orchestrationVisibility, "explicit");
    assert.equal(reloaded?.orchestrationProviderPreference, "quality");
    assert.equal(reloaded?.orchestrationReviewDepth, "strict");
    assert.equal(reloaded?.orchestrationParallelism, "parallel");
    assert.equal(reloaded?.codeAutoApply, "manual");
  });
});
