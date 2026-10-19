import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolGrantCreateInput, ToolPolicyConfig } from "@goatcitadel/contracts";
import {
  deriveOutsideRootWriteCandidates,
  grantWriteRootsAdmit,
  isInsideToolWriteRoots,
  isOutsideRootWriteEnabled,
  outsideRootWriteRootId,
  resolveOutsideRootWriteTarget,
  validateWriteRootsGrantInput,
} from "./outside-root-write.js";
import { assertToolWritePath, withExecutionWriteAdmission } from "./tool-write-gate.js";

type Sandbox = ToolPolicyConfig["sandbox"];

interface Fixture {
  base: string;
  runtimeRoot: string;
  jailRoot: string;
  secretsDir: string;
  outside: string;
  sandbox: Sandbox;
}

let fixture: Fixture;

beforeEach(() => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "goat-outside-root-")));
  const runtimeRoot = path.join(base, "runtime");
  const jailRoot = path.join(runtimeRoot, "data");
  const secretsDir = path.join(jailRoot, "secrets");
  const outside = path.join(base, "scratch", "reports");
  for (const dir of [secretsDir, outside]) fs.mkdirSync(dir, { recursive: true });
  const sandbox: Sandbox = {
    writeJailRoots: [jailRoot],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
    outsideRootWriteMode: "approval_required",
    runtimeWriteProtection: { rootDir: runtimeRoot, protectedPaths: [secretsDir] },
  };
  fixture = { base, runtimeRoot, jailRoot, secretsDir, outside, sandbox };
});

