import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import {
  assertToolWritePath,
  effectiveToolWriteRoots,
  operatorWriteRootPaths,
  toolReadableWriteRoots,
} from "./tool-write-gate.js";

type Sandbox = ToolPolicyConfig["sandbox"];

interface Fixture {
  base: string;
  runtimeRoot: string;
  jailRoot: string;
  secretsDir: string;
  writeOnlyRoot: string;
  deletableRoot: string;
  outside: string;
  sandbox: Sandbox;
}

let fixture: Fixture;

function createFixture(): Fixture {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "goat-write-gate-")));
  const runtimeRoot = path.join(base, "runtime");
  const jailRoot = path.join(runtimeRoot, "data");
  const secretsDir = path.join(jailRoot, "secrets");
  const writeOnlyRoot = path.join(base, "operator-write-only");
  const deletableRoot = path.join(base, "operator-deletable");
  const outside = path.join(base, "outside");
  for (const dir of [jailRoot, secretsDir, writeOnlyRoot, deletableRoot, outside]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sandbox: Sandbox = {
    writeJailRoots: [jailRoot],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
    operatorWriteRoots: [
      { path: writeOnlyRoot, allowDelete: false },
      { path: deletableRoot, allowDelete: true },
    ],
    runtimeWriteProtection: {
      rootDir: runtimeRoot,
      protectedPaths: [path.join(runtimeRoot, "config"), secretsDir],
    },
  };
  return { base, runtimeRoot, jailRoot, secretsDir, writeOnlyRoot, deletableRoot, outside, sandbox };
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

describe("effective tool write roots", () => {
  it("adds every operator root for writes but only opted-in roots for deletes", () => {
    expect(operatorWriteRootPaths(fixture.sandbox, "write")).toEqual([fixture.writeOnlyRoot, fixture.deletableRoot]);
    expect(operatorWriteRootPaths(fixture.sandbox, "delete")).toEqual([fixture.deletableRoot]);
    expect(effectiveToolWriteRoots(fixture.sandbox, "delete")).toEqual([fixture.jailRoot, fixture.deletableRoot]);
    expect(toolReadableWriteRoots(fixture.sandbox)).toEqual([
      fixture.jailRoot,
      fixture.writeOnlyRoot,
      fixture.deletableRoot,
    ]);
  });

  it("behaves exactly like the plain jail when no operator roots are configured", () => {
    const sandbox: Sandbox = { ...fixture.sandbox, operatorWriteRoots: undefined };
    expect(effectiveToolWriteRoots(sandbox, "write")).toEqual([fixture.jailRoot]);
    expect(effectiveToolWriteRoots(sandbox, "delete")).toEqual([fixture.jailRoot]);
  });
});

describe("assertToolWritePath", () => {
  it("admits writes into the jail and into every operator root", () => {
    expect(assertToolWritePath(path.join(fixture.jailRoot, "a.txt"), fixture.sandbox)).toBe(
      path.join(fixture.jailRoot, "a.txt"),
    );
    expect(() => assertToolWritePath(path.join(fixture.writeOnlyRoot, "a.txt"), fixture.sandbox)).not.toThrow();
    expect(() => assertToolWritePath(path.join(fixture.deletableRoot, "a.txt"), fixture.sandbox)).not.toThrow();
  });

  it("refuses writes outside the jail and operator roots", () => {
    expect(() => assertToolWritePath(path.join(fixture.outside, "a.txt"), fixture.sandbox)).toThrow(
      /outside write jail/i,
    );
  });

  it("refuses deletes in operator roots that did not opt into delete", () => {
    expect(() =>
      assertToolWritePath(path.join(fixture.writeOnlyRoot, "a.txt"), fixture.sandbox, "delete"),
    ).toThrow(/outside write jail/i);
    expect(() =>
      assertToolWritePath(path.join(fixture.deletableRoot, "a.txt"), fixture.sandbox, "delete"),
    ).not.toThrow();
    expect(() => assertToolWritePath(path.join(fixture.jailRoot, "a.txt"), fixture.sandbox, "delete")).not.toThrow();
  });

  it("refuses deleting a write root itself", () => {
    expect(() => assertToolWritePath(fixture.deletableRoot, fixture.sandbox, "delete")).toThrow(
      /write root cannot be deleted/i,
    );
    expect(() => assertToolWritePath(fixture.jailRoot, fixture.sandbox, "delete")).toThrow(
      /write root cannot be deleted/i,
    );
  });

  it("refuses runtime-protected targets even inside the write jail", () => {
    expect(() => assertToolWritePath(path.join(fixture.secretsDir, "vault.bin"), fixture.sandbox)).toThrow(
      /protected and cannot be written.*runtime_protected_path/i,
    );
    expect(() =>
      assertToolWritePath(path.join(fixture.secretsDir, "vault.bin"), fixture.sandbox, "delete"),
    ).toThrow(/runtime_protected_path/i);
  });

  it("refuses deleting or moving away a folder that contains a protected path", () => {
    const broadSandbox: Sandbox = { ...fixture.sandbox, writeJailRoots: [fixture.runtimeRoot] };
    expect(() => assertToolWritePath(fixture.jailRoot, broadSandbox, "delete")).toThrow(
      /contains a protected runtime folder/i,
    );
    expect(() => assertToolWritePath(path.join(fixture.jailRoot, "exports"), broadSandbox, "delete")).not.toThrow();
    expect(() => assertToolWritePath(path.join(fixture.jailRoot, "exports"), broadSandbox, "write")).not.toThrow();
  });

  it.runIf(process.platform !== "win32")("refuses a link inside an operator root that escapes it", () => {
    const link = path.join(fixture.deletableRoot, "escape");
    fs.symlinkSync(fixture.outside, link);
    expect(() => assertToolWritePath(path.join(link, "a.txt"), fixture.sandbox)).toThrow(/outside write jail/i);
  });
});
