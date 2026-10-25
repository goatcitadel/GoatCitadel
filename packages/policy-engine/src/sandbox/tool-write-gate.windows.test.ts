import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { assertNoWindowsPathTricks, assertToolWritePath } from "./tool-write-gate.js";

type Sandbox = ToolPolicyConfig["sandbox"];

let base: string;
let runtimeRoot: string;
let jailRoot: string;
let sandbox: Sandbox;

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "goat-write-win-")));
  runtimeRoot = path.join(base, "runtime");
  jailRoot = path.join(runtimeRoot, "data");
  fs.mkdirSync(jailRoot, { recursive: true });
  sandbox = {
    writeJailRoots: [jailRoot],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
    runtimeWriteProtection: {
      rootDir: runtimeRoot,
      protectedPaths: [path.join(runtimeRoot, "config"), path.join(jailRoot, "index.db")],
    },
  };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("Windows path tricks against protected paths", () => {
  it.runIf(process.platform === "win32")("refuses ADS, trailing dot/space, device and short-name forms", () => {
    const targets = [
      path.join(jailRoot, "index.db::$DATA"),
      path.join(jailRoot, "index.db."),
      path.join(jailRoot, "index.db "),
      path.join(jailRoot, "NUL"),
      path.join(jailRoot, "newdir", "PROGRA~1"),
    ];
    for (const target of targets) {
      expect(() => assertToolWritePath(target, sandbox), target).toThrow();
    }
    expect(() => assertToolWritePath(path.join(jailRoot, "ok.txt"), sandbox)).not.toThrow();
  });

  it("applies the win32 rules on any host and is a no-op elsewhere", () => {
    expect(() => assertNoWindowsPathTricks("C:\\runtime\\data\\index.db::$DATA", "win32")).toThrow(
      /alternate_data_stream/,
    );
    expect(() => assertNoWindowsPathTricks("C:\\runtime\\data\\index.db.", "win32")).toThrow(/trailing_dot_or_space/);
    expect(() => assertNoWindowsPathTricks("C:\\runtime\\config.\\goatcitadel.json", "win32")).toThrow(
      /trailing_dot_or_space/,
    );
    expect(() => assertNoWindowsPathTricks("C:\\runtime\\data\\COM1.txt", "win32")).toThrow(/reserved_device_name/);
    expect(() => assertNoWindowsPathTricks("C:\\runtime\\data\\ok\\file.txt", "win32")).not.toThrow();
    expect(() => assertNoWindowsPathTricks("/runtime/data/index.db.", "linux")).not.toThrow();
  });
});
