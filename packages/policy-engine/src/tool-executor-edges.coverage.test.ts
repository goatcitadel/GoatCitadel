import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

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

import { executeTool, resolveExecutableCommand } from "./tool-executor.js";

describe("tool executor edge coverage", () => {
  const priorFetch = globalThis.fetch;
  let tempRoot = "";
  let config: ToolPolicyConfig;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tool-executor-edges-"));
    config = createConfig(tempRoot);
    mocked.execFile.mockClear();
    mocked.spawn.mockClear();
    mocked.isBrowserToolName.mockReset();
    mocked.isBrowserToolName.mockReturnValue(false);
    mocked.executeBrowserTool.mockReset();
    mocked.execFileAsync.mockReset();
    mocked.execFileAsync.mockResolvedValue({ stdout: "executor-output", stderr: "" });
  });

  afterEach(async () => {
    globalThis.fetch = priorFetch;
    vi.unstubAllGlobals();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("dispatches mutating git tools through validated paths without touching the real repo", async () => {
    const filePath = path.join(tempRoot, "src", "feature.ts");
    const worktreePath = path.join(tempRoot, "worktrees", "feature");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "export const ok = true;\n", "utf8");

    await expect(executeTool(request("git.add", { paths: [filePath] }), config, storageStub())).resolves.toMatchObject({
      staged: [filePath],
    });
    await expect(
      executeTool(request("git.commit", { message: "coverage checkpoint" }), config, storageStub()),
    ).resolves.toMatchObject({
      committed: true,
    });
    await expect(
      executeTool(request("git.branch.create", { branch: "codex/coverage-edge" }), config, storageStub()),
    ).resolves.toMatchObject({
      created: true,
      branch: "codex/coverage-edge",
    });
    await expect(
      executeTool(request("git.branch.switch", { branch: "codex/coverage-edge" }), config, storageStub()),
    ).resolves.toMatchObject({
      switched: true,
      branch: "codex/coverage-edge",
    });
    await expect(
      executeTool(
        request("git.worktree.create", { path: worktreePath, branch: "codex/coverage-edge" }),
        config,
        storageStub(),
      ),
    ).resolves.toMatchObject({
      created: true,
      branch: "codex/coverage-edge",
      path: path.resolve(worktreePath),
    });
    await expect(
      executeTool(request("git.worktree.remove", { path: worktreePath }), config, storageStub()),
    ).resolves.toMatchObject({
      removed: true,
      path: path.resolve(worktreePath),
    });
    await expect(
      executeTool(request("build.run", { manager: "pnpm", filter: "@goatcitadel/gateway" }), config, storageStub()),
    ).resolves.toMatchObject({
      manager: "pnpm",
      kind: "build",
    });

    expect(mocked.execFileAsync).toHaveBeenCalledWith("git", ["add", filePath], expect.any(Object));
    expect(mocked.execFileAsync).toHaveBeenCalledWith(
      "git",
      ["commit", "-m", "coverage checkpoint"],
      expect.any(Object),
    );
    expect(mocked.execFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", worktreePath, "codex/coverage-edge"],
      expect.any(Object),
    );
  });

  it("rejects mutating git tools before invoking git when required inputs or jail checks fail", async () => {
    await expect(executeTool(request("git.commit", {}), config, storageStub())).rejects.toThrow(/message is required/i);
    await expect(executeTool(request("git.branch.create", {}), config, storageStub())).rejects.toThrow(
      /branch is required/i,
    );
    await expect(executeTool(request("git.branch.switch", {}), config, storageStub())).rejects.toThrow(
      /branch is required/i,
    );
    await expect(
      executeTool(request("git.worktree.create", { branch: "feature" }), config, storageStub()),
    ).rejects.toThrow(/path is required/i);
    await expect(
      executeTool(request("git.worktree.remove", { path: path.join(os.tmpdir(), "outside") }), config, storageStub()),
    ).rejects.toThrow(/outside write jail/i);
    await expect(
      executeTool(request("git.add", { paths: [path.join(os.tmpdir(), "outside.ts")] }), config, storageStub()),
    ).rejects.toThrow(/outside write jail/i);

    expect(mocked.execFileAsync).not.toHaveBeenCalled();
  });

  it("quotes Windows package-manager command arguments that require cmd escaping", () => {
    const resolved = resolveExecutableCommand(
      "pnpm",
      ["", "run", "test&lint", 'C:\\tmp\\path with "quote"\\'],
      "win32",
    );

    const renderedCommand = resolved.args[3] ?? "";
    expect(renderedCommand).toContain('""');
    expect(renderedCommand).toContain('"test^&lint"');
    expect(renderedCommand).toContain('\\"quote\\"');
    expect(renderedCommand).toContain("\\\\");
  });

  it("classifies channel delivery failures without throwing out of channel.send", async () => {
    const notAvailable = await executeTool(
      request("channel.send", { connectionId: "missing-url", message: "hello" }),
      config,
      commsStorage({
        connectionId: "missing-url",
        key: "webhook",
        config: {},
      }),
    );
    expect(notAvailable).toMatchObject({
      status: "failed",
      deliveryStatus: "not_available",
    });

    globalThis.fetch = vi.fn(async () => new Response("retry later", { status: 503 })) as unknown as typeof fetch;
    const degraded = await executeTool(
      request("channel.send", { connectionId: "retry-webhook", message: "hello" }),
      config,
      commsStorage({
        connectionId: "retry-webhook",
        key: "webhook",
        config: { webhookUrl: "https://example.com/hook" },
      }),
    );
    expect(degraded).toMatchObject({
      status: "failed",
      deliveryStatus: "degraded",
    });

    const blocked = await executeTool(
      request("channel.send", { connectionId: "blocked-webhook", message: "hello" }),
      config,
      commsStorage({
        connectionId: "blocked-webhook",
        key: "webhook",
        config: { webhookUrl: "https://blocked.invalid/hook" },
      }),
    );
    expect(blocked).toMatchObject({
      status: "failed",
      deliveryStatus: "blocked",
    });
  });

  it("sends generic webhook payloads with rendered attachment summaries", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await executeTool(
      request("channel.send", {
        connectionId: "custom-webhook",
        message: "Deployment complete.",
        attachments: [
          { title: "Runbook", url: "https://example.com/runbook" },
          { url: "https://example.com/log.txt" },
          { title: "Only title" },
          { attachmentId: "att-1" },
          { dataBase64: Buffer.from("inline").toString("base64") },
        ],
        payload: { severity: "info" },
      }),
      config,
      commsStorage({
        connectionId: "custom-webhook",
        key: "custom-webhook",
        config: {
          webhookUrl: "https://example.com/hook",
          defaultTarget: "ops",
        },
      }),
    );

    expect(result).toMatchObject({
      status: "sent",
    });
    const firstCall = fetchMock.mock.calls[0] as [string | URL, RequestInit & { body?: BodyInit | null }] | undefined;
    const body = String(firstCall?.[1]?.body ?? "");
    expect(body).toContain("Runbook: https://example.com/runbook");
    expect(body).toContain("attachment att-1");
    expect(body).toContain("inline attachment");
    expect(body).toContain('"severity":"info"');
  });

  it("sends ntfy outbound notifications and respects dry-run delivery", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200, headers: { "x-message-id": "ntfy-msg-1" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "ntfy.example.com");

    const live = await executeTool(
      request("channel.send", {
        connectionId: "ntfy-live",
        message: "Release proof finished.",
        title: "Ops",
        priority: "5",
      }),
      commsConfig,
      commsStorage({
        connectionId: "ntfy-live",
        key: "ntfy",
        config: {
          baseUrl: "https://ntfy.example.com",
          topic: "goatcitadel-ops",
          token: "ntfy-token",
          priority: "2",
        },
      }),
    );

    expect(live).toMatchObject({ status: "sent", providerMessageId: "ntfy-msg-1" });
    const firstCall = fetchMock.mock.calls[0] as [string | URL, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(firstCall?.[0])).toBe("https://ntfy.example.com/goatcitadel-ops");
    expect(firstCall?.[1]?.body).toBe("Release proof finished.");
    expect(firstCall?.[1]?.headers).toMatchObject({
      Authorization: "Bearer ntfy-token",
      Priority: "5",
      Title: "Ops",
    });

    const dryRun = await executeTool(
      request("channel.send", {
        connectionId: "ntfy-dry-run",
        message: "Validate only.",
      }),
      commsConfig,
      commsStorage({
        connectionId: "ntfy-dry-run",
        key: "ntfy",
        config: {
          baseUrl: "https://ntfy.example.com",
          topic: "goatcitadel-ops",
          dryRun: true,
        },
      }),
    );

    expect(dryRun).toMatchObject({ status: "sent" });
    expect(String(dryRun.providerMessageId)).toMatch(/^ntfy-dry-run-/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dispatches Slack and Discord reaction and unsend adapters", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://slack.com/api/reactions.add") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://slack.com/api/chat.delete") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/reactions/")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("/messages/msg-discord-webhook")) {
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "slack.com", "discord.com");

    const slackReact = await executeTool(
      request("channel.react", { connectionId: "slack-react", messageId: "1712345678.000100", reaction: ":rocket:" }),
      commsConfig,
      commsStorage({
        connectionId: "slack-react",
        key: "slack",
        config: { botToken: "xoxb-test", defaultChannel: "C123" },
      }),
    );
    expect(slackReact).toMatchObject({ status: "sent", providerMessageId: "1712345678.000100" });

    const slackUnsend = await executeTool(
      request("slack.unsend", { connectionId: "slack-unsend", messageId: "1712345678.000100" }),
      commsConfig,
      commsStorage({
        connectionId: "slack-unsend",
        key: "slack",
        config: { botToken: "xoxb-test", defaultChannel: "C123" },
      }),
    );
    expect(slackUnsend).toMatchObject({ status: "sent", providerMessageId: "1712345678.000100" });

    const discordReact = await executeTool(
      request("discord.react", { connectionId: "discord-react", messageId: "msg-discord", reaction: "✅" }),
      commsConfig,
      commsStorage({
        connectionId: "discord-react",
        key: "discord",
        config: { botToken: "discord-token", defaultChannelId: "D123" },
      }),
    );
    expect(discordReact).toMatchObject({ status: "sent", providerMessageId: "msg-discord" });

    const discordUnsend = await executeTool(
      request("channel.unsend", { connectionId: "discord-unsend", messageId: "msg-discord-webhook" }),
      commsConfig,
      commsStorage({
        connectionId: "discord-unsend",
        key: "discord",
        config: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      }),
    );
    expect(discordUnsend).toMatchObject({ status: "sent", providerMessageId: "msg-discord-webhook" });
  });

  it("ingests URL documents through the allowlisted fetch backend", async () => {
    const storage = knowledgeStorage();
    globalThis.fetch = vi.fn(
      async () =>
        new Response("# Remote Doc\n\nFetched context for coverage.", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }),
    ) as unknown as typeof fetch;

    const ingested = await executeTool(
      request("docs.ingest", {
        sourceType: "url",
        source: "https://example.com/docs/coverage.md",
        namespace: "docs",
        title: "Remote Coverage Doc",
      }),
      config,
      storage,
    );

    expect(ingested).toMatchObject({
      fetchResult: expect.objectContaining({
        statusCode: 200,
      }),
      chunksSaved: expect.any(Number),
    });
    const searched = await executeTool(
      request("docs.search", { namespace: "docs", query: "coverage" }),
      config,
      storage,
    );
    expect((searched.items as Array<Record<string, unknown>>)[0]?.content).toContain("coverage");
  });

  it("covers memory read cache hits and citation source filtering", async () => {
    const repeatedDoc = {
      docId: "doc-alpha",
      title: "Alpha notes",
      sourceRef: "memory://alpha",
      metadata: { kind: "note" },
    };
    const listChunksByDocument = vi.fn((docId: string) =>
      docId === "doc-alpha"
        ? [
            {
              chunkId: "chunk-alpha",
              content: "Alpha content matches the query.",
            },
          ]
        : [
            {
              chunkId: "chunk-beta",
              content: "Unrelated beta content.",
            },
          ],
    );
    const storage = {
      knowledge: {
        listDocuments: vi.fn(() => [
          repeatedDoc,
          {
            docId: "doc-beta",
            title: "Beta notes",
            sourceRef: "memory://beta",
            metadata: {},
          },
          repeatedDoc,
        ]),
        listChunksByDocument,
      },
    } as unknown as Storage;

    const memory = await executeTool(request("memory.read", { namespace: "user", query: "alpha" }), config, storage);
    expect(memory).toMatchObject({ namespace: "user", query: "alpha" });
    expect((memory.items as Array<Record<string, unknown>>).length).toBe(2);
    expect(listChunksByDocument).toHaveBeenCalledTimes(2);

    const citations = await executeTool(
      request("citations.build", {
        sources: [{ title: "No URL" }, { title: "With URL", url: "https://example.com/source", description: "kept" }],
      }),
      config,
      storageStub(),
    );
    expect(citations).toMatchObject({ count: 1 });
    expect((citations.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: "With URL",
      url: "https://example.com/source",
    });
  });

  it("searches file names through file roots, skipped directories, limits, and case-sensitive mode", async () => {
    const fileRoot = path.join(tempRoot, "SearchTarget.ts");
    const nestedRoot = path.join(tempRoot, "search-tree");
    await fs.writeFile(fileRoot, "export const value = true;\n", "utf8");
    await fs.mkdir(path.join(nestedRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(nestedRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(nestedRoot, ".git", "MatchIgnored.ts"), "ignored\n", "utf8");
    await fs.writeFile(path.join(nestedRoot, "src", "MatchOne.ts"), "one\n", "utf8");
    await fs.writeFile(path.join(nestedRoot, "src", "MatchTwo.ts"), "two\n", "utf8");

    const fileMatch = await executeTool(
      request("code.search_files", { path: fileRoot, query: "SearchTarget", caseSensitive: true }),
      config,
      storageStub(),
    );
    expect(fileMatch).toMatchObject({ count: 1 });
    expect((fileMatch.matches as Array<Record<string, unknown>>)[0]).toMatchObject({
      path: path.resolve(fileRoot),
      type: "file",
    });

    const limited = await executeTool(
      request("code.search_files", { path: nestedRoot, query: "match", limit: 1 }),
      config,
      storageStub(),
    );
    expect(limited).toMatchObject({ count: 1 });
    expect(String((limited.matches as Array<Record<string, unknown>>)[0]?.path)).not.toContain(
      `${path.sep}.git${path.sep}`,
    );
  });

  it("honors only active read grants with usable allowed paths", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-executor-grant-"));
    const outsideFile = path.join(outsideDir, "granted.txt");
    await fs.writeFile(outsideFile, "grant ok\n", "utf8");
    const now = Date.now();
    const grants = [
      grantRecord("grant-revoked", { allowedPaths: [outsideDir], revokedAt: new Date(now).toISOString() }),
      grantRecord("grant-expired", { allowedPaths: [outsideDir], expiresAt: new Date(now - 1000).toISOString() }),
      grantRecord("grant-used", { allowedPaths: [outsideDir], usesRemaining: 0 }),
      grantRecord("grant-no-paths", { allowedPaths: [] }),
      grantRecord("grant-active", { allowedPaths: [outsideDir], usesRemaining: 1 }),
    ];
    const storage = {
      toolGrants: {
        list: vi.fn(() => grants),
      },
    } as unknown as Storage;

    try {
      const result = await executeTool(
        {
          ...request("file.read_range", { path: outsideFile, startLine: 1, endLine: 1 }),
          taskId: "task-granted-read",
        },
        config,
        storage,
      );
      expect(result).toMatchObject({ content: "grant ok" });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("dispatches Gmail and Calendar read/write adapters through allowlisted Google APIs", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")) {
        expect(String(init?.body ?? "")).toContain("raw");
        return new Response(JSON.stringify({ id: "gmail-sent-1" }), { status: 200 });
      }
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")) {
        expect(url).toContain("q=from%3Ame");
        return new Response(JSON.stringify({ messages: [{ id: "gmail-read-1" }] }), { status: 200 });
      }
      if (url.includes("/calendar/v3/calendars/primary/events") && init?.method === "POST") {
        expect(String(init.body ?? "")).toContain('"summary":"Coverage sync"');
        return new Response(JSON.stringify({ id: "calendar-created-1" }), { status: 200 });
      }
      if (url.includes("/calendar/v3/calendars/team%40example.com/events")) {
        expect(url).toContain("timeMin=2026-03-22T00%3A00%3A00.000Z");
        return new Response(JSON.stringify({ items: [{ id: "calendar-read-1" }] }), { status: 200 });
      }
      throw new Error(`Unexpected Google API URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const googleConfig = withAllowlist(config, "gmail.googleapis.com", "www.googleapis.com");

    const gmailRead = await executeTool(
      request("gmail.read", { connectionId: "gmail", query: "from:me", maxResults: 2 }),
      googleConfig,
      commsStorage({ connectionId: "gmail", key: "gmail", config: { accessToken: "gmail-token" } }),
    );
    expect(gmailRead).toMatchObject({ status: "sent", providerMessageId: "gmail-read" });
    expect(gmailRead.records).toEqual([{ id: "gmail-read-1" }]);

    const gmailSend = await executeTool(
      request("gmail.send", {
        connectionId: "gmail-send",
        to: ["ops@example.com"],
        subject: "Coverage",
        bodyText: "Adapter proof.",
      }),
      googleConfig,
      commsStorage({ connectionId: "gmail-send", key: "gmail", config: { accessToken: "gmail-token" } }),
    );
    expect(gmailSend).toMatchObject({ status: "sent", providerMessageId: "gmail-sent-1" });

    const calendarList = await executeTool(
      request("calendar.list", {
        connectionId: "calendar",
        calendarId: "team@example.com",
        fromIso: "2026-03-22T00:00:00.000Z",
        toIso: "2026-03-23T00:00:00.000Z",
        maxResults: 3,
      }),
      googleConfig,
      commsStorage({ connectionId: "calendar", key: "calendar", config: { accessToken: "calendar-token" } }),
    );
    expect(calendarList).toMatchObject({ status: "sent", providerMessageId: "calendar-list" });
    expect(calendarList.records).toEqual([{ id: "calendar-read-1" }]);

    const calendarCreate = await executeTool(
      request("calendar.create_event", {
        connectionId: "calendar-create",
        title: "Coverage sync",
        startIso: "2026-03-22T17:00:00.000Z",
        endIso: "2026-03-22T17:30:00.000Z",
        attendees: ["ops@example.com"],
      }),
      googleConfig,
      commsStorage({ connectionId: "calendar-create", key: "calendar", config: { accessToken: "calendar-token" } }),
    );
    expect(calendarCreate).toMatchObject({ status: "sent", providerMessageId: "calendar-created-1" });
  });

  it("covers direct channel suffix routing, Slack webhooks, and unsupported inline webhook attachments", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "hooks.slack.com", "outlook.office.com", "chat.googleapis.com");

    const sent = await executeTool(
      request("slack.send", {
        connectionId: "slack-webhook",
        message: "Deployment complete.",
        attachments: [
          { title: "Runbook", url: "https://example.com/runbook" },
          { title: "Graph", url: "https://example.com/graph.png", mimeType: "image/png" },
        ],
      }),
      commsConfig,
      commsStorage({
        connectionId: "slack-webhook",
        key: "custom-slack-wrapper",
        config: { webhookUrl: "https://hooks.slack.com/services/T/B/C" },
      }),
    );
    expect(sent).toMatchObject({ status: "sent" });

    const inlineSlack = await executeTool(
      request("slack.send", {
        connectionId: "slack-inline-webhook",
        message: "inline",
        attachments: [{ title: "inline.txt", dataBase64: Buffer.from("inline").toString("base64") }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "slack-inline-webhook",
        key: "custom-slack-wrapper",
        config: { webhookUrl: "https://hooks.slack.com/services/T/B/C" },
      }),
    );
    expect(inlineSlack).toMatchObject({ status: "failed", deliveryStatus: "degraded" });

    const teamsInline = await executeTool(
      request("teams.send", {
        connectionId: "teams-inline",
        message: "inline",
        attachments: [{ title: "inline.txt", dataBase64: Buffer.from("inline").toString("base64") }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "teams-inline",
        key: "teams",
        config: { webhookUrl: "https://outlook.office.com/webhook/example" },
      }),
    );
    expect(teamsInline).toMatchObject({ status: "failed", deliveryStatus: "degraded" });

    const googleChatInline = await executeTool(
      request("google-chat.send", {
        connectionId: "google-chat-inline",
        message: "inline",
        attachments: [{ title: "inline.txt", dataBase64: Buffer.from("inline").toString("base64") }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "google-chat-inline",
        key: "google-chat",
        config: { webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=test&token=test" },
      }),
    );
    expect(googleChatInline).toMatchObject({ status: "failed", deliveryStatus: "degraded" });

    const unsupportedReact = await executeTool(
      request("channel.react", { connectionId: "webhook-react", messageId: "msg-1", reaction: "seen" }),
      commsConfig,
      commsStorage({
        connectionId: "webhook-react",
        key: "webhook",
        config: { webhookUrl: "https://example.com/hook" },
      }),
    );
    expect(unsupportedReact).toMatchObject({ status: "failed", deliveryStatus: "not_available" });

    const unsupportedUnsend = await executeTool(
      request("channel.unsend", { connectionId: "webhook-unsend", messageId: "msg-1" }),
      commsConfig,
      commsStorage({
        connectionId: "webhook-unsend",
        key: "webhook",
        config: { webhookUrl: "https://example.com/hook" },
      }),
    );
    expect(unsupportedUnsend).toMatchObject({ status: "failed", deliveryStatus: "not_available" });
  });

  it("covers HTTP redirect, retry-after, and abort retry branches", async () => {
    let mode: "missing-location" | "too-many" | "retry-date" | "retry-invalid" | "abort-retry" | "abort-event" =
      "missing-location";
    let calls = 0;
    const eventAbortController = new AbortController();
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (mode === "missing-location") {
        return new Response("", { status: 302 });
      }
      if (mode === "too-many") {
        return new Response("", { status: 302, headers: { location: "/again" } });
      }
      if (mode === "retry-date" && calls === 1) {
        return new Response("retry", {
          status: 503,
          headers: { "retry-after": new Date(Date.now() - 1000).toUTCString() },
        });
      }
      if (mode === "retry-invalid" && calls === 1) {
        return new Response("retry", { status: 503, headers: { "retry-after": "not-a-date" } });
      }
      if (mode === "abort-retry") {
        return new Response("retry", { status: 503, headers: { "retry-after": "1" } });
      }
      if (mode === "abort-event") {
        setTimeout(() => eventAbortController?.abort(new Error("event abort")), 0);
        return new Response("retry", { status: 503, headers: { "retry-after": "1" } });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const httpConfig = withAllowlist(config, "example.com");

    await expect(
      executeTool(request("http.get", { url: "https://example.com/start" }), httpConfig, storageStub()),
    ).rejects.toThrow(/Redirect missing location/i);

    mode = "too-many";
    calls = 0;
    await expect(
      executeTool(request("http.get", { url: "https://example.com/start" }), httpConfig, storageStub()),
    ).rejects.toThrow(/Too many redirects/i);

    mode = "retry-date";
    calls = 0;
    await expect(
      executeTool(request("http.get", { url: "https://example.com/retry" }), httpConfig, storageStub()),
    ).resolves.toMatchObject({ status: 200, body: "ok" });

    mode = "retry-invalid";
    calls = 0;
    await expect(
      executeTool(request("http.get", { url: "https://example.com/retry-invalid" }), httpConfig, storageStub()),
    ).resolves.toMatchObject({ status: 200, body: "ok" });

    mode = "abort-retry";
    calls = 0;
    const controller = new AbortController();
    controller.abort(new Error("stop retry"));
    const aborted = executeTool(
      { ...request("http.get", { url: "https://example.com/abort" }), signal: controller.signal },
      httpConfig,
      storageStub(),
    );
    await expect(aborted).rejects.toThrow(/stop retry/i);

    mode = "abort-event";
    calls = 0;
    await expect(
      executeTool(
        { ...request("http.get", { url: "https://example.com/abort-event" }), signal: eventAbortController.signal },
        httpConfig,
        storageStub(),
      ),
    ).rejects.toThrow(/event abort/i);
  });

  it("covers shell command parsing and boolean coercion edge cases", async () => {
    mocked.execFileAsync.mockResolvedValue({ stdout: "shell-ok", stderr: "" });

    await expect(
      executeTool(request("shell.exec", { command: "node\u0000bad" }), config, storageStub()),
    ).rejects.toThrow(/invalid null byte/i);
    await expect(
      executeTool(request("shell.exec", { command: 'node "unterminated' }), config, storageStub()),
    ).rejects.toThrow(/unmatched quotes/i);

    const parsed = await executeTool(
      request("shell.exec", { command: "node 'two words' \\\"quoted\\\" path\\x" }),
      config,
      storageStub(),
    );
    expect(parsed).toMatchObject({
      executable: "node",
      argv: ["two words", '"quoted"', "path\\x"],
      exitCode: 0,
    });

    const deleteRoot = path.join(tempRoot, "delete-bool");
    const nestedFile = path.join(deleteRoot, "nested", "file.txt");
    await fs.mkdir(path.dirname(nestedFile), { recursive: true });
    await fs.writeFile(nestedFile, "delete me\n", "utf8");
    await expect(
      executeTool(request("fs.delete", { path: deleteRoot, recursive: "true" }), config, storageStub()),
    ).resolves.toMatchObject({ deleted: true });

    const fileDelete = path.join(tempRoot, "delete-file.txt");
    await fs.writeFile(fileDelete, "delete file\n", "utf8");
    await expect(
      executeTool(request("fs.delete", { path: fileDelete, recursive: "false" }), config, storageStub()),
    ).resolves.toMatchObject({ deleted: true });
  });

  it("normalizes shell failures and restricted command defaults", async () => {
    mocked.execFileAsync.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "ENOEXEC" }));

    await expect(
      executeTool(request("shell.exec", { command: "node fail.js" }), config, storageStub()),
    ).resolves.toMatchObject({
      executable: "node",
      argv: ["fail.js"],
      stdout: "",
      stderr: "boom",
      exitCode: -1,
    });

    mocked.execFileAsync.mockResolvedValue({ stdout: "restricted-ok", stderr: "" });
    await expect(executeTool(request("tests.run", {}), config, storageStub())).resolves.toMatchObject({
      manager: "pnpm",
      kind: "test",
    });
    await expect(executeTool(request("lint.run", { manager: "npm" }), config, storageStub())).resolves.toMatchObject({
      manager: "npm",
      kind: "lint",
    });
    await expect(
      executeTool(request("build.run", { manager: "pnpm", filter: "bad;filter" }), config, storageStub()),
    ).rejects.toThrow(/invalid filter/i);
    await expect(executeTool(request("tests.run", { manager: "yarn" }), config, storageStub())).rejects.toThrow(
      /only pnpm\/npm/i,
    );
  });

  it("covers content search skips, code-only filtering, and full-disk read bypass", async () => {
    const searchRoot = path.join(tempRoot, "content-search");
    await fs.mkdir(path.join(searchRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(searchRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(searchRoot, ".git", "ignored.ts"), "needle ignored\n", "utf8");
    await fs.writeFile(path.join(searchRoot, "notes.txt"), "needle notes\n", "utf8");
    await fs.writeFile(path.join(searchRoot, "src", "a-no-match.ts"), "nothing here\n", "utf8");
    await fs.writeFile(path.join(searchRoot, "src", "feature.ts"), "needle code\n", "utf8");
    await fs.writeFile(path.join(searchRoot, "src", "other.ts"), "needle other\n", "utf8");

    const contentMatches = await executeTool(
      request("code.search", { path: searchRoot, query: "needle", limit: 1 }),
      config,
      storageStub(),
    );
    expect(contentMatches).toMatchObject({ count: 1 });
    const matchPath = String((contentMatches.matches as Array<Record<string, unknown>>)[0]?.path ?? "");
    expect(matchPath).toMatch(/\.ts$/);
    expect(matchPath).not.toContain(`${path.sep}.git${path.sep}`);

    const skippedNonCodeFile = await executeTool(
      request("code.search", { path: path.join(searchRoot, "notes.txt"), query: "needle" }),
      config,
      storageStub(),
    );
    expect(skippedNonCodeFile).toMatchObject({ count: 0 });

    const longDoc = `${"x".repeat(1300)} needle ${"y".repeat(1300)}`;
    await expect(
      executeTool(
        request("memory.write", { namespace: "long-doc", title: "Long Doc", content: longDoc }),
        config,
        knowledgeStorage(),
      ),
    ).resolves.toMatchObject({ chunksSaved: expect.any(Number) });

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-executor-full-disk-"));
    const outsideFile = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideFile, "full disk read\n", "utf8");
    try {
      await expect(
        executeTool(
          request("file.read_range", { path: outsideFile, startLine: 1, endLine: 1 }),
          { ...config, sandbox: { ...config.sandbox, readAccessMode: "full_disk" } },
          storageStub(),
        ),
      ).resolves.toMatchObject({ content: "full disk read" });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

function createConfig(root: string): ToolPolicyConfig {
  return {
    profiles: {
      danger: ["*"],
    },
    tools: {
      profile: "danger",
      approvalMode: "bypass",
      allow: [],
      deny: [],
    },
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

function withAllowlist(base: ToolPolicyConfig, ...hosts: string[]): ToolPolicyConfig {
  return {
    ...base,
    sandbox: {
      ...base.sandbox,
      networkAllowlist: [...base.sandbox.networkAllowlist, ...hosts],
    },
  };
}

function request(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent",
    sessionId: "session",
  };
}

function storageStub(): Storage {
  return {
    pendingApprovalActions: {
      find: vi.fn(() => undefined),
    },
  } as unknown as Storage;
}

function commsStorage(connection: { connectionId: string; key: string; config: Record<string, unknown> }): Storage {
  return {
    integrationConnections: {
      get: vi.fn(() => connection),
    },
    commsDeliveries: {
      createQueued: vi.fn((input: Record<string, unknown>) => ({
        deliveryId: `delivery-${connection.connectionId}`,
        status: "queued",
        channelKey: input.channelKey,
        target: input.target,
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      })),
      markSent: vi.fn(),
      markFailed: vi.fn(),
    },
  } as unknown as Storage;
}

function knowledgeStorage(): Storage {
  const documents: Array<Record<string, unknown>> = [];
  const chunksByDocId = new Map<string, Array<Record<string, unknown>>>();
  let documentSeq = 0;
  let chunkSeq = 0;

  return {
    knowledge: {
      listDocuments: vi.fn((namespace?: string) =>
        documents.filter((doc) => !namespace || doc.namespace === namespace),
      ),
      createDocument: vi.fn((input: Record<string, unknown>) => {
        const doc = {
          docId: `doc-${++documentSeq}`,
          namespace: input.namespace,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          title: input.title,
          metadata: input.metadata ?? {},
          createdAt: new Date().toISOString(),
        };
        documents.unshift(doc);
        return doc;
      }),
      appendChunks: vi.fn((docId: string, entries: Array<Record<string, unknown>>) => {
        const saved = entries.map((entry, index) => ({
          chunkId: `chunk-${++chunkSeq}`,
          docId,
          seq: index,
          content: String(entry.content ?? ""),
          embedding: entry.embedding as number[] | undefined,
          tokenEstimate: 1,
          createdAt: new Date().toISOString(),
        }));
        chunksByDocId.set(docId, [...(chunksByDocId.get(docId) ?? []), ...saved]);
        return saved;
      }),
      listChunksByDocument: vi.fn((docId: string) => chunksByDocId.get(docId) ?? []),
      listChunksByNamespace: vi.fn((namespace?: string) => {
        const matchingDocIds = documents
          .filter((doc) => !namespace || doc.namespace === namespace)
          .map((doc) => String(doc.docId));
        return matchingDocIds.flatMap((docId) => chunksByDocId.get(docId) ?? []);
      }),
      updateChunkEmbedding: vi.fn(),
    },
  } as unknown as Storage;
}

function grantRecord(
  grantId: string,
  options: {
    allowedPaths: string[];
    expiresAt?: string;
    revokedAt?: string;
    usesRemaining?: number;
  },
) {
  return {
    grantId,
    toolPattern: "file.read_range",
    decision: "allow",
    scope: "task",
    scopeRef: "task-granted-read",
    grantType: "persistent",
    constraints: { allowedPaths: options.allowedPaths },
    createdBy: "test",
    createdAt: "2026-03-22T00:00:00.000Z",
    expiresAt: options.expiresAt,
    revokedAt: options.revokedAt,
    usesRemaining: options.usesRemaining,
  };
}
