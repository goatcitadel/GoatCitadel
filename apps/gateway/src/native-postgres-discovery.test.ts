import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverNativePostgresTool, nativePostgresInstallRoots } from "./native-postgres-discovery.js";

const tempDirs: string[] = [];

async function makeProgramFiles(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-pg-discovery-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTool(programFiles: string, version: string, fileName: string): Promise<string> {
  const bin = path.join(programFiles, "PostgreSQL", version, "bin");
  await fs.mkdir(bin, { recursive: true });
  const command = path.join(bin, fileName);
  await fs.writeFile(command, "", "utf8");
  return command;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("discoverNativePostgresTool", () => {
  it("finds pg_dump in a standard install root that is not on PATH", async () => {
    const programFiles = await makeProgramFiles();
    const command = await writeTool(programFiles, "16", "pg_dump.exe");

    expect(discoverNativePostgresTool("pg_dump", "win32", { ProgramFiles: programFiles })).toBe(command);
  });

  it("prefers the highest major version and accepts client-only installs", async () => {
    const programFiles = await makeProgramFiles();
    await writeTool(programFiles, "14", "pg_dump.exe");
    const newest = await writeTool(programFiles, "17", "pg_dump.exe");

    expect(discoverNativePostgresTool("pg_dump", "win32", { ProgramFiles: programFiles })).toBe(newest);
  });

  it("returns undefined when no install ships the tool", async () => {
    const programFiles = await makeProgramFiles();
    await writeTool(programFiles, "16", "psql.exe");

    expect(discoverNativePostgresTool("pg_dump", "win32", { ProgramFiles: programFiles })).toBeUndefined();
  });

  it("reads the major from the resolved path of an unversioned entry like Homebrew libpq", async () => {
    const programFiles = await makeProgramFiles();
    await writeTool(programFiles, "16", "pg_dump.exe");
    const keg = path.join(programFiles, "Cellar", "libpq", "18.0_1");
    await fs.mkdir(path.join(keg, "bin"), { recursive: true });
    await fs.writeFile(path.join(keg, "bin", "pg_dump.exe"), "", "utf8");
    await fs.symlink(keg, path.join(programFiles, "PostgreSQL", "libpq"), "junction");

    expect(discoverNativePostgresTool("pg_dump", "win32", { ProgramFiles: programFiles })).toBe(
      path.join(programFiles, "PostgreSQL", "libpq", "bin", "pg_dump.exe"),
    );
  });
});

describe("nativePostgresInstallRoots", () => {
  it("includes the EDB macOS installer root", () => {
    expect(nativePostgresInstallRoots("darwin", {})).toContain("/Library/PostgreSQL");
  });
});
