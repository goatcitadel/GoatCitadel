import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("shipped config defaults", () => {
  it("keep fresh local installs on unauthenticated startup defaults", async () => {
    const assistantRaw = await readFile(path.join(repoRoot, "config", "assistant.config.example.json"), "utf8");
    const unifiedRaw = await readFile(path.join(repoRoot, "config", "goatcitadel.example.json"), "utf8");

    const assistant = JSON.parse(assistantRaw) as { auth?: { mode?: string } };
    const unified = JSON.parse(unifiedRaw) as { assistant?: { auth?: { mode?: string } } };

    expect(assistant.auth?.mode ?? "none").toBe("none");
    expect(unified.assistant?.auth?.mode ?? "none").toBe("none");
  });
});
