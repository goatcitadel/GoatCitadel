import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginSnapshotStore } from "./plugin-snapshot-store.js";
import {
  gatewayVersionForReviewKeys,
  reclaimPluginStorage,
  readGatewayVersion,
  UNVERSIONED_REVIEW_KEY_LABEL,
} from "./capability-plugins-composition.js";

describe("readGatewayVersion", () => {
  it("reads the Gateway package's own version", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
    };
    expect(manifest.name).toBe("@goatcitadel/gateway");
    expect(readGatewayVersion()).toBe(manifest.version);
  });

  it("reads it once from the package file two folders up, as from src and from dist", () => {
    const asked: string[] = [];
    const version = readGatewayVersion((specifier) => {
      asked.push(specifier);
      return { version: "2.3.0-beta.4+build.7" };
    });
    expect(version).toBe("2.3.0-beta.4+build.7");
    expect(asked).toEqual(["../../package.json"]);
  });

  it("refuses a version that can't name a review key, rather than making one up", () => {
    for (const manifest of [{}, { version: "" }, { version: "1.0 beta" }, { version: "x".repeat(65) }, undefined]) {
      expect(() => readGatewayVersion(() => manifest), JSON.stringify(manifest)).toThrow(
        "The Gateway package's version can't name a plugin skill's review key.",
      );
    }
  });
});

describe("gatewayVersionForReviewKeys", () => {
  it("uses the Gateway package's version when it can be read", () => {
    expect(gatewayVersionForReviewKeys(() => "2.3.0")).toBe("2.3.0");
  });

  it("falls back to a fixed label instead of stopping the Gateway when the version can't be read", () => {
    const label = gatewayVersionForReviewKeys(() => {
      throw new Error("The Gateway package's version can't name a plugin skill's review key.");
    });
    expect(label).toBe(UNVERSIONED_REVIEW_KEY_LABEL);
    expect(readGatewayVersion(() => ({ version: label }))).toBe(label);
  });
});

describe("reclaimPluginStorage", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeSource(root: string, name: string): string {
    const dir = path.join(root, "src", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), name);
    return dir;
  }

  it("clears temp copies and orphan snapshots but keeps one an installed plugin references", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-plugin-reclaim-"));
    scratch.push(root);
    const snapshots = new PluginSnapshotStore(path.join(root, "snapshots"));
    const tempRoot = path.join(root, "tmp");
    fs.mkdirSync(path.join(tempRoot, "git-abc"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, "copy-def"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "copy-def", "x.txt"), "x");
    const kept = await snapshots.importDirectory(makeSource(root, "kept"));
    const orphan = await snapshots.importDirectory(makeSource(root, "orphan"));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(kept.dir, old, old);
    fs.utimesSync(orphan.dir, old, old);
    await reclaimPluginStorage(
      tempRoot,
      async () => new Set([kept.treeSha256]),
      (keep, options) => snapshots.sweep(keep, options),
    );

    expect(fs.readdirSync(tempRoot)).toEqual([]);
    expect(snapshots.resolve(kept.treeSha256)).toBe(kept.dir);
    expect(() => snapshots.resolve(orphan.treeSha256)).toThrow();
  });

  it("logs and swallows a failure instead of blocking boot", async () => {
    await expect(
      reclaimPluginStorage(
        path.join(os.tmpdir(), "goat-plugin-reclaim-missing"),
        async () => {
          throw new Error("settings unreadable");
        },
        async () => ({ removed: [] }),
      ),
    ).resolves.toBeUndefined();
  });
});
