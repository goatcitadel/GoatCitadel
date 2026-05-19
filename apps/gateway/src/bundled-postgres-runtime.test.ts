import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBundledDockerContainerName, __bundledPostgresRuntimeInternals } from "./bundled-postgres-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-bundled-pg-"));
  tempDirs.push(dir);
  return dir;
}

function buildBundledConfig(rootDir: string, binDir?: string): never {
  return {
    rootDir,
    assistant: {
      dataDir: "data",
      database: {
        bundledPostgres: {
          binDir,
          dataDir: "data/postgres",
          port: 45432,
        },
      },
    },
  } as never;
}

describe("bundled postgres runtime helpers", () => {
  it("resolves native postgres commands only when both binaries are present", async () => {
    const rootDir = await makeTempDir();
    const binDir = path.join(rootDir, "pg-bin");
    await fs.mkdir(binDir, { recursive: true });

    expect(
      __bundledPostgresRuntimeInternals.resolveNativePostgresCommands(buildBundledConfig(rootDir, "pg-bin")),
    ).toBeUndefined();

    const extension = process.platform === "win32" ? ".exe" : "";
    await fs.writeFile(path.join(binDir, `initdb${extension}`), "", "utf8");
    await fs.writeFile(path.join(binDir, `pg_ctl${extension}`), "", "utf8");

    expect(
      __bundledPostgresRuntimeInternals.resolveNativePostgresCommands(buildBundledConfig(rootDir, "pg-bin")),
    ).toEqual({
      initdb: path.join(binDir, `initdb${extension}`),
      pgCtl: path.join(binDir, `pg_ctl${extension}`),
    });
  }, 15_000);

  it("normalizes filesystem, docker data-directory, quoted identifiers, and container names", () => {
    expect(__bundledPostgresRuntimeInternals.sameFilesystemPath("C:/Temp/../Temp/data", "C:/Temp/data")).toBe(true);
    expect(__bundledPostgresRuntimeInternals.isDockerPostgresDataDirectory("\\var\\lib\\postgresql\\data\\")).toBe(
      true,
    );
    expect(__bundledPostgresRuntimeInternals.isDockerPostgresDataDirectory("/tmp/postgres")).toBe(false);
    expect(__bundledPostgresRuntimeInternals.quoteIdentifier('operator"events')).toBe('"operator""events"');
    expect(buildBundledDockerContainerName("F:/code/personal-ai")).toMatch(
      /^goatcitadel-postgres-[a-z0-9-]+-[a-f0-9]{10}$/,
    );
  });
});
