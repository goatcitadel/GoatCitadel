import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";

// shell.exec executes through a manual spawn (so process trees can be killed on
// timeout/abort). Provide a controllable fake child driven by `mocked.spawnResult`.
type SpawnResult = { stdout?: string; stderr?: string; exitCode?: number | null; error?: Error };

function makeSpawnChild(
  result: SpawnResult,
): EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    signalCode: null;
    kill: () => boolean;
    unref: () => void;
  };
  child.pid = 4343;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  child.unref = () => {};
  queueMicrotask(() => {
    if (result.error) {
      child.emit("error", result.error);
      return;
    }
    if (result.stdout) {
      child.stdout.emit("data", Buffer.from(result.stdout, "utf8"));
    }
    if (result.stderr) {
      child.stderr.emit("data", Buffer.from(result.stderr, "utf8"));
    }
    const code = result.exitCode === undefined ? 0 : result.exitCode;
    child.emit("close", code, null);
  });
  return child;
}

const mocked = vi.hoisted(() => {
  const execFileAsync = vi.fn();
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsync,
  });
  return {
    execFile,
    execFileAsync,
    spawn: vi.fn(),
    spawnResult: { stdout: "ok", stderr: "", exitCode: 0 } as SpawnResult,
    isBrowserToolName: vi.fn<(name: string) => boolean>(),
    executeBrowserTool: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: mocked.execFile,
  spawn: mocked.spawn,
}));

vi.mock("./browser-tools.js", () => ({
  isBrowserToolName: mocked.isBrowserToolName,
  executeBrowserTool: mocked.executeBrowserTool,
}));

import { executeTool } from "./tool-executor.js";

