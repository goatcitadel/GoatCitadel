import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaCppSetupSelectionService } from "./llama-cpp-setup-selection-service.js";

const ownedDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(ownedDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("LlamaCppSetupSelectionService", () => {
  it("accepts the last millisecond of custody and rejects the exact elapsed TTL boundary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-llama-selection-ttl-"));
    ownedDirs.push(dir);
    const modelPath = path.join(dir, "model.gguf");
    const command = path.join(dir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
    await Promise.all([fs.writeFile(modelPath, "gguf"), fs.writeFile(command, "binary")]);
    const custody = new Map<string, string>();
    const service = new LlamaCppSetupSelectionService({
      listModels: async () => [{ modelId: "model.gguf", source: "filesystem", filePath: modelPath }],
      detectInstall: async () => ({ found: true, command, source: "configured", recommendedBaseUrl: "http://127.0.0.1:8080/v1" }),
      custody: {
        setSecret: (key, value) => { custody.set(key, value); },
        getSecret: (key) => custody.get(key),
        deleteSecret: (key) => { custody.delete(key); },
      },
    });
    const stagedAt = Date.parse("2026-09-30T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(stagedAt);
    const staged = await service.stage({ workspaceId: "workspace-ttl", modelId: "model.gguf" });
    const expiresAt = Date.parse(staged.expiresAt);
    expect(expiresAt - stagedAt).toBe(30 * 60_000);
    clock.mockReturnValue(expiresAt - 1);
    await expect(service.resolve(staged.selectionId, "workspace-ttl")).resolves.toMatchObject({
      selectionId: staged.selectionId,
      workspaceId: "workspace-ttl",
    });
    clock.mockReturnValue(expiresAt);
    await expect(service.resolve(staged.selectionId, "workspace-ttl")).rejects.toThrow("stale");
    clock.mockReturnValue(expiresAt + 1);
    await expect(service.resolve(staged.selectionId, "workspace-ttl")).rejects.toThrow("stale");
  });

  it("keeps host paths out of the selection response and revalidates both files before apply", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-llama-selection-"));
    ownedDirs.push(dir);
    const modelPath = path.join(dir, "My Local Model.gguf");
    const command = path.join(dir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
    await Promise.all([fs.writeFile(modelPath, "gguf"), fs.writeFile(command, "binary")]);
    const custody = new Map<string, string>();
    const service = new LlamaCppSetupSelectionService({
      listModels: vi.fn(async () => [{ modelId: "My Local Model.gguf", source: "filesystem", filePath: modelPath }]),
      detectInstall: vi.fn(async () => ({
        found: true,
        command,
        source: "configured",
        recommendedBaseUrl: "http://127.0.0.1:8080/v1",
      })),
      custody: {
        setSecret: (key, value) => {
          custody.set(key, value);
        },
        getSecret: (key) => custody.get(key),
        deleteSecret: (key) => {
          custody.delete(key);
        },
      },
    });
    const staged = await service.stage({ workspaceId: "default", modelId: "My Local Model.gguf" });
    expect(staged).toMatchObject({ alias: "My-Local-Model", modelLabel: "My Local Model.gguf" });
    expect(JSON.stringify(staged)).not.toContain(dir);
    expect((await service.resolve(staged.selectionId, "default")).modelPath).toBe(await fs.realpath(modelPath));
    await expect(service.resolve(staged.selectionId, "other")).rejects.toThrow("another workspace");
    await fs.writeFile(modelPath, "changed GGUF");
    await expect(service.resolve(staged.selectionId, "default")).rejects.toThrow("changed");
    service.discard(staged.selectionId);
    await expect(service.resolve(staged.selectionId, "default")).rejects.toThrow("expired");
  });
});
