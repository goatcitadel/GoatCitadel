import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeBrowserTool } from "./browser-tools.js";
import { executeTool } from "./tool-executor.js";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = path.join(os.tmpdir(), `goatcitadel-policy-loop24-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  createdDirs.push(root);
  return root;
}

function createConfig(root: string): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: ["example.com", "slack.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function request(toolName: string, args: Record<string, unknown> = {}): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent-loop24",
    sessionId: "session-loop24",
  };
}

function createKnowledgeStorage(): Storage & AsyncStorage {
  const documents = [
    {
      docId: "doc-title-only",
      namespace: "default",
      sourceType: "note",
      sourceRef: "memory://title",
      title: "Fallback Title Match",
      metadata: {},
      createdAt: "2026-05-15T00:00:00.000Z",
    },
  ];
  return {
    knowledge: {
      listDocuments: () => documents,
      listChunksByDocument: () => [],
      listChunksByNamespace: () => [],
      updateChunkEmbedding: () => undefined,
    },
  } as unknown as Storage & AsyncStorage;
}

function createCommsStorage() {
  return {
    integrationConnections: {
      get: () => ({
        connectionId: "connection-loop24",
        key: "slack",
        config: {
          botToken: "xoxb-loop24",
          defaultChannel: "C1234567890",
        },
      }),
    },
    commsDeliveries: {
      createQueued: () => ({
        deliveryId: "delivery-loop24",
        connectionId: "connection-loop24",
        channelKey: "slack",
        target: "C1234567890",
        status: "queued",
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      }),
      markSent: () => undefined,
      markFailed: () => undefined,
    },
  } as unknown as Storage & AsyncStorage;
}

describe("policy-engine loop 24 branch tails", () => {
  it("covers memory title fallback and shell execution error variants", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();

    const memory = await executeTool(request("memory.read", { query: "fallback", limit: 5 }), config, storage);
    expect(memory).toMatchObject({
      namespace: "all",
      query: "fallback",
      items: [
        expect.objectContaining({
          docId: "doc-title-only",
          score: expect.any(Number),
          snippet: "",
        }),
      ],
    });

    const failed = await executeTool(
      request("shell.exec", { command: `goatcitadel-missing-command-${randomUUID()}` }),
      config,
      storage,
    );
    expect(failed).toMatchObject({
      exitCode: -1,
      stdout: "",
    });
    expect(String(failed.stderr)).not.toContain("sk-");
  });

  it("covers Slack no-op send fallback ids without network delivery", async () => {
    const root = createRoot();
    const result = await executeTool(
      request("channel.send", {
        connectionId: "connection-loop24",
        message: "   ",
      }),
      createConfig(root),
      createCommsStorage(),
    );

    expect(result).toMatchObject({
      status: "sent",
      deliveryStatus: "sent",
    });
    expect(String(result.providerMessageId)).toMatch(/^slack-\d+$/);
  });

  it("covers browser argument fallbacks before launching Playwright", async () => {
    const root = createRoot();
    const config = createConfig(root);

    await expect(executeBrowserTool("browser.interact", { url: "https://example.com/app" }, config)).rejects.toThrow(
      /non-empty steps array/,
    );

    await expect(executeBrowserTool("browser.screenshot", { url: "https://example.com/app" }, config)).rejects.toThrow(
      /write jail|jail root|outside/i,
    );
  });
});