describe("tool executor loop 20 branch tails", () => {
  let tempRoot = "";
  let config: ToolPolicyConfig;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tool-executor-loop20-"));
    config = createConfig(tempRoot);
    mocked.execFile.mockClear();
    mocked.spawn.mockReset();
    mocked.spawnResult = { stdout: "ok", stderr: "", exitCode: 0 };
    mocked.spawn.mockImplementation(() => makeSpawnChild(mocked.spawnResult));
    mocked.execFileAsync.mockReset();
    mocked.execFileAsync.mockResolvedValue({ stdout: "ok", stderr: "" });
    mocked.isBrowserToolName.mockReset();
    mocked.isBrowserToolName.mockReturnValue(false);
    mocked.executeBrowserTool.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("parses shell command quoting, validates cwd, and redacts nonnumeric failures", async () => {
    const cwd = path.join(tempRoot, "work dir");
    await fs.mkdir(cwd);

    const parsed = await executeTool(
      request("shell.exec", { command: 'runner "two words" bare\\ value', cwd }),
      config,
      storageStub(),
    );
    expect(parsed).toMatchObject({
      executable: "runner",
      argv: ["two words", "bare value"],
      cwd: path.resolve(cwd),
      exitCode: 0,
    });
    expect(mocked.spawn).toHaveBeenCalledWith(
      "runner",
      ["two words", "bare value"],
      expect.objectContaining({ cwd: path.resolve(cwd), windowsHide: true }),
    );

    // A non-zero exit with secret-bearing output is scrubbed and the real exit
    // code flows through the manual spawn pipeline.
    mocked.spawnResult = {
      stdout: "Bearer abcdefghijklmnopqrstuvwxyz",
      stderr: "failed with SECRET_TOKEN=abcdefghijklmnopqrstuvwxyz",
      exitCode: 3,
    };

    const failed = await executeTool(request("shell.exec", { command: "runner fail" }), config, storageStub());
    expect(failed).toMatchObject({
      executable: "runner",
      argv: ["fail"],
      exitCode: 3,
      stdout: "[REDACTED]",
      stderr: "failed with [REDACTED]",
    });
  });

  it("searches code files without scanning skipped trees or non-code payloads", async () => {
    const srcDir = path.join(tempRoot, "src");
    const nodeModulesDir = path.join(tempRoot, "node_modules");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(nodeModulesDir, { recursive: true });
    const codeFile = path.join(srcDir, "index.ts");
    const notesFile = path.join(tempRoot, "notes.txt");
    await fs.writeFile(codeFile, "export const needle = true;\n", "utf8");
    await fs.writeFile(notesFile, "needle in operator notes\n", "utf8");
    await fs.writeFile(path.join(nodeModulesDir, "ignored.ts"), "needle should be skipped\n", "utf8");

    const codeSearch = await executeTool(
      request("code.search", { path: tempRoot, query: "NEEDLE", caseSensitive: false, limit: 20 }),
      config,
      storageStub(),
    );
    expect(codeSearch.matches).toEqual([
      expect.objectContaining({
        path: codeFile,
        line: 1,
        lineText: "export const needle = true;",
      }),
    ]);

    const fileFind = await executeTool(
      request("file.find", { path: tempRoot, pattern: "needle", limit: 20 }),
      config,
      storageStub(),
    );
    expect((fileFind.matches as Array<{ path: string }>).map((match) => match.path).sort()).toEqual(
      [codeFile, notesFile].sort(),
    );

    const directoryMatch = await executeTool(
      request("code.search_files", { path: tempRoot, query: "src", limit: 5 }),
      config,
      storageStub(),
    );
    expect(directoryMatch.matches).toEqual([expect.objectContaining({ name: "src", type: "dir" })]);

    const fileRootMatch = await executeTool(
      request("code.search_files", { path: codeFile, query: "INDEX", caseSensitive: false }),
      config,
      storageStub(),
    );
    expect(fileRootMatch.matches).toEqual([expect.objectContaining({ name: "index.ts", type: "file" })]);
  });

  it("lists directories and files with the default filesystem list path", async () => {
    await fs.mkdir(path.join(tempRoot, "child-dir"));
    await fs.writeFile(path.join(tempRoot, "child-file.txt"), "content", "utf8");

    const listed = await executeTool(request("fs.list", { path: tempRoot }), config, storageStub());

    expect(listed.items).toEqual(
      expect.arrayContaining([
        { name: "child-dir", type: "dir" },
        { name: "child-file.txt", type: "file" },
      ]),
    );
  });

  it("sends generic channel webhooks and classifies configuration failures", async () => {
    const fetchMock = vi.fn(async () => new Response("accepted", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = channelStorageStub({
      connectionId: "custom-webhook",
      key: "custom",
      config: { webhookUrl: "https://example.com/hooks/custom" },
    });

    const sent = await executeTool(
      request("channel.send", {
        connectionId: "custom-webhook",
        target: "#ops",
        message: "Generic webhook",
        payload: { priority: "normal" },
      }),
      config,
      storage,
    );

    expect(sent).toMatchObject({
      status: "sent",
      deliveryStatus: "sent",
    });
    expect(storage.commsDeliveries.markSent).toHaveBeenCalledWith(
      "delivery-1",
      expect.stringMatching(/^channel\.send-/),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/hooks/custom",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          text: "Generic webhook",
          target: "#ops",
          payload: { priority: "normal" },
        }),
      }),
    );

    const missingUrl = await executeTool(
      request("channel.send", {
        connectionId: "missing-webhook",
        message: "Missing URL",
      }),
      config,
      channelStorageStub({ connectionId: "missing-webhook", key: "custom", config: {} }),
    );

    expect(missingUrl).toMatchObject({
      status: "failed",
      deliveryStatus: "not_available",
      fallbackReason: "Missing webhook URL",
    });
  });
});

function createConfig(root: string): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: ["example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function request(toolName: string, args: Record<string, unknown> = {}): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent-loop20",
    sessionId: "session-loop20",
  };
}

function storageStub(): Storage & AsyncStorage {
  return {
    toolGrants: {
      listActiveBySession: vi.fn(() => []),
    },
  } as unknown as Storage & AsyncStorage;
}

function channelStorageStub(connection: {
  connectionId: string;
  key: string;
  config: Record<string, unknown>;
}): Storage & AsyncStorage {
  return {
    integrationConnections: {
      get: vi.fn(() => ({
        connectionId: connection.connectionId,
        catalogId: `channel.${connection.key}`,
        kind: "channel",
        key: connection.key,
        label: connection.key,
        enabled: true,
        status: "connected",
        config: connection.config,
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
      })),
    },
    commsDeliveries: {
      createQueued: vi.fn(() => ({
        deliveryId: "delivery-1",
        connectionId: connection.connectionId,
        channelKey: connection.key,
        target: connection.key,
        status: "queued",
        deliveryStatus: "queued",
        payload: {},
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
      })),
      markSent: vi.fn(),
      markFailed: vi.fn(),
    },
    toolGrants: {
      listActiveBySession: vi.fn(() => []),
    },
  } as unknown as Storage & AsyncStorage;
}
