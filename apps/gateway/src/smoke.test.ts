import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyShippedConfig, parseSmokeArgs } from "./smoke.js";

describe("gateway smoke profiles", () => {
  it("defaults to the full smoke profile", () => {
    expect(parseSmokeArgs([])).toEqual({ profile: "full" });
  });

  it("parses fast and full profile flags", () => {
    expect(parseSmokeArgs(["--profile", "fast"])).toEqual({ profile: "fast" });
    expect(parseSmokeArgs(["--", "--profile", "fast"])).toEqual({ profile: "fast" });
    expect(parseSmokeArgs(["--profile=full"])).toEqual({ profile: "full" });
  });

  it("rejects unknown profiles and arguments", () => {
    expect(() => parseSmokeArgs(["--profile"])).toThrow("Missing smoke profile");
    expect(() => parseSmokeArgs(["--profile", "tiny"])).toThrow("Unknown smoke profile");
    expect(() => parseSmokeArgs(["--tiny"])).toThrow("Unknown smoke argument");
  });
});

describe("gateway smoke config", () => {
  it("copies only the shipped config files, never operator config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gc-smoke-config-"));
    try {
      const source = path.join(root, "repo");
      await mkdir(path.join(source, "config", "private"), { recursive: true });
      for (const name of [
        "goatcitadel.example.json",
        "llm-model-metadata.json",
        "goatcitadel.json",
        "llm-providers.json",
      ]) {
        await writeFile(path.join(source, "config", name), "{}");
      }
      await writeFile(path.join(source, "config", "private", "notes.json"), "{}");
      const target = path.join(root, "runtime");
      await copyShippedConfig(source, target);
      expect((await readdir(path.join(target, "config"))).sort()).toEqual([
        "goatcitadel.example.json",
        "llm-model-metadata.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
