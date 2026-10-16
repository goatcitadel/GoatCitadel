import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeOperatorWriteRoot,
  classifyHardForbiddenWritePath,
  isSamePathOrDescendant,
  resolveWriteRootPreset,
  type WriteRootSafetyContext,
} from "./write-root-safety.js";

const WIN_ENV = {
  SystemDrive: "C:",
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramData: "C:\\ProgramData",
  USERPROFILE: "C:\\Users\\operator",
};

function winContext(overrides: Partial<WriteRootSafetyContext> = {}): WriteRootSafetyContext {
  return {
    rootDir: "C:\\code\\goatcitadel",
    env: WIN_ENV,
    platform: "win32",
    homeDir: "C:\\Users\\operator",
    tmpDir: "C:\\Users\\operator\\AppData\\Local\\Temp",
    realpath: (target) => target,
    isDirectory: () => true,
    ...overrides,
  };
}

function posixContext(overrides: Partial<WriteRootSafetyContext> = {}): WriteRootSafetyContext {
  return {
    rootDir: "/srv/goatcitadel",
    env: { HOME: "/home/operator" },
    platform: "linux",
    homeDir: "/home/operator",
    tmpDir: "/tmp",
    realpath: (target) => target,
    isDirectory: () => true,
    ...overrides,
  };
}

describe("canonicalizeOperatorWriteRoot (win32)", () => {
  it("accepts the user's temp folder and folds trailing separators", () => {
    expect(canonicalizeOperatorWriteRoot("C:\\Users\\operator\\AppData\\Local\\Temp\\", winContext())).toEqual({
      ok: true,
      canonicalPath: "C:\\Users\\operator\\AppData\\Local\\Temp",
    });
  });

  it.each([
    ["C:\\", "drive_root"],
    ["d:/", "drive_root"],
    ["\\\\fileserver\\share", "unc_share_root"],
    ["C:\\Windows\\Temp", "system_directory"],
    ["c:\\program files\\GoatCitadel", "system_directory"],
    ["C:\\Program Files (x86)\\Vendor", "system_directory"],
    ["C:\\ProgramData\\Vendor", "system_directory"],
    ["D:\\System Volume Information", "system_directory"],
    ["E:\\$Recycle.Bin\\S-1-5", "system_directory"],
    ["C:\\Users", "users_root"],
    ["C:\\Users\\operator", "user_profile_root"],
    ["C:\\Users\\OPERATOR\\", "user_profile_root"],
    ["C:\\Users\\operator\\.ssh", "sensitive_user_directory"],
    ["C:\\Users\\operator\\.aws\\cli", "sensitive_user_directory"],
    ["C:\\Users\\operator\\AppData\\Roaming\\Microsoft\\Protect", "sensitive_user_directory"],
    ["C:\\code", "contains_runtime_root"],
    ["C:\\code\\goatcitadel", "contains_runtime_root"],
    ["C:\\code\\goatcitadel\\config", "runtime_protected_path"],
    ["C:\\code\\goatcitadel\\config\\.generations", "runtime_protected_path"],
    ["C:\\code\\goatcitadel\\data\\secrets", "runtime_protected_path"],
    ["C:\\code\\goatcitadel\\data\\postgres\\pg", "runtime_protected_path"],
    ["C:\\code\\goatcitadel\\data\\audit", "runtime_protected_path"],
    ["relative\\folder", "not_absolute"],
    ["", "not_absolute"],
    ["C:\\Users\\operator\\bad\u0000name", "control_characters"],
  ])("rejects %s as %s", (input, rejection) => {
    const result = canonicalizeOperatorWriteRoot(input, winContext());
    expect(result).toMatchObject({ ok: false, rejection });
  });

  it("allows ordinary folders inside the runtime that are not protected", () => {
    expect(canonicalizeOperatorWriteRoot("C:\\code\\goatcitadel\\data\\exports", winContext())).toMatchObject({
      ok: true,
    });
  });

  it("uses environment-provided system folders", () => {
    const ctx = winContext({ env: { ...WIN_ENV, SystemRoot: "D:\\WinOS" } });
    expect(canonicalizeOperatorWriteRoot("D:\\WinOS\\Temp", ctx)).toMatchObject({ rejection: "system_directory" });
  });

  it("rejects a folder that does not exist", () => {
    const ctx = winContext({
      realpath: () => {
        throw new Error("ENOENT");
      },
    });
    expect(canonicalizeOperatorWriteRoot("C:\\Scratch\\missing", ctx)).toMatchObject({ rejection: "not_a_directory" });
  });

  it("rejects a path that is a file", () => {
    const ctx = winContext({ isDirectory: () => false });
    expect(canonicalizeOperatorWriteRoot("C:\\Scratch\\file.txt", ctx)).toMatchObject({ rejection: "not_a_directory" });
  });

  it("rejects a junction that resolves into a protected location", () => {
    const ctx = winContext({ realpath: () => "C:\\Users\\operator\\.ssh" });
    expect(canonicalizeOperatorWriteRoot("C:\\Scratch\\innocent", ctx)).toMatchObject({ rejection: "symlink_escape" });
  });

  it("returns the canonical path a junction resolves to when it is safe", () => {
    const ctx = winContext({ realpath: () => "D:\\Scratch\\real" });
    expect(canonicalizeOperatorWriteRoot("C:\\Scratch\\link", ctx)).toEqual({
      ok: true,
      canonicalPath: "D:\\Scratch\\real",
    });
  });

  it("honours explicitly supplied protected runtime paths", () => {
    const ctx = winContext({ protectedRuntimePaths: ["E:\\goat-data\\secrets"] });
    expect(canonicalizeOperatorWriteRoot("E:\\goat-data\\secrets\\keys", ctx)).toMatchObject({
      rejection: "runtime_protected_path",
    });
    expect(canonicalizeOperatorWriteRoot("C:\\code\\goatcitadel\\data\\secrets", ctx)).toMatchObject({ ok: true });
  });
});

