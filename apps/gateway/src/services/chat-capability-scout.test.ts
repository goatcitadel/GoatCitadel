import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatToolRunRecord,
  ChatTurnTraceRecord,
  McpServerTemplateRecord,
  McpTemplateDiscoveryResult,
  SkillListItem,
  SkillSourceLookupResponse,
  SkillSourceListResponse,
  ToolCatalogEntry,
} from "@goatcitadel/contracts";
import { scoutCapabilityUpgradeSuggestions } from "./chat-capability-scout.js";
import { SATURDAY_SESSION_TURNS } from "./__fixtures__/scout-saturday-session.js";

function createToolCatalog(): ToolCatalogEntry[] {
  return [
    {
      toolName: "browser.search",
      category: "research",
      riskLevel: "safe",
      requiresApproval: false,
      description: "Search the web for current information.",
      argSchema: {},
      examples: [{ title: "Find latest docs", args: { query: "docs" } }],
      pack: "core",
    },
  ];
}

function createSkills(): SkillListItem[] {
  return [
    {
      skillId: "extra:Gmail Helper",
      name: "Gmail Helper",
      source: "extra",
      dir: "F:/skills/gmail-helper",
      declaredTools: ["comms.gmail.send"],
      requires: [],
      keywords: ["gmail", "email", "mail", "send"],
      instructionBody: "Use Gmail tools safely.",
      mtime: new Date().toISOString(),
      state: "disabled",
      note: "Imported skill starts disabled by default.",
      stateUpdatedAt: new Date().toISOString(),
    },
  ];
}

function createTrace(status: ChatTurnTraceRecord["status"] = "completed"): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    branchKind: "append",
    status,
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: new Date().toISOString(),
    toolRuns: [],
    citations: [],
    routing: {},
  };
}

