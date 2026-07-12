import { describe, expect, it, vi } from "vitest";
import type { PendingApprovalAction, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

function createStorageStub(): Storage {
  return {
    approvals: {
      create: vi.fn((input) => ({
        approvalId: "approval-tail",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: "2026-05-01T00:00:00.000Z",
        expiresAt: input.expiresAt,
        explanationStatus: "not_requested",
      })),
    },
    approvalEvents: { append: vi.fn() },
    audit: { append: vi.fn(async () => undefined) },
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    toolGrants: {
      list: vi.fn(() => []),
      listActive: vi.fn(() => []),
      consumeOne: vi.fn(),
    },
    pendingApprovalActions: {
      upsertPending: vi.fn(),
      find: vi.fn(() => undefined),
      markResolved: vi.fn(),
    },
    db: {
      prepare: vi.fn(() => ({
        run: vi.fn(),
      })),
    },
  } as unknown as Storage;
}

function createConfig(overrides: Partial<ToolPolicyConfig> = {}): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./skills"],
      networkAllowlist: ["example.com", "127.0.0.1:3002"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
    ...overrides,
  };
}

describe("ToolPolicyEngine package tail coverage", () => {
  it("evaluates sparse structural targets without manufacturing blocked paths or hosts", () => {
    const engine = new ToolPolicyEngine(
      createConfig({
        tools: { profile: "danger", approvalMode: "bypass", allow: [], deny: [] },
      }),
      createStorageStub(),
    );

    expect(
      engine.evaluateAccess({
        toolName: "fs.move",
        args: { to: "./workspace/moved.txt" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);
    expect(
      engine.evaluateAccess({
        toolName: "docs.ingest",
        args: { sourceType: "url", backend: "firecrawl" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);
    expect(
      engine.evaluateAccess({
        toolName: "browser.navigate",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);
  });

  it("uses firecrawl defaults during bypass-mode dry-run network auditing", async () => {
    const priorFirecrawlBaseUrl = process.env.FIRECRAWL_BASE_URL;
    delete process.env.FIRECRAWL_BASE_URL;
    try {
      const storage = createStorageStub();
      const engine = new ToolPolicyEngine(
        createConfig({
          tools: { profile: "danger", approvalMode: "bypass", allow: [], deny: [] },
        }),
        storage,
      );

      const result = await engine.invoke({
        toolName: "docs.ingest",
        args: { sourceType: "url", source: "https://example.com/docs", backend: "firecrawl" },
        agentId: "agent",
        sessionId: "session",
        dryRun: true,
      });

      expect(result.outcome).toBe("executed");
      expect(storage.audit.append).toHaveBeenCalledWith(
        "tool_invocations",
        expect.objectContaining({
          outcome: "executed",
          toolName: "docs.ingest",
        }),
      );
    } finally {
      if (priorFirecrawlBaseUrl === undefined) {
        delete process.env.FIRECRAWL_BASE_URL;
      } else {
        process.env.FIRECRAWL_BASE_URL = priorFirecrawlBaseUrl;
      }
    }
  });

  it("rejects malformed approved action payloads before policy execution", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.pendingApprovalActions.find).mockReturnValue({
      approvalId: "approval-malformed",
      actionType: "tool.invoke",
      request: {},
      createdAt: "2026-05-01T00:00:00.000Z",
      resolutionStatus: "pending",
    } as PendingApprovalAction);
    const engine = new ToolPolicyEngine(createConfig(), storage);

    await expect(engine.executeApprovedAction("approval-malformed")).rejects.toThrow(
      "Invalid pending action request payload",
    );
  });
});
