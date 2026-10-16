import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeTool } from "./tool-executor.js";

const storageStub = {
  approvals: { get: vi.fn(() => undefined) },
  pendingApprovalActions: { find: vi.fn(() => undefined), findFreshPending: vi.fn(() => undefined) },
} as unknown as Storage & AsyncStorage;

interface Fixture {
  base: string;
  jailRoot: string;
  secretsDir: string;
  writeOnlyRoot: string;
  deletableRoot: string;
  config: ToolPolicyConfig;
}

let fixture: Fixture;

function request(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
  return { toolName, args, agentId: "agent", sessionId: "sess-operator-roots" };
}

beforeEach(() => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "goat-operator-roots-")));
  const runtimeRoot = path.join(base, "runtime");
  const jailRoot = path.join(runtimeRoot, "data");
  const secretsDir = path.join(jailRoot, "secrets");
  const writeOnlyRoot = path.join(base, "write-only");
  const deletableRoot = path.join(base, "temp-like");
  for (const dir of [secretsDir, writeOnlyRoot, deletableRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const config: ToolPolicyConfig = {
    tools: { allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [jailRoot],
      readOnlyRoots: [],
      readAccessMode: "roots_only",
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
      operatorWriteRoots: [
        { path: writeOnlyRoot, allowDelete: false },
        { path: deletableRoot, allowDelete: true },
      ],
      runtimeWriteProtection: { rootDir: runtimeRoot, protectedPaths: [secretsDir] },
    },
  };
  fixture = { base, jailRoot, secretsDir, writeOnlyRoot, deletableRoot, config };
});

afterEach(() => {
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

describe("executeTool with operator write roots", () => {
  it("deletes files inside an operator root that allows delete", async () => {
    const target = path.join(fixture.deletableRoot, "stale.tmp");
    fs.writeFileSync(target, "stale");

    await expect(executeTool(request("fs.delete", { path: target }), fixture.config, storageStub)).resolves.toMatchObject(
      { path: target, deleted: true },
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  it("writes into a write-only operator root but refuses deletes there", async () => {
    const target = path.join(fixture.writeOnlyRoot, "note.txt");
    await expect(
      executeTool(request("fs.write", { path: target, content: "hello" }), fixture.config, storageStub),
    ).resolves.toMatchObject({ path: target });

    await expect(executeTool(request("fs.delete", { path: target }), fixture.config, storageStub)).rejects.toThrow(
      /outside write jail/i,
    );
    expect(fs.existsSync(target)).toBe(true);
  });

  it("refuses to move a file out of a write-only operator root", async () => {
    const source = path.join(fixture.writeOnlyRoot, "keep.txt");
    fs.writeFileSync(source, "keep");
    await expect(
      executeTool(
        request("fs.move", { from: source, to: path.join(fixture.jailRoot, "moved.txt") }),
        fixture.config,
        storageStub,
      ),
    ).rejects.toThrow(/outside write jail/i);
    expect(fs.existsSync(source)).toBe(true);
  });

  it("refuses to delete an operator root itself, even recursively", async () => {
    fs.writeFileSync(path.join(fixture.deletableRoot, "child.tmp"), "x");
    await expect(
      executeTool(request("fs.delete", { path: fixture.deletableRoot, recursive: true }), fixture.config, storageStub),
    ).rejects.toThrow(/write root cannot be deleted/i);
    expect(fs.existsSync(path.join(fixture.deletableRoot, "child.tmp"))).toBe(true);
  });

  it("refuses runtime-protected targets inside the write jail", async () => {
    const target = path.join(fixture.secretsDir, "vault.bin");
    await expect(
      executeTool(request("fs.write", { path: target, content: "overwrite" }), fixture.config, storageStub),
    ).rejects.toThrow(/runtime_protected_path/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses deletes outside every root", async () => {
    const outside = path.join(fixture.base, "outside.txt");
    fs.writeFileSync(outside, "x");
    await expect(executeTool(request("fs.delete", { path: outside }), fixture.config, storageStub)).rejects.toThrow(
      /outside write jail/i,
    );
    expect(fs.existsSync(outside)).toBe(true);
  });
});
