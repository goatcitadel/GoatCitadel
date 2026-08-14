import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { ChatChangePlanCard } from "./ChatChangePlanCard";

function plan(overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    origin: { surface: "chat", workspaceId: "workspace-1", sessionId: "session-1" },
    adapter: { adapterId: "model-selection", version: 1 },
    kind: "session_model",
    scope: "current_chat",
    status: "awaiting_confirmation",
    phase: "confirmation",
    revision: 1,
    request: { kind: "session_model", providerId: "openai", model: "gpt-5", thinkingLevel: "extended" },
    intentHash: "intent-hash",
    target: { ownerId: "chat_session_prefs", resourceId: "session-1", expectedRevision: 1 },
    title: "Use GPT-5 in this chat",
    summary: "Switch only this conversation.",
    impact: "Only this Chat changes.",
    risk: "safe",
    requiredAction: {
      kind: "confirmation",
      actionId: "action-1",
      actionNonce: "nonce-1234567890123456",
      title: "Confirm model",
      confirmationText: "Use GPT-5 in this Chat.",
    },
    actionSnapshotHash: "snapshot-hash",
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatChangePlanCard", () => {
  it("renders only the sanitized plan envelope and exposes explicit review/cancel actions", () => {
    const onReview = vi.fn();
    const onCancel = vi.fn();
    const onMakeDefault = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ChatChangePlanCard plan={plan()} onReview={onReview} onCancel={onCancel} onMakeDefault={onMakeDefault} />,
      );
    });
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Use GPT-5 in this chat");
    expect(text).toContain("openai");
    expect(text).toContain("extended");
    const buttons = renderer.root.findAllByType("button");
    buttons[0]?.props.onClick();
    buttons[1]?.props.onClick();
    buttons[2]?.props.onClick();
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }));
    expect(onMakeDefault).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }));
  });

  it("retains a concise terminal receipt without confirmation controls", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ChatChangePlanCard
          plan={plan({ status: "applied", result: { summary: "Applied.", evidenceRefs: ["chat_session:session-1"] } })}
        />,
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("chat_session:session-1");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });
});
