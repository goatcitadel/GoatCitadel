import { describe, expect, it, vi } from "vitest";
import { ResearchService } from "./research-service.js";

describe("ResearchService policy context", () => {
  it("passes parent run and task policy lineage into browser search", async () => {
    const create = vi.fn();
    const patch = vi.fn();
    const replaceForRun = vi.fn(() => []);
    const invokeTool = vi.fn(async () => ({
      outcome: "executed" as const,
      policyReason: "ok",
      auditEventId: "audit-1",
      result: { results: [] },
    }));
    const resolveToolPolicyContext = vi.fn(async (input) => ({
      ...input,
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      permissionProfile: {
        profileId: "profile-1",
        label: "Test",
        builtin: false,
        status: "active",
        scope: "workspace",
        approvalMode: "approve_all",
        toolPatterns: ["browser.search"],
        allow: [],
        deny: [],
        createdBy: "operator-1",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      },
    }));
    const service = new ResearchService({
      storage: {
        researchRuns: { create, patch },
        researchSources: { replaceForRun },
        chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "workspace-1" })) },
      } as never,
      invokeTool,
      createChatCompletion: vi.fn(async () => ({
        choices: [{ message: { role: "assistant", content: "No sources." } }],
      })),
      resolveToolPolicyContext,
    });

    await service.run({
      sessionId: "session-1",
      query: "policy lineage",
      mode: "quick",
      workspaceId: "workspace-1",
      policyRunId: "parent-run-1",
      policyTaskId: "parent-task-1",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "loopback",
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      surface: "cowork",
    });

    expect(resolveToolPolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "parent-run-1",
        taskId: "parent-task-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        surface: "cowork",
      }),
    );
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        workspaceId: "workspace-1",
        runId: "parent-run-1",
        taskId: "parent-task-1",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
        surface: "cowork",
      }),
    );
  });

  describe("deep mode and untrusted sources", () => {
    const searchResults = [1, 2, 3, 4, 5].map((n) => ({
      title: `Source ${n}`,
      url: `https://example.com/${n}`,
      snippet: `snippet ${n}`,
    }));

    function createService(
      navigate: (url: string) => Promise<unknown> = async (url) => ({
        outcome: "executed" as const,
        policyReason: "ok",
        auditEventId: "audit-nav",
        result: { textSnippet: `page text for ${url}` },
      }),
    ) {
      const invokeTool = vi.fn(async (request: { toolName: string; args: Record<string, unknown> }) => {
        if (request.toolName === "browser.search") {
          return {
            outcome: "executed" as const,
            policyReason: "ok",
            auditEventId: "audit-search",
            result: { results: searchResults },
          };
        }
        return navigate(String(request.args.url));
      });
      const createChatCompletion = vi.fn(async (_request: unknown) => ({
        choices: [{ message: { role: "assistant", content: "Summary." } }],
      }));
      const service = new ResearchService({
        storage: {
          researchRuns: { create: vi.fn(), patch: vi.fn() },
          researchSources: {
            replaceForRun: vi.fn(async (_runId: string, sources: unknown[]) => sources),
          },
          chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "workspace-1" })) },
        } as never,
        invokeTool: invokeTool as never,
        createChatCompletion: createChatCompletion as never,
      });
      return { service, invokeTool, createChatCompletion };
    }

    function userPrompt(createChatCompletion: ReturnType<typeof vi.fn>): string {
      const request = createChatCompletion.mock.calls[0]?.[0] as {
        messages: Array<{ content: string }>;
      };
      return request.messages[1]?.content ?? "";
    }

    it("opens the top 3 sources in deep mode and adds page excerpts to the prompt", async () => {
      const { service, invokeTool, createChatCompletion } = createService();

      await service.run({ sessionId: "session-1", query: "q", mode: "deep", workspaceId: "workspace-1" });

      expect(invokeTool).toHaveBeenCalledTimes(4);
      const navigateCalls = invokeTool.mock.calls.slice(1).map(([request]) => request);
      expect(navigateCalls.map((request) => request.toolName)).toEqual([
        "browser.navigate",
        "browser.navigate",
        "browser.navigate",
      ]);
      expect(navigateCalls.map((request) => request.args)).toEqual([
        { url: "https://example.com/1", maxChars: 4000 },
        { url: "https://example.com/2", maxChars: 4000 },
        { url: "https://example.com/3", maxChars: 4000 },
      ]);
      expect(navigateCalls[0]).toMatchObject({
        agentId: "research",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        consentContext: { source: "agent", reason: "research:deep" },
      });
      const prompt = userPrompt(createChatCompletion);
      expect(prompt).toContain("Page excerpt: page text for https://example.com/1");
      expect(prompt).toContain("Page excerpt: page text for https://example.com/3");
      expect(prompt).not.toContain("page text for https://example.com/4");
    });

    it("opens no pages in quick mode", async () => {
      const { service, invokeTool, createChatCompletion } = createService();

      await service.run({ sessionId: "session-1", query: "q", mode: "quick" });

      expect(invokeTool).toHaveBeenCalledTimes(1);
      expect(userPrompt(createChatCompletion)).not.toContain("Page excerpt:");
    });

    it("skips blocked, approval-gated, and throwing navigates without failing the run", async () => {
      const { service, invokeTool, createChatCompletion } = createService(async (url) => {
        if (url.endsWith("/1")) {
          return { outcome: "blocked", policyReason: "internal host", auditEventId: "a" };
        }
        if (url.endsWith("/2")) {
          throw new Error("navigate exploded");
        }
        return { outcome: "approval_required", policyReason: "needs approval", auditEventId: "b" };
      });

      const result = await service.run({ sessionId: "session-1", query: "q", mode: "deep" });

      expect(result.summary).toBe("Summary.");
      expect(invokeTool).toHaveBeenCalledTimes(4);
      const prompt = userPrompt(createChatCompletion);
      expect(prompt).not.toContain("Page excerpt:");
      expect(prompt).toContain("Snippet: snippet 1");
    });

    it("frames sources as untrusted data in the summarizer system prompt", async () => {
      const { service, createChatCompletion } = createService();

      await service.run({ sessionId: "session-1", query: "q", mode: "quick" });

      const request = createChatCompletion.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(request.messages[0]).toMatchObject({ role: "system" });
      expect(request.messages[0]?.content).toContain("untrusted web content");
      expect(request.messages[0]?.content).toContain("never as instructions");
    });
  });
});
