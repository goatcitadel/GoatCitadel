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

    // The unified chat surface pins prefs.mode to "chat"; the live surface mode
    // is resolved by the auto-router (surfaceMode), not persisted per session.
    assert.equal(patched.mode, "chat");
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

  it("lists prefs for many sessions in one lookup", () => {
    const repo = createRepo();
    repo.patch("sess-1", { mode: "cowork" }, "2026-03-07T00:00:00.000Z");
    repo.patch("sess-2", { mode: "code" }, "2026-03-07T00:00:01.000Z");

    const listed = repo.listBySessionIds(["sess-2", "missing", "sess-1", "sess-1"]);

    assert.equal(listed.size, 2);
    // Both sessions resolve to the unified "chat" surface regardless of the mode
    // passed to patch; the batch lookup itself is what this case exercises.
    assert.equal(listed.get("sess-1")?.mode, "chat");
    assert.equal(listed.get("sess-2")?.mode, "chat");
    assert.equal(repo.listBySessionIds([]).size, 0);
  });

  it("preserves existing prefs, clears dependent model fields, and handles legacy nullable controls", () => {
    const repo = createRepo();
    const created = repo.ensure("sess-1", "2026-03-07T00:00:00.000Z");

    assert.equal(repo.ensure("sess-1", "2026-03-07T00:01:00.000Z").createdAt, created.createdAt);

    repo.patch(
      "sess-1",
      {
        providerId: "openai",
        model: "gpt-5.2",
        imageProviderId: "google",
        imageModel: "gemini-image",
        visionFallbackModel: "vision-model",
        orchestrationEnabled: false,
      },
      "2026-03-07T00:02:00.000Z",
    );

    const cleared = repo.patch(
      "sess-1",
      {
        providerId: "   ",
        imageProviderId: "   ",
        visionFallbackModel: "   ",
      },
      "2026-03-07T00:03:00.000Z",
    );

    assert.equal(cleared.providerId, undefined);
    assert.equal(cleared.model, undefined);
    assert.equal(cleared.imageProviderId, undefined);
    assert.equal(cleared.imageModel, undefined);
    assert.equal(cleared.visionFallbackModel, undefined);
    assert.equal(cleared.orchestrationEnabled, false);

    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
    };
    internal.getStmt = {
      get: () => ({
        session_id: "legacy",
        mode: "chat",
        planning_mode: "off",
        provider_id: null,
        model: null,
        image_provider_id: null,
        image_model: null,
        web_mode: "auto",
        memory_mode: "auto",
        thinking_level: "standard",
        speed_mode: undefined,
        subagent_policy: undefined,
        tool_autonomy: "safe_auto",
        vision_fallback_model: null,
        orchestration_enabled: 1,
        orchestration_intensity: "balanced",
        orchestration_visibility: "summarized",
        orchestration_provider_preference: "balanced",
        orchestration_review_depth: "standard",
        orchestration_parallelism: "auto",
        code_auto_apply: "aggressive_auto",
        created_at: "2026-03-07T00:00:00.000Z",
        updated_at: "2026-03-07T00:00:00.000Z",
      }),
    };
    assert.equal(repo.get("legacy")?.speedMode, "standard");
    assert.equal(repo.get("legacy")?.subagentPolicy, "ask_when_useful");

    internal.getStmt = { get: () => null };
    assert.equal(repo.get("malformed"), undefined);
  });

  it("throws when an adapter write cannot be read back", () => {
    const repo = createRepo();
    let reads = 0;
    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
      upsertStmt: { run: (...args: unknown[]) => unknown };
    };
    internal.getStmt = {
      get: () => {
        reads += 1;
        return reads === 1 ? undefined : { malformed: true };
      },
    };
    internal.upsertStmt = { run: () => ({ changes: 1 }) };

    assert.throws(() => repo.ensure("sess-unreadable", "2026-03-07T00:00:00.000Z"), /chat session prefs/);
  });

  it("rejects malformed list rows from the adapter", () => {
    const repo = createRepo();
    const internal = repo as unknown as {
      db: { prepare: (...args: unknown[]) => { all: (...args: unknown[]) => unknown } };
    };
    internal.db.prepare = () => ({ all: () => [null] });

    assert.throws(() => repo.listBySessionIds(["sess-corrupt"]), /Unexpected chat_session_prefs row shape/);
  });
});