describe("canonicalizeOperatorWriteRoot (posix)", () => {
  it("accepts /tmp and folders inside the home directory", () => {
    expect(canonicalizeOperatorWriteRoot("/tmp", posixContext())).toEqual({ ok: true, canonicalPath: "/tmp" });
    expect(canonicalizeOperatorWriteRoot("/home/operator/Downloads/", posixContext())).toEqual({
      ok: true,
      canonicalPath: "/home/operator/Downloads",
    });
  });

  it.each([
    ["/", "filesystem_root"],
    ["/etc", "system_directory"],
    ["/usr/local/share", "system_directory"],
    ["/home", "users_root"],
    ["/home/operator", "user_profile_root"],
    ["/home/operator/.gnupg", "sensitive_user_directory"],
    ["/srv", "contains_runtime_root"],
    ["/srv/goatcitadel/config", "runtime_protected_path"],
  ])("rejects %s as %s", (input, rejection) => {
    expect(canonicalizeOperatorWriteRoot(input, posixContext())).toMatchObject({ ok: false, rejection });
  });

  it("treats posix paths case-sensitively", () => {
    expect(canonicalizeOperatorWriteRoot("/ETC", posixContext())).toMatchObject({ ok: true });
  });
});

describe("classifyHardForbiddenWritePath", () => {
  it("allows ordinary targets inside a temp folder", () => {
    expect(
      classifyHardForbiddenWritePath("C:\\Users\\operator\\AppData\\Local\\Temp\\build-123\\out.log", winContext()),
    ).toBeUndefined();
  });

  it.each([
    ["C:\\code\\goatcitadel\\config\\tool-policy.json", "runtime_protected_path"],
    ["C:\\code\\goatcitadel\\data\\secrets\\vault.bin", "runtime_protected_path"],
    ["C:\\code\\goatcitadel", "contains_runtime_root"],
    ["C:\\Users\\operator", "user_profile_root"],
    ["C:\\Windows\\System32\\drivers\\etc\\hosts", "system_directory"],
    ["C:\\", "drive_root"],
  ])("forbids %s as %s", (target, rejection) => {
    expect(classifyHardForbiddenWritePath(target, winContext())).toBe(rejection);
  });

  it("does not forbid ordinary workspace targets", () => {
    expect(classifyHardForbiddenWritePath("C:\\code\\goatcitadel\\workspace\\notes.md", winContext())).toBeUndefined();
  });
});

describe("resolveWriteRootPreset", () => {
  it("resolves the OS temp preset on the server", () => {
    expect(resolveWriteRootPreset("os_temp", winContext())).toBe("C:\\Users\\operator\\AppData\\Local\\Temp");
    expect(resolveWriteRootPreset("os_temp", posixContext())).toBe("/tmp");
  });
});

describe("isSamePathOrDescendant", () => {
  it("compares case-insensitively on win32 and refuses sibling prefixes", () => {
    expect(isSamePathOrDescendant("C:\\Temp", "c:\\temp\\a", "win32")).toBe(true);
    expect(isSamePathOrDescendant("C:\\Temp", "C:\\Temp", "win32")).toBe(true);
    expect(isSamePathOrDescendant("C:\\Temp", "C:\\Temporary", "win32")).toBe(false);
    expect(isSamePathOrDescendant("C:\\Temp\\a", "C:\\Temp", "win32")).toBe(false);
    expect(isSamePathOrDescendant("/tmp", "/TMP/a", "linux")).toBe(false);
    expect(isSamePathOrDescendant("/tmp", "/tmp/..a", "linux")).toBe(true);
  });
});

describe("canonicalizeOperatorWriteRoot (real filesystem)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canonicalizes an existing directory with the default realpath", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-write-root-"));
    created.push(dir);
    const rootDir = path.join(path.parse(dir).root, "goat-runtime-root-fixture");
    const result = canonicalizeOperatorWriteRoot(dir, { rootDir });
    expect(result).toEqual({ ok: true, canonicalPath: fs.realpathSync.native(dir) });
  });
});
