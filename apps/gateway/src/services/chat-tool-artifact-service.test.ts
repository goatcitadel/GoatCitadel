import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@goatcitadel/contracts";
import {
  getChatToolArtifactContent,
  persistChatToolArtifact,
  type ChatToolArtifactHost,
} from "./chat-tool-artifact-service.js";

describe("chat tool artifact service", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-tool-artifact-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("persists tool artifacts with inferred extensions and bounded snippets", async () => {
    const host = fakeHost(rootDir);

    const json = await persistChatToolArtifact(host, input("application/json", "x".repeat(4100)));
    const markdown = await persistChatToolArtifact(host, input("text/markdown"));
    const html = await persistChatToolArtifact(host, input("text/html"));
    const xml = await persistChatToolArtifact(host, input("application/xml"));
    const text = await persistChatToolArtifact(host, input(undefined));

    expect(json.storageRelPath).toMatch(/\.json$/);
    expect(markdown.storageRelPath).toMatch(/\.md$/);
    expect(html.storageRelPath).toMatch(/\.html$/);
    expect(xml.storageRelPath).toMatch(/\.xml$/);
    expect(text.storageRelPath).toMatch(/\.txt$/);
    expect(json.snippet).toHaveLength(4000);
    expect(host.storage.chatToolArtifacts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        toolRunId: "tool-run-1",
        toolName: "browser.search",
        byteLength: Buffer.byteLength("artifact body", "utf8"),
        createdAt: "2026-05-14T00:00:00.000Z",
      }),
    );

    await expect(fs.readFile(path.join(rootDir, "data", text.storageRelPath), "utf8")).resolves.toBe("artifact body");
  });

  it("does not rewrite an existing content-addressed artifact file", async () => {
    const host = fakeHost(rootDir);

    const first = await persistChatToolArtifact(host, input("text/plain"));
    await fs.writeFile(path.join(rootDir, "data", first.storageRelPath), "preexisting", "utf8");
    await persistChatToolArtifact(host, input("text/plain"));

    await expect(fs.readFile(path.join(rootDir, "data", first.storageRelPath), "utf8")).resolves.toBe("preexisting");
  });

  it("loads artifact content only for the owning workspace inside the data root", async () => {
    const host = fakeHost(rootDir);
    const persisted = await persistChatToolArtifact(host, input("text/plain"));

    await expect(
      getChatToolArtifactContent(host, persisted.artifactId, { workspaceId: " workspace-1 " }),
    ).resolves.toEqual(
      expect.objectContaining({
        artifact: expect.objectContaining({ artifactId: persisted.artifactId }),
        content: "artifact body",
      }),
    );

    await expect(getChatToolArtifactContent(host, persisted.artifactId, { workspaceId: " " })).rejects.toBeInstanceOf(
      ValidationError,
    );
    host.requireChatSession.mockReturnValueOnce({ sessionId: "session-1", workspaceId: "workspace-2" } as never);
    await expect(
      getChatToolArtifactContent(host, persisted.artifactId, { workspaceId: "workspace-1" }),
    ).rejects.toThrow("Artifact does not belong to the requested workspace.");
    host.storage.chatToolArtifacts.get.mockReturnValueOnce({
      artifactId: "artifact-escape",
      sessionId: "session-1",
      turnId: "turn-1",
      toolRunId: "tool-run-1",
      toolName: "browser.search",
      byteLength: 1,
      storageRelPath: "..\\escape.txt",
      createdAt: "2026-05-14T00:00:00.000Z",
    });
    await expect(getChatToolArtifactContent(host, "artifact-escape", { workspaceId: "workspace-1" })).rejects.toThrow(
      "Artifact path escapes the configured data directory.",
    );
  });
});

function input(contentType?: string, snippet = "short snippet") {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    toolRunId: "tool-run-1",
    toolName: "browser.search",
    content: "artifact body",
    contentType,
    snippet,
    createdAt: "2026-05-14T00:00:00.000Z",
  };
}

function fakeHost(rootDir: string) {
  const records = new Map<string, ReturnType<typeof record>>();
  const host = {
    config: {
      rootDir,
      assistant: { dataDir: "data" },
    },
    storage: {
      chatToolArtifacts: {
        create: vi.fn((input: ReturnType<typeof record>) => {
          records.set(input.artifactId, input);
          return input;
        }),
        get: vi.fn((artifactId: string) => records.get(artifactId) ?? record({ artifactId })),
      },
    },
    requireChatSession: vi.fn(() => ({ sessionId: "session-1", workspaceId: "workspace-1" })),
  } satisfies ChatToolArtifactHost;
  return host;
}

function record(
  input: Partial<{
    artifactId: string;
    sessionId: string;
    turnId: string;
    toolRunId: string;
    toolName: string;
    contentType?: string;
    byteLength: number;
    snippet?: string;
    storageRelPath: string;
    createdAt: string;
  }> = {},
) {
  return {
    artifactId: input.artifactId ?? "artifact-1",
    sessionId: input.sessionId ?? "session-1",
    turnId: input.turnId ?? "turn-1",
    toolRunId: input.toolRunId ?? "tool-run-1",
    toolName: input.toolName ?? "browser.search",
    contentType: input.contentType,
    byteLength: input.byteLength ?? 13,
    snippet: input.snippet,
    storageRelPath: input.storageRelPath ?? "tool-artifacts/aa/artifact.txt",
    createdAt: input.createdAt ?? "2026-05-14T00:00:00.000Z",
  };
}
