import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatTurnTraceRecord,
  McpServerTemplateRecord,
  McpTemplateDiscoveryResult,
  SkillListItem,
  SkillSourceLookupResponse,
  SkillSourceListResponse,
  ToolCatalogEntry,
} from "@goatcitadel/contracts";
import { scoutCapabilityUpgradeSuggestions } from "./chat-capability-scout.js";

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
});
