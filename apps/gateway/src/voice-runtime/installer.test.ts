import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeManagedVoiceModel, selectManagedVoiceModel } from "./installer.js";
import { readManagedVoiceManifest, writeManagedVoiceManifest, type ManagedVoiceManifest } from "./status.js";

const originalHome = process.env.GOATCITADEL_HOME;

describe("managed voice runtime installer", () => {
  let tempHome = "";

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-voice-installer-"));
    process.env.GOATCITADEL_HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome) {
      process.env.GOATCITADEL_HOME = originalHome;
    } else {
      delete process.env.GOATCITADEL_HOME;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("selects a managed model without requiring database-backed settings", async () => {
    const manifest = createManifest([
      ["base.en", path.join(tempHome, "tools", "voice", "models", "ggml-base.en.bin")],
      ["small.en", path.join(tempHome, "tools", "voice", "models", "ggml-small.en.bin")],
    ]);
    await writeManagedVoiceManifest(manifest);

    await selectManagedVoiceModel(undefined, "small.en");

    expect((await readManagedVoiceManifest())?.selectedModelId).toBe("small.en");
  });

  it("does not remove the fallback active model when database-backed settings are unavailable", async () => {
    await writeManagedVoiceManifest(
      createManifest([["base.en", path.join(tempHome, "tools", "voice", "models", "ggml-base.en.bin")]]),
    );

    await expect(removeManagedVoiceModel(undefined, "base.en")).rejects.toThrow("Model base.en is currently active.");
  });
});

function createManifest(models: Array<[string, string]>): ManagedVoiceManifest {
  return {
    schemaVersion: 1,
    models: models.map(([modelId, filePath]) => ({
      modelId,
      filePath,
      sizeBytes: 123,
      sha256: "abc",
      installedAt: "2026-03-08T00:00:00.000Z",
    })),
  };
}
