import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STARTUP_FAILURE_FILE_ENV,
  isStartupFailureRecordPath,
  clearStartupFailureRecord,
  writeStartupFailureRecord,
} from "./startup-failure-record.js";
import { NonRetryableStartupError, attachOperatorSummary } from "./startup-errors.js";

const GENERAL_SUMMARY = "GoatCitadel's background service stopped while starting. Open Logs shows why.";
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-startup-failure-"));
  tempDirs.push(dir);
  return dir;
}

async function recordFile(): Promise<string> {
  return path.join(await tempDir(), "runtime", "logs", "gateway-startup-failure.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("startup failure record", () => {
  it("names the environment variable the launcher sets", () => {
    expect(STARTUP_FAILURE_FILE_ENV).toBe("GOATCITADEL_STARTUP_FAILURE_FILE");
  });

  it("writes the operator summary and whether a retry can help", async () => {
    const file = await recordFile();
    const error = attachOperatorSummary(
      new NonRetryableStartupError("port 45432 held (code=28P01)"),
      "The local database could not start because another program is using its port (45432).",
    );
    await writeStartupFailureRecord(file, error, new Date("2026-11-15T10:00:00Z"));
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      version: 1,
      summary: "The local database could not start because another program is using its port (45432).",
      retryable: false,
      at: "2026-11-15T10:00:00.000Z",
    });
  });

  it("uses the general sentence for an error without a summary and never copies its message", async () => {
    const file = await recordFile();
    await writeStartupFailureRecord(
      file,
      new Error("connect postgres://user:hunter2@127.0.0.1:45432/db failed"),
      new Date("2026-11-15T10:00:00Z"),
    );
    const raw = await fs.readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      summary: GENERAL_SUMMARY,
      retryable: true,
      at: "2026-11-15T10:00:00.000Z",
    });
    expect(raw).not.toContain("hunter2");
  });

  it("clears the record and does not fail when it is already gone", async () => {
    const file = await recordFile();
    await writeStartupFailureRecord(file, new Error("x"));
    await clearStartupFailureRecord(file);
    await expect(fs.access(file)).rejects.toThrow();
    await expect(clearStartupFailureRecord(file)).resolves.toBeUndefined();
  });

  it("does nothing without a path", async () => {
    await expect(writeStartupFailureRecord(undefined, new Error("x"))).resolves.toBeUndefined();
    await expect(writeStartupFailureRecord("  ", new Error("x"))).resolves.toBeUndefined();
    await expect(clearStartupFailureRecord(undefined)).resolves.toBeUndefined();
  });

  it("ignores a path that is not the runtime logs record, for both writing and clearing", async () => {
    const dir = await tempDir();
    const elsewhere = path.join(dir, "gateway-startup-failure.json");
    const wrongName = path.join(dir, "runtime", "logs", "other.json");
    await writeStartupFailureRecord(elsewhere, new Error("x"));
    await writeStartupFailureRecord(wrongName, new Error("x"));
    await expect(fs.access(elsewhere)).rejects.toThrow();
    await expect(fs.access(wrongName)).rejects.toThrow();
    await fs.writeFile(elsewhere, "keep", "utf8");
    await clearStartupFailureRecord(elsewhere);
    await expect(fs.readFile(elsewhere, "utf8")).resolves.toBe("keep");
    expect(isStartupFailureRecordPath(path.join("a", "runtime", "logs", "gateway-startup-failure.json"))).toBe(true);
    expect(isStartupFailureRecordPath(path.join("a", "logs", "gateway-startup-failure.json"))).toBe(false);
  });

  it("never throws when the file cannot be written", async () => {
    const dir = await tempDir();
    // A directory in the file's place cannot be replaced by a file.
    const file = path.join(dir, "runtime", "logs", "gateway-startup-failure.json");
    await fs.mkdir(file, { recursive: true });
    await expect(writeStartupFailureRecord(file, new Error("x"))).resolves.toBeUndefined();
  });
});