describe("scoutCapabilityUpgradeSuggestions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("only diagnoses blocked web tools with the admitted turn's permission context", async () => {
    const evaluateToolAccess = vi.fn(async () => ({
      toolName: "browser.search",
      allowed: false,
      reasonCodes: ["policy_deny"],
      requiresApproval: false,
      riskLevel: "safe" as const,
    }));
    const deps: Parameters<typeof scoutCapabilityUpgradeSuggestions>[0]["deps"] = {
      listToolCatalog: createToolCatalog,
      evaluateToolAccess,
      listSkills: async () => [],
      resolveSkillActivation: async () => ({ suppressed: [] }),
      listSkillSources: async () => ({ generatedAt: new Date().toISOString(), providers: [], items: [] }),
      lookupSkillSources: async (query) => ({ query, generatedAt: new Date().toISOString(), providers: [], items: [] }),
      listMcpTemplates: async () => [],
      listMcpTemplateDiscovery: async () => [],
    };
    const input = {
      content: "Search the web for the latest docs",
      assistantText: "I can't search the web because web access is not available.",
      sessionId: "session-1",
      trace: createTrace(),
      deps,
    };

    const withoutContext = await scoutCapabilityUpgradeSuggestions(input);
    expect(evaluateToolAccess).not.toHaveBeenCalled();
    expect(withoutContext.some((item) => item.recommendedAction === "review_tool_access")).toBe(false);

    const policyContext = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      permissionProfileId: "safe",
      surface: "chat" as const,
    };
    const withContext = await scoutCapabilityUpgradeSuggestions({ ...input, policyContext });
    expect(evaluateToolAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        policyContext,
        permissionProfileId: "safe",
      }),
    );
    expect(withContext).toContainEqual(
      expect.objectContaining({
        recommendedAction: "review_tool_access",
        candidateId: "browser.search",
      }),
    );

    evaluateToolAccess.mockResolvedValueOnce({
      toolName: "browser.search",
      allowed: false,
      reasonCodes: ["structural_safety_block"],
      requiresApproval: false,
      riskLevel: "safe",
    });
    const invalidProbe = await scoutCapabilityUpgradeSuggestions({ ...input, policyContext });
    expect(invalidProbe.some((item) => item.recommendedAction === "review_tool_access")).toBe(false);
  });

  it("treats a tool in a switched-off group as an access denial worth reviewing", async () => {
    const evaluateToolAccess = vi.fn(async () => ({
      toolName: "browser.search",
      allowed: false,
      reasonCodes: ["tool_group_off"],
      requiresApproval: false,
      riskLevel: "safe" as const,
    }));
    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Search the web for the latest docs",
      assistantText: "I can't search the web because web access is not available.",
      sessionId: "session-1",
      trace: createTrace(),
      policyContext: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        permissionProfileId: "safe",
        surface: "chat",
      },
      deps: {
        listToolCatalog: createToolCatalog,
        evaluateToolAccess,
        listSkills: async () => [],
        resolveSkillActivation: async () => ({ suppressed: [] }),
        listSkillSources: async () => ({ generatedAt: new Date().toISOString(), providers: [], items: [] }),
        lookupSkillSources: async (query) => ({
          query,
          generatedAt: new Date().toISOString(),
          providers: [],
          items: [],
        }),
        listMcpTemplates: async () => [],
        listMcpTemplateDiscovery: async () => [],
      },
    });

    expect(suggestions).toContainEqual(
      expect.objectContaining({ recommendedAction: "review_tool_access", candidateId: "browser.search" }),
    );
  });

  it("says in plain words that a tool's group is switched off, and leaves other reasons as they were", async () => {
    const reviewReason = async (reasonCodes: string[]) => {
      const suggestions = await scoutCapabilityUpgradeSuggestions({
        content: "Search the web for the latest docs",
        assistantText: "I can't search the web because web access is not available.",
        sessionId: "session-1",
        trace: createTrace(),
        policyContext: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          permissionProfileId: "safe",
          surface: "chat",
        },
        deps: {
          listToolCatalog: createToolCatalog,
          evaluateToolAccess: vi.fn(async () => ({
            toolName: "browser.search",
            allowed: false,
            reasonCodes,
            requiresApproval: false,
            riskLevel: "safe" as const,
          })),
          listSkills: async () => [],
          resolveSkillActivation: async () => ({ suppressed: [] }),
          listSkillSources: async () => ({ generatedAt: new Date().toISOString(), providers: [], items: [] }),
          lookupSkillSources: async (query) => ({
            query,
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
          listMcpTemplates: async () => [],
          listMcpTemplateDiscovery: async () => [],
        },
      });
      return suggestions.find((item) => item.recommendedAction === "review_tool_access")?.reason;
    };

    expect(await reviewReason(["tool_group_off"])).toBe("This tool's group is switched off in Capabilities › Tools.");
    // A plugin's hold is lifted by uninstalling the plugin, never by the Tools switch (F9).
    expect(await reviewReason(["tool_group_off", "plugin_tool_group_hold"])).toBe(
      "A plugin keeps this tool's group off. Uninstalling that plugin turns the group back on.",
    );
    expect(await reviewReason(["policy_deny", "tool_group_off"])).toBe(
      "This tool's group is switched off in Capabilities › Tools.",
    );
    expect(await reviewReason(["policy_deny"])).toBe(
      "Current tool access policy blocked this capability: policy_deny.",
    );
    expect(await reviewReason(["permission_profile_upper_bound", "grant_deny"])).toBe(
      "Current tool access policy blocked this capability: permission_profile_upper_bound, grant_deny.",
    );
  });

  it("does not propose another capability after an operator closes tool use", async () => {
    const trace = createTrace();
    trace.routing = {
      turnControl: { toolClosure: { outcome: "denied", actorId: "operator", closedAt: trace.startedAt } },
    };
    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Create a PDF report",
      assistantText: "The file was not created.",
      sessionId: trace.sessionId,
      trace,
      deps: new Proxy({} as Parameters<typeof scoutCapabilityUpgradeSuggestions>[0]["deps"], {
        get() {
          throw new Error("A closed turn must not scout capabilities");
        },
      }),
    });
    expect(suggestions).toEqual([]);
  });

  it("suggests enabling a matching installed skill before import suggestions", async () => {
    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Send an email to my teammate with Gmail",
      assistantText: "I can't do that right now because the needed capability is not available.",
      sessionId: "session-1",
      trace: createTrace(),
      deps: {
        listToolCatalog: createToolCatalog,
        evaluateToolAccess: vi.fn(() => ({
          toolName: "browser.search",
          allowed: true,
          matchedGrantId: undefined,
          reasonCodes: [],
          requiresApproval: false,
          riskLevel: "safe" as const,
        })),
        listSkills: createSkills,
        resolveSkillActivation: vi.fn(() => ({
          suppressed: [
            {
              skill: "Gmail Helper",
              state: "disabled" as const,
              confidence: 0.92,
              reason: "skill_disabled",
            },
          ],
        })),
        listSkillSources: vi.fn(
          async (): Promise<SkillSourceListResponse> => ({
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        lookupSkillSources: vi.fn(
          async (): Promise<SkillSourceLookupResponse> => ({
            query: "gmail helper",
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        listMcpTemplates: vi.fn((): Array<McpServerTemplateRecord & { installed: boolean }> => []),
        listMcpTemplateDiscovery: vi.fn((): McpTemplateDiscoveryResult[] => []),
      },
    });

    expect(suggestions[0]).toMatchObject({
      kind: "existing_but_disabled",
      recommendedAction: "enable_skill",
      candidateId: "extra:Gmail Helper",
    });
  });

  it("falls back to curated skill import and mcp template suggestions when no installed capability matches", async () => {
    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Connect GitHub issues and repository metadata to the chat",
      assistantText: "I don't have that tool installed yet.",
      sessionId: "session-1",
      trace: createTrace(),
      deps: {
        listToolCatalog: createToolCatalog,
        evaluateToolAccess: vi.fn(() => ({
          toolName: "browser.search",
          allowed: true,
          matchedGrantId: undefined,
          reasonCodes: [],
          requiresApproval: false,
          riskLevel: "safe" as const,
        })),
        listSkills: vi.fn(() => []),
        resolveSkillActivation: vi.fn(() => ({ suppressed: [] })),
        listSkillSources: vi.fn(
          async (): Promise<SkillSourceListResponse> => ({
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [
              {
                sourceProvider: "github",
                sourceUrl: "https://github.com/example/github-issues-skill",
                repositoryUrl: "https://github.com/example/github-issues-skill",
                name: "GitHub Issues Skill",
                description: "Adds GitHub issue search and triage workflows.",
                tags: ["github", "issues", "repo"],
                canonicalKey: "github:github-issues-skill",
                alternateProviders: [],
                qualityScore: 0.8,
                freshnessScore: 0.8,
                trustScore: 0.7,
                combinedScore: 8.2,
              },
            ],
          }),
        ),
        lookupSkillSources: vi.fn(
          async (): Promise<SkillSourceLookupResponse> => ({
            query: "https://www.example.com/skill.md",
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        listMcpTemplates: vi.fn(
          (): Array<McpServerTemplateRecord & { installed: boolean }> => [
            {
              templateId: "github-http",
              label: "GitHub MCP",
              description: "Connect GitHub repos, issues, and PR workflows.",
              transport: "http",
              url: "https://example.invalid/mcp",
              authType: "token",
              category: "development",
              trustTier: "restricted",
              costTier: "free",
              policy: {
                requireFirstToolApproval: false,
                redactionMode: "basic",
                allowedToolPatterns: [],
                blockedToolPatterns: [],
              },
              enabledByDefault: false,
              installed: false,
            },
          ],
        ),
        listMcpTemplateDiscovery: vi.fn((): McpTemplateDiscoveryResult[] => [
          {
            templateId: "github-http",
            label: "GitHub MCP",
            installed: false,
            readiness: "needs_auth",
            dependencyChecks: [],
          },
        ]),
      },
    });

    expect(suggestions.some((item) => item.kind === "skill_import")).toBe(true);
    expect(suggestions.some((item) => item.kind === "mcp_template")).toBe(true);
  });

  it("suggests a governed self-authored capability candidate only after existing capability lanes have no match", async () => {
    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Build a recurring worksheet pack from these lesson notes and save it as reusable workflow",
      assistantText: "I don't have that capability available yet.",
      sessionId: "session-1",
      trace: {
        ...createTrace("failed"),
        toolRuns: [
          {
            toolRunId: "run-1",
            turnId: "turn-1",
            sessionId: "session-1",
            // Reading the lesson notes failed: a gap a local Code Mode script can close.
            toolName: "docs.ingest",
            args: { sourceType: "file", source: "lesson-notes.docx", namespace: "lessons" },
            status: "failed" as const,
            startedAt: new Date().toISOString(),
          },
        ],
      },
      deps: {
        listToolCatalog: vi.fn(() => []),
        evaluateToolAccess: vi.fn(() => ({
          toolName: "browser.search",
          allowed: true,
          matchedGrantId: undefined,
          reasonCodes: [],
          requiresApproval: false,
          riskLevel: "safe" as const,
        })),
        listSkills: vi.fn(() => []),
        resolveSkillActivation: vi.fn(() => ({ suppressed: [] })),
        listSkillSources: vi.fn(
          async (): Promise<SkillSourceListResponse> => ({
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        lookupSkillSources: vi.fn(
          async (): Promise<SkillSourceLookupResponse> => ({
            query: "worksheet pack lesson notes",
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        listMcpTemplates: vi.fn((): Array<McpServerTemplateRecord & { installed: boolean }> => []),
        listMcpTemplateDiscovery: vi.fn((): McpTemplateDiscoveryResult[] => []),
      },
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      kind: "code_mode_build",
      sourceProvider: "code_mode",
      recommendedAction: "build_code_mode_skill_candidate",
      sourceSessionId: "session-1",
      sourceTurnId: "turn-1",
      candidateType: "self_generated_skill",
      requiresUserApproval: true,
    });
    expect(suggestions[0]?.candidateId).toMatch(/^candidate-/);
    expect(suggestions[0]?.summary).toContain("GoatCitadel can stage");
    expect(suggestions[0]?.summary).not.toContain("Code Mode can draft");
    expect(suggestions[0]?.validationExpectation).toContain("governed capability build");
    expect(suggestions[0]?.reason).toContain("A new reusable capability is justified");
  });

  it("treats a text-only PowerPoint response as a missing artifact capability", async () => {
    const listSkillSources = vi.fn(
      async (): Promise<SkillSourceListResponse> => ({
        generatedAt: new Date().toISOString(),
        providers: [],
        items: [
          {
            sourceProvider: "local",
            sourceUrl: "file:///skills/pptx",
            name: "PPTX Deck Builder",
            description: "Creates PowerPoint presentation files from slide outlines.",
            tags: ["powerpoint", "pptx", "slides", "deck"],
            canonicalKey: "local:pptx-deck-builder",
            alternateProviders: [],
            qualityScore: 0.9,
            freshnessScore: 0.8,
            trustScore: 0.8,
            combinedScore: 8.8,
          },
        ],
      }),
    );

    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Research the top 10 things to do near me and put it together in a PowerPoint presentation.",
      assistantText: "## PowerPoint Presentation: Top 10 Things To Do\n\nSlide 1: Overview",
      sessionId: "session-1",
      trace: createTrace(),
      deps: {
        listToolCatalog: createToolCatalog,
        evaluateToolAccess: vi.fn(() => ({
          toolName: "browser.search",
          allowed: true,
          matchedGrantId: undefined,
          reasonCodes: [],
          requiresApproval: false,
          riskLevel: "safe" as const,
        })),
        listSkills: vi.fn(() => []),
        resolveSkillActivation: vi.fn(() => ({ suppressed: [] })),
        listSkillSources,
        lookupSkillSources: vi.fn(
          async (): Promise<SkillSourceLookupResponse> => ({
            query: "powerpoint presentation slides deck pptx",
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        listMcpTemplates: vi.fn((): Array<McpServerTemplateRecord & { installed: boolean }> => []),
        listMcpTemplateDiscovery: vi.fn((): McpTemplateDiscoveryResult[] => []),
      },
    });

    expect(listSkillSources).toHaveBeenCalledWith("powerpoint presentation slides deck pptx", 6);
    expect(suggestions[0]).toMatchObject({
      kind: "skill_import",
      candidateId: "local:pptx-deck-builder",
    });
  });

  it("treats a text-only document response as a missing artifact capability", async () => {
    const listSkillSources = vi.fn(
      async (): Promise<SkillSourceListResponse> => ({
        generatedAt: new Date().toISOString(),
        providers: [],
        items: [
          {
            sourceProvider: "local",
            sourceUrl: "file:///skills/docx",
            name: "Document Builder",
            description: "Creates DOCX and PDF files from structured outlines.",
            tags: ["document", "docx", "pdf", "report"],
            canonicalKey: "local:document-builder",
            alternateProviders: [],
            qualityScore: 0.9,
            freshnessScore: 0.8,
            trustScore: 0.8,
            combinedScore: 8.8,
          },
        ],
      }),
    );

    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Create a real PDF report file from these recommendations.",
      assistantText: "Here is the report outline in text form.",
      sessionId: "session-1",
      trace: createTrace(),
      deps: {
        listToolCatalog: createToolCatalog,
        evaluateToolAccess: vi.fn(() => ({
          toolName: "browser.search",
          allowed: true,
          matchedGrantId: undefined,
          reasonCodes: [],
          requiresApproval: false,
          riskLevel: "safe" as const,
        })),
        listSkills: vi.fn(() => []),
        resolveSkillActivation: vi.fn(() => ({ suppressed: [] })),
        listSkillSources,
        lookupSkillSources: vi.fn(
          async (): Promise<SkillSourceLookupResponse> => ({
            query: "document generation docx pdf markdown html csv json",
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        listMcpTemplates: vi.fn((): Array<McpServerTemplateRecord & { installed: boolean }> => []),
        listMcpTemplateDiscovery: vi.fn((): McpTemplateDiscoveryResult[] => []),
      },
    });

    expect(listSkillSources).toHaveBeenCalledWith("document generation docx pdf markdown html csv json", 6);
    expect(suggestions[0]).toMatchObject({
      kind: "skill_import",
      candidateId: "local:document-builder",
    });
  });

  it("stays quiet for normal conversational replies without a capability gap", async () => {
    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Tell me a short story about a lighthouse.",
      assistantText: "The old lighthouse keeper watched the storm roll in.",
      sessionId: "session-1",
      trace: createTrace(),
      deps: {
        listToolCatalog: createToolCatalog,
        evaluateToolAccess: vi.fn(() => ({
          toolName: "browser.search",
          allowed: true,
          matchedGrantId: undefined,
          reasonCodes: [],
          requiresApproval: false,
          riskLevel: "safe" as const,
        })),
        listSkills: createSkills,
        resolveSkillActivation: vi.fn(() => ({ suppressed: [] })),
        listSkillSources: vi.fn(
          async (): Promise<SkillSourceListResponse> => ({
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        lookupSkillSources: vi.fn(
          async (): Promise<SkillSourceLookupResponse> => ({
            query: "short story lighthouse",
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        listMcpTemplates: vi.fn((): Array<McpServerTemplateRecord & { installed: boolean }> => []),
        listMcpTemplateDiscovery: vi.fn((): McpTemplateDiscoveryResult[] => []),
      },
    });

    expect(suggestions).toEqual([]);
  });

  it("logs discovery failures without breaking the chat turn", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Connect GitHub issues and repository metadata to the chat",
      assistantText: "I don't have that tool installed yet.",
      sessionId: "session-1",
      trace: createTrace(),
      deps: {
        listToolCatalog: createToolCatalog,
        evaluateToolAccess: vi.fn(() => ({
          toolName: "browser.search",
          allowed: true,
          matchedGrantId: undefined,
          reasonCodes: [],
          requiresApproval: false,
          riskLevel: "safe" as const,
        })),
        listSkills: vi.fn(() => []),
        resolveSkillActivation: vi.fn(() => ({ suppressed: [] })),
        listSkillSources: vi.fn(async (): Promise<SkillSourceListResponse> => {
          throw new Error("skill-source-unavailable");
        }),
        lookupSkillSources: vi.fn(async (): Promise<SkillSourceLookupResponse> => {
          throw new Error("skill-source-unavailable");
        }),
        listMcpTemplates: vi.fn((): Array<McpServerTemplateRecord & { installed: boolean }> => []),
        listMcpTemplateDiscovery: vi.fn((): McpTemplateDiscoveryResult[] => {
          throw new Error("mcp-discovery-unavailable");
        }),
      },
    });

    expect(suggestions).toEqual([]);
    const writes = stderrWrite.mock.calls.map(([chunk]) => String(chunk));
    expect(writes.filter((line) => line.includes('"component":"core:chat-capability-scout"'))).toHaveLength(2);
    expect(writes.some((line) => line.includes('"msg":"skill source discovery failed"'))).toBe(true);
    expect(writes.some((line) => line.includes('"msg":"mcp template discovery failed"'))).toBe(true);
  });

  it("prefers install-and-enable for direct hosted skill bundle URLs", async () => {
    const suggestions = await scoutCapabilityUpgradeSuggestions({
      content: "Read https://www.moltbook.com/skill.md and follow the instructions to join Moltbook",
      assistantText: "I can't do that yet because the capability is not installed.",
      sessionId: "session-1",
      trace: createTrace(),
      deps: {
        listToolCatalog: createToolCatalog,
        evaluateToolAccess: vi.fn(() => ({
          toolName: "browser.search",
          allowed: true,
          matchedGrantId: undefined,
          reasonCodes: [],
          requiresApproval: false,
          riskLevel: "safe" as const,
        })),
        listSkills: vi.fn(() => []),
        resolveSkillActivation: vi.fn(() => ({ suppressed: [] })),
        listSkillSources: vi.fn(
          async (): Promise<SkillSourceListResponse> => ({
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [],
          }),
        ),
        lookupSkillSources: vi.fn(
          async (): Promise<SkillSourceLookupResponse> => ({
            query: "https://www.moltbook.com/skill.md",
            generatedAt: new Date().toISOString(),
            providers: [],
            items: [
              {
                sourceProvider: "external",
                sourceUrl: "https://www.moltbook.com/skill.md",
                upstreamUrl: "https://www.moltbook.com/skill.md",
                name: "Moltbook",
                description: "Hosted skill bundle for joining Moltbook.",
                tags: ["moltbook", "skill", "hosted"],
                canonicalKey: "www.moltbook.com/skill.md",
                alternateProviders: [],
                qualityScore: 0.8,
                freshnessScore: 0.8,
                trustScore: 0.7,
                combinedScore: 8.1,
                installability: "direct",
              },
            ],
          }),
        ),
        listMcpTemplates: vi.fn((): Array<McpServerTemplateRecord & { installed: boolean }> => []),
        listMcpTemplateDiscovery: vi.fn((): McpTemplateDiscoveryResult[] => []),
      },
    });

    expect(suggestions[0]).toMatchObject({
      kind: "skill_import",
      title: "Install and enable skill: Moltbook",
      recommendedAction: "install_skill_enable",
      sourceRef: "https://www.moltbook.com/skill.md",
    });
  });

  describe("Code Mode build evidence", () => {
    const emptyDeps = (): Parameters<typeof scoutCapabilityUpgradeSuggestions>[0]["deps"] => ({
      listToolCatalog: () => [],
      evaluateToolAccess: vi.fn(),
      listSkills: async () => [],
      resolveSkillActivation: async () => ({ suppressed: [] }),
      listSkillSources: async () => ({ generatedAt: new Date().toISOString(), providers: [], items: [] }),
      lookupSkillSources: async (query) => ({ query, generatedAt: new Date().toISOString(), providers: [], items: [] }),
      listMcpTemplates: async () => [],
      listMcpTemplateDiscovery: async () => [],
    });
    const withRuns = (runs: Array<Partial<ChatToolRunRecord> & Pick<ChatToolRunRecord, "toolName" | "status">>) =>
      runs.map((run, index) => ({
        toolRunId: `run-${index}`,
        turnId: "turn-1",
        sessionId: "session-1",
        startedAt: new Date().toISOString(),
        ...run,
      }));

    it("matches the reviewed Saturday session", async () => {
      const titles: string[][] = [];
      for (const turn of SATURDAY_SESSION_TURNS) {
        const suggestions = await scoutCapabilityUpgradeSuggestions({
          content: turn.content,
          assistantText: turn.assistantText,
          sessionId: "session-1",
          trace: { ...createTrace(), toolRuns: withRuns([...turn.toolRuns]) },
          unreadableAttachments: turn.unreadableAttachments,
          deps: emptyDeps(),
        });
        titles.push(suggestions.filter((item) => item.kind === "code_mode_build").map((item) => item.title));
      }
      expect(titles).toEqual([
        [], // turn 1: no false positive
        [], // turn 2: no false positive
        ["Build a tool to read .pdf files"], // turn 3
        ["Build a tool to read .pdf files"], // turn 4
        [], // turn 5: no evidence in this turn
      ]);
    });

    it("counts only failures of tools whose job a local Code Mode script can do", async () => {
      const turn = SATURDAY_SESSION_TURNS[0]!;
      const scout = (runs: Parameters<typeof withRuns>[0]) =>
        scoutCapabilityUpgradeSuggestions({
          content: turn.content,
          assistantText: turn.assistantText,
          sessionId: "session-1",
          trace: { ...createTrace(), toolRuns: withRuns([...turn.toolRuns, ...runs]) },
          deps: emptyDeps(),
        });
      const titles = async (runs: Parameters<typeof withRuns>[0]) =>
        (await scout(runs)).filter((item) => item.kind === "code_mode_build").map((item) => item.title);

      // Code Mode has no network: a failed web search or page fetch in a research turn is not a gap it can close.
      expect(await titles([{ toolName: "browser.search", status: "failed" }])).toEqual([]);
      expect(await titles([{ toolName: "browser.extract", status: "failed" }])).toEqual([]);
      expect(await titles([{ toolName: "http.get", status: "failed" }])).toEqual([]);
      expect(await titles([{ toolName: "slack.send", status: "failed" }])).toEqual([]);
      // A failed file read is.
      expect(await titles([{ toolName: "fs.read", status: "failed" }])).toEqual([
        "Build a tool for what fs read couldn't do",
      ]);
      // docs.ingest reads a local file only with sourceType "file" (it has no default), so a failed URL ingest is not.
      const ingest = (args?: Record<string, unknown>) => [{ toolName: "docs.ingest", status: "failed" as const, args }];
      expect(await titles(ingest({ sourceType: "url", source: "https://example.com/notes", namespace: "n" }))).toEqual(
        [],
      );
      expect(await titles(ingest())).toEqual([]);
      expect(await titles(ingest({ sourceType: "file", source: "notes.docx", namespace: "n" }))).toEqual([
        "Build a tool for what docs ingest couldn't do",
      ]);
    });

    it("evidence alone never runs the skill, source or MCP lanes", async () => {
      const turn = SATURDAY_SESSION_TURNS[2]!;
      const boom = vi.fn(async () => {
        throw new Error("lane must not run");
      });
      const deps = {
        ...emptyDeps(),
        listSkills: boom,
        resolveSkillActivation: boom,
        listSkillSources: boom,
        lookupSkillSources: boom,
        listMcpTemplates: boom,
        listMcpTemplateDiscovery: boom,
      } as unknown as ReturnType<typeof emptyDeps>;
      const suggestions = await scoutCapabilityUpgradeSuggestions({
        content: "hello there",
        assistantText: "Here you go.",
        sessionId: "session-1",
        trace: { ...createTrace(), toolRuns: withRuns([...turn.toolRuns]) },
        unreadableAttachments: turn.unreadableAttachments,
        deps,
      });
      expect(boom).not.toHaveBeenCalled();
      expect(suggestions.map((item) => item.kind)).toEqual(["code_mode_build"]);
    });

    it("no Code Mode suggestion when the turn already ran code_mode.request", async () => {
      const turn = SATURDAY_SESSION_TURNS[2]!;
      const suggestions = await scoutCapabilityUpgradeSuggestions({
        content: turn.content,
        assistantText: turn.assistantText,
        sessionId: "session-1",
        trace: {
          ...createTrace(),
          toolRuns: withRuns([...turn.toolRuns, { toolName: "code_mode.request", status: "executed" }]),
        },
        deps: emptyDeps(),
      });
      expect(suggestions.some((item) => item.kind === "code_mode_build")).toBe(false);
    });
  });
});
