import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ApprovalResolveInput } from "@goatcitadel/contracts";
import { recordApprovalResolution, updateAuthSettings } from "./settings-auth-service.js";

function createSettingsDeps() {
  return {
    config: {
      rootDir: "F:/tmp/gc-settings-loop32",
      assistant: {
        auth: {
          mode: "basic",
          allowLoopbackBypass: true,
          token: { value: "old-token" },
          basic: { username: "old-user", password: "old-pass" },
        },
      },
    },
    llmService: {
      getRuntimeConfig: vi.fn(() => ({ providers: [] })),
    },
  } as never;
}

function createAuthDeps() {
  const auditRecords: Array<{ stream: string; payload: Record<string, unknown> }> = [];
  const realtimeEvents: Array<{
    eventType: string;
    source: string;
    payload: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  return {
    deps: {
      storage: {
        audit: {
          append: vi.fn(async (stream: string, payload: Record<string, unknown>) => {
            auditRecords.push({ stream, payload });
          }),
        },
      },
      publishRealtime: vi.fn((eventType, source, payload, options) => {
        realtimeEvents.push({ eventType, source, payload, options });
      }),
      buildApprovalRealtimeLinks: vi.fn((approval: ApprovalRequest) => ({ approvalId: approval.approvalId })),
      recordImprovementApprovalResolutionSignal: vi.fn(),
      handleActivationApprovalResolution: vi.fn(),
    } as never,
    auditRecords,
    realtimeEvents,
  };
}

describe("settings-auth-service loop32 auth state", () => {
  it("updates auth mode and clears whitespace credentials without preserving stale secrets", () => {
    const deps = createSettingsDeps();

    const result = updateAuthSettings(deps, {
      mode: "token",
      allowLoopbackBypass: false,
      token: "   next-token   ",
      basicUsername: "   ",
      basicPassword: "   ",
    });

    expect(result).toMatchObject({
      mode: "token",
      allowLoopbackBypass: false,
      tokenConfigured: true,
      basicConfigured: false,
    });
    expect(deps.config.assistant.auth).toMatchObject({
      mode: "token",
      allowLoopbackBypass: false,
      token: { value: "next-token" },
      basic: {
        username: undefined,
        password: undefined,
      },
    });
  });

  it("records approval resolution to audit, realtime, improvement, and activation hooks", async () => {
    const harness = createAuthDeps();
    const approval: ApprovalRequest = {
      approvalId: "approval-loop32",
      kind: "tool.invoke",
      riskLevel: "caution",
      status: "approved",
      payload: {},
      preview: {},
      linkage: {},
      createdAt: "2026-05-15T00:00:00.000Z",
      explanationStatus: "not_requested",
    };
    const input: ApprovalResolveInput = {
      decision: "approve",
      resolvedBy: "operator:loop32",
    };

    await recordApprovalResolution(harness.deps, approval, input);

    expect(harness.auditRecords).toEqual([
      {
        stream: "approvals",
        payload: {
          event: "approval.resolve",
          approvalId: "approval-loop32",
          status: "approved",
          resolvedBy: "operator:loop32",
          decision: "approve",
        },
      },
    ]);
    expect(harness.realtimeEvents).toEqual([
      {
        eventType: "approval_resolved",
        source: "approvals",
        payload: {
          approvalId: "approval-loop32",
          status: "approved",
          decision: "approve",
          resolvedBy: "operator:loop32",
        },
        options: {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: { approvalId: "approval-loop32" },
          correlationId: "approval-loop32",
        },
      },
    ]);
    expect(harness.deps.recordImprovementApprovalResolutionSignal).toHaveBeenCalledWith(approval);
    expect(harness.deps.handleActivationApprovalResolution).toHaveBeenCalledWith(approval);
  });
});