afterEach(() => {
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

function ctx() {
  return { rootDir: fixture.runtimeRoot, protectedRuntimePaths: [fixture.secretsDir] };
}

function grantInput(overrides: Partial<ToolGrantCreateInput> = {}): ToolGrantCreateInput {
  return {
    toolPattern: "fs.write",
    decision: "allow",
    scope: "session",
    scopeRef: "sess-1",
    grantType: "ttl",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdBy: "operator",
    constraints: { writeRoots: [fixture.outside] },
    ...overrides,
  };
}

describe("outside-root write enablement", () => {
  it("requires approval_required mode and runtime write protection", () => {
    expect(isOutsideRootWriteEnabled(fixture.sandbox)).toBe(true);
    expect(isOutsideRootWriteEnabled({ ...fixture.sandbox, outsideRootWriteMode: "deny" })).toBe(false);
    expect(isOutsideRootWriteEnabled({ ...fixture.sandbox, outsideRootWriteMode: undefined })).toBe(false);
    expect(isOutsideRootWriteEnabled({ ...fixture.sandbox, runtimeWriteProtection: undefined })).toBe(false);
  });

  it("tells jail targets apart from outside targets", () => {
    expect(isInsideToolWriteRoots(path.join(fixture.jailRoot, "a.txt"), fixture.sandbox)).toBe(true);
    expect(isInsideToolWriteRoots(path.join(fixture.outside, "a.txt"), fixture.sandbox)).toBe(false);
  });
});

describe("resolveOutsideRootWriteTarget", () => {
  it("resolves a missing file under an existing folder", () => {
    const target = path.join(fixture.outside, "new", "report.md");
    expect(resolveOutsideRootWriteTarget(target, ctx())).toEqual({ ok: true, resolved: target });
  });

  it("refuses runtime-protected targets", () => {
    expect(resolveOutsideRootWriteTarget(path.join(fixture.secretsDir, "x.bin"), ctx())).toMatchObject({
      ok: false,
      refusal: "runtime_protected_path",
    });
  });

  it.each([
    ["\\\\?\\C:\\Temp\\x.txt", "device_namespace"],
    ["\\\\.\\PhysicalDrive0", "device_namespace"],
    ["\\\\fileserver\\share\\x.txt", "network_path"],
    ["C:\\Temp\\NUL", "reserved_device_name"],
    ["C:\\Temp\\com1.txt", "reserved_device_name"],
    ["C:\\Temp\\file.txt:hidden", "alternate_data_stream"],
  ])("refuses the Windows path %s as %s", (target, refusal) => {
    expect(resolveOutsideRootWriteTarget(target, ctx(), "win32")).toMatchObject({ ok: false, refusal });
  });

  it.runIf(process.platform === "win32")("refuses short-name segments under a missing folder", () => {
    const target = path.join(fixture.outside, "MISSIN~1", "x.txt");
    expect(resolveOutsideRootWriteTarget(target, ctx())).toMatchObject({ ok: false, refusal: "short_name_segment" });
  });
});

describe("deriveOutsideRootWriteCandidates", () => {
  it("offers the closest existing folder and safe ancestors that contain every target", () => {
    const target = path.join(fixture.outside, "deep", "x.txt");
    const candidates = deriveOutsideRootWriteCandidates([target], ctx());
    // The third level (the fixture base) contains the runtime root, so it is not offered.
    expect(candidates.map((candidate) => candidate.path)).toEqual([fixture.outside, path.dirname(fixture.outside)]);
    for (const candidate of candidates) {
      expect(candidate.rootId).toBe(outsideRootWriteRootId(candidate.path));
      expect(candidate.rootId).toMatch(/^owr_[a-f0-9]{16}$/u);
    }
  });

  it("never offers a folder that contains the runtime root", () => {
    const target = path.join(fixture.runtimeRoot, "loose.txt");
    const candidates = deriveOutsideRootWriteCandidates([target], ctx());
    expect(candidates.some((candidate) => candidate.path === fixture.runtimeRoot)).toBe(false);
    expect(candidates.some((candidate) => candidate.path === fixture.base)).toBe(false);
  });
});

describe("grantWriteRootsAdmit", () => {
  it("admits targets inside a stored canonical folder only", () => {
    expect(grantWriteRootsAdmit([fixture.outside], [path.join(fixture.outside, "a.txt")], ctx())).toEqual([
      fixture.outside,
    ]);
    expect(grantWriteRootsAdmit([fixture.outside], [path.join(fixture.base, "other.txt")], ctx())).toBeUndefined();
    expect(grantWriteRootsAdmit([fixture.outside], [], ctx())).toBeUndefined();
  });

  it("ignores a folder that no longer canonicalizes to its stored path", () => {
    const gone = path.join(fixture.base, "removed");
    expect(grantWriteRootsAdmit([gone], [path.join(gone, "a.txt")], ctx())).toBeUndefined();
  });
});

describe("validateWriteRootsGrantInput", () => {
  it("returns canonical folders for a valid grant", () => {
    const validated = validateWriteRootsGrantInput(grantInput(), fixture.sandbox);
    expect(validated.constraints?.writeRoots).toEqual([fixture.outside]);
  });

  it("passes through grants without writeRoots", () => {
    const input = grantInput({ constraints: { allowedHosts: ["example.com"] } });
    expect(validateWriteRootsGrantInput(input, fixture.sandbox)).toBe(input);
  });

  it.each<[string, Partial<ToolGrantCreateInput>]>([
    ["deny grants", { decision: "deny" }],
    ["wildcard tool patterns", { toolPattern: "fs.*" }],
    ["delete tools", { toolPattern: "fs.delete" }],
    ["global scope", { scope: "global" }],
    ["a missing scopeRef", { scopeRef: "" }],
    ["persistent grants", { grantType: "persistent" }],
    ["one_time grants", { grantType: "one_time" }],
    ["a missing grant type", { grantType: undefined }],
    ["an expiry over 24 hours", { expiresAt: new Date(Date.now() + 25 * 60 * 60_000).toISOString() }],
    ["a past expiry", { expiresAt: new Date(Date.now() - 1000).toISOString() }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => validateWriteRootsGrantInput(grantInput(overrides), fixture.sandbox)).toThrow(
      /Invalid write-root grant/u,
    );
  });

  it.each<[string, string[]]>([
    ["a wildcard folder", ["*"]],
    ["a relative folder", ["relative/dir"]],
    ["a protected folder", ["SECRETS"]],
    ["too many folders", ["A", "B", "C", "D", "E"]],
    ["no folders", []],
  ])("rejects %s", (_label, roots) => {
    const resolvedRoots = roots.map((root) => (root === "SECRETS" ? fixture.secretsDir : root));
    const input = grantInput({ constraints: { writeRoots: resolvedRoots } });
    expect(() => validateWriteRootsGrantInput(input, fixture.sandbox)).toThrow(/Invalid write-root grant/u);
  });

  it("rejects writeRoots mixed with other path constraints and without runtime protection", () => {
    const mixed = grantInput({ constraints: { writeRoots: [fixture.outside], allowedPaths: [fixture.outside] } });
    expect(() => validateWriteRootsGrantInput(mixed, fixture.sandbox)).toThrow(/cannot be combined/u);
    const unprotected = { ...fixture.sandbox, runtimeWriteProtection: undefined };
    expect(() => validateWriteRootsGrantInput(grantInput(), unprotected)).toThrow(/runtime write protection/u);
  });
});

describe("tool write gate admission", () => {
  it("admits outside targets for write intent only", () => {
    const target = path.join(fixture.outside, "a.txt");
    expect(() => assertToolWritePath(target, fixture.sandbox)).toThrow(/outside write jail/iu);
    expect(assertToolWritePath(target, fixture.sandbox, "write", { roots: [fixture.outside] })).toBe(target);
    expect(() => assertToolWritePath(target, fixture.sandbox, "delete", { roots: [fixture.outside] })).toThrow(
      /outside write jail/iu,
    );
  });

  it("still refuses hard-forbidden targets inside an admitted folder", () => {
    expect(() =>
      assertToolWritePath(path.join(fixture.secretsDir, "x.bin"), fixture.sandbox, "write", {
        roots: [fixture.secretsDir],
      }),
    ).toThrow(/runtime_protected_path/u);
  });

  it("carries an execution admission only on the copy it returns", () => {
    const config = { tools: { allow: [], deny: [] }, agents: {}, sandbox: fixture.sandbox } as ToolPolicyConfig;
    const admitted = withExecutionWriteAdmission(config, { roots: [fixture.outside] });
    const target = path.join(fixture.outside, "a.txt");
    expect(assertToolWritePath(target, admitted.sandbox)).toBe(target);
    expect(() => assertToolWritePath(target, config.sandbox)).toThrow(/outside write jail/iu);
    expect(withExecutionWriteAdmission(config, undefined)).toBe(config);
    expect(JSON.parse(JSON.stringify(admitted.sandbox))).toEqual(JSON.parse(JSON.stringify(config.sandbox)));
  });
});
