import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("removes an installed inactive model and keeps settings-backed active selection intact", async () => {
    const basePath = path.join(tempHome, "tools", "voice", "models", "ggml-base.en.bin");
    const smallPath = path.join(tempHome, "tools", "voice", "models", "ggml-small.en.bin");
    await fs.mkdir(path.dirname(basePath), { recursive: true });
    await fs.writeFile(basePath, "base", "utf8");
    await fs.writeFile(smallPath, "small", "utf8");
    await writeManagedVoiceManifest(
      createManifest([
        ["base.en", basePath],
        ["small.en", smallPath],
      ]),
    );
    const settings = createSettingsMock({ selectedModelId: "base.en", mode: "managed" });

    const status = await removeManagedVoiceModel(settings, "small.en");

    await expect(fs.stat(smallPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readManagedVoiceManifest())?.models.map((model) => model.modelId)).toEqual(["base.en"]);
    expect(status.selectedModelId).toBe("base.en");
    expect(status.installedModels).toEqual([
      expect.objectContaining({
        modelId: "base.en",
        active: true,
      }),
    ]);
  });

  it("reports unknown, missing, and active model selection failures explicitly", async () => {
    const basePath = path.join(tempHome, "tools", "voice", "models", "ggml-base.en.bin");
    await fs.mkdir(path.dirname(basePath), { recursive: true });
    await fs.writeFile(basePath, "base", "utf8");
    await writeManagedVoiceManifest(createManifest([["base.en", basePath]]));
    const settings = createSettingsMock({ selectedModelId: "base.en", mode: "managed" });

    await expect(selectManagedVoiceModel(settings, "small.en")).rejects.toThrow("Model small.en is not installed yet.");
    await expect(removeManagedVoiceModel(settings, "missing-model")).rejects.toThrow(
      "Model missing-model is not installed.",
    );
    await expect(removeManagedVoiceModel(settings, "base.en")).rejects.toThrow("Model base.en is currently active.");
    expect(settings.set).not.toHaveBeenCalled();
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

function createSettingsMock(initial: { selectedModelId?: string; mode?: "managed" | "env_override" }) {
  let value = initial;
  return {
    get: vi.fn(() => ({ value })),
    set: vi.fn((_key: string, next: typeof value) => {
      value = next;
    }),
  };
}
