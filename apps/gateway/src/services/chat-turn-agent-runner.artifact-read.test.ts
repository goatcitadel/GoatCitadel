import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest } from "@goatcitadel/contracts";
import { ToolRegistry } from "@goatcitadel/policy-engine";
import {
  persistChatToolArtifact,
  readChatToolArtifactForTool,
  type ChatToolArtifactHost,
} from "./chat-tool-artifact-service.js";
import {
  EffectAwareChatTurnAgentRunner,
  createMockStorage,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Chat stored research artifact continuation", () => {
  it.each(["tool_artifact.read", "fs.read"])(
    "continues from persisted evidence via %s without a workspace read",
    async (requestedTool) => {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-artifact-continuation-"));
      roots.push(rootDir);
      const records = new Map<string, unknown>();
      const host = {
        config: { rootDir, assistant: { dataDir: "data" } },
        storage: {
          chatToolArtifacts: {
            create: async (record: { artifactId: string }) => {
              records.set(record.artifactId, record);
              return record;
            },
            get: async (artifactId: string) => records.get(artifactId),
          },
        },
        requireChatSession: async () => ({ sessionId: "session-1", workspaceId: "workspace-1" }),
      } as unknown as ChatToolArtifactHost;
      let stored: Awaited<ReturnType<typeof persistChatToolArtifact>>;
      const persistToolArtifact = vi.fn(async (input: Parameters<typeof persistChatToolArtifact>[1]) => {
        stored = await persistChatToolArtifact(host, input);
        return stored;
      });
      const pageBody = "Verified budget vacation research. ".repeat(800);
      let calls = 0;
      let artifactWritesAfterWeb = 0;
      let storedContent = "";
      const createChatCompletion = vi.fn(async (): Promise<ChatCompletionResponse> => {
        calls += 1;
        if (calls === 1) return namedToolCallCompletion("browser.navigate", { url: "https://example.com/research" });
        if (calls === 2) {
          artifactWritesAfterWeb = persistToolArtifact.mock.calls.length;
          storedContent = await fs.readFile(path.join(rootDir, "data", stored!.storageRelPath), "utf8");
          return namedToolCallCompletion(
            requestedTool,
            requestedTool === "fs.read"
              ? { path: stored!.storageRelPath.replaceAll("\\", "/") }
              : { artifactId: stored!.artifactId, maxChars: 12000 },
          );
        }
        return {
          model: "test",
          choices: [{ index: 0, message: { role: "assistant", content: "Research retrieved successfully." } }],
        };
      });
      const invokeTool = vi.fn(async (request: ToolInvokeRequest) => {
        if (request.toolName === "browser.navigate")
          return {
            outcome: "executed" as const,
            policyReason: "allowed",
            auditEventId: "web-audit",
            result: { url: "https://example.com/research", body: pageBody, contentType: "text/plain" },
          };
        expect(request.toolName).toBe("tool_artifact.read");
        return {
          outcome: "executed" as const,
          policyReason: "allowed",
          auditEventId: "artifact-audit",
          result: await readChatToolArtifactForTool(host, request),
        };
      });
      const runner = new EffectAwareChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () =>
          new ToolRegistry()
            .toCatalog()
            .filter((tool) => ["browser.navigate", "tool_artifact.read", "fs.read"].includes(tool.toolName)),
        createChatCompletion,
        invokeTool,
        persistToolArtifact,
      });
      const content = "Read the budget vacation research page and report what it says.";
      const result = await runner.run({
        sessionId: "session-1",
        turnId: randomUUID(),
        userMessageId: "message-1",
        content,
        mode: "chat",
        providerId: "openai",
        model: "test",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content }],
      });
      expect(result.turnTrace.status).toBe("completed");
      expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual([
        "browser.navigate",
        "tool_artifact.read",
      ]);
      expect(artifactWritesAfterWeb).toBeGreaterThan(0);
      expect(persistToolArtifact).toHaveBeenCalledTimes(artifactWritesAfterWeb);
      const read = result.turnTrace.toolRuns.find((tool) => tool.toolName === "tool_artifact.read");
      expect(read?.result?.content).toBe(storedContent.slice(0, requestedTool === "fs.read" ? 8000 : 12000));
      expect(read?.result?.content).toContain("Verified budget vacation research.");
      expect(read?.result?.truncated).toBe(true);
      expect(JSON.stringify(createChatCompletion.mock.calls)).not.toContain("ENOENT");
      await expect(fs.stat(path.join(rootDir, "workspace", stored!.storageRelPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
