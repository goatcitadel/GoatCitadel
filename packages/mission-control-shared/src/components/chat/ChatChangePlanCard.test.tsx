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
  it("keeps actionable plans compact, with one primary action and no dismissal", () => {
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
    expect(text).toContain("Switch only this conversation.");
    expect(detailsRegion(renderer).props.hidden).toBe(true);
    expect(buttonLabels(renderer).slice(0, 3)).toEqual(["Review and confirm", "More", "Details"]);
    expect(buttonLabels(renderer)).not.toContain("Dismiss");

    act(() => {
      findButton(renderer, "Review and confirm").props.onClick();
    });
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }));

    act(() => {
      findButton(renderer, "More").props.onClick();
    });
    expect(buttonLabels(renderer)).toContain("Cancel plan");
    expect(buttonLabels(renderer)).toContain("Make this my default");
    expect(secondaryActionsRegion(renderer).props.hidden).toBe(false);

    act(() => {
      findButton(renderer, "Cancel plan").props.onClick();
      findButton(renderer, "Make this my default").props.onClick();
    });
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }));
    expect(onMakeDefault).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }));
  });

  it("resets Details and More when a new plan revision replaces the receipt", () => {
    const onCancel = vi.fn();
    const onMakeDefault = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<ChatChangePlanCard plan={plan()} onCancel={onCancel} onMakeDefault={onMakeDefault} />);
    });

    act(() => {
      findButton(renderer, "More").props.onClick();
      findButton(renderer, "Details").props.onClick();
    });
    expect(detailsRegion(renderer).props.hidden).toBe(false);
    expect(secondaryActionsRegion(renderer).props.hidden).toBe(false);

    act(() => {
      renderer.update(
        <ChatChangePlanCard plan={plan({ revision: 2 })} onCancel={onCancel} onMakeDefault={onMakeDefault} />,
      );
    });

    expect(detailsRegion(renderer).props.hidden).toBe(true);
    expect(secondaryActionsRegion(renderer).props.hidden).toBe(true);
    expect(findButton(renderer, "More").props["aria-expanded"]).toBe(false);
    expect(findButton(renderer, "Details").props["aria-expanded"]).toBe(false);
  });

  it("renders terminal plans as a closed, dismissible receipt while keeping evidence inspectable", () => {
    const onDismiss = vi.fn();
    const onOpenDetails = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ChatChangePlanCard
          plan={plan({ status: "applied", result: { summary: "Applied.", evidenceRefs: ["chat_session:session-1"] } })}
          onDismiss={onDismiss}
          onOpenDetails={onOpenDetails}
        />,
      );
    });
    const initialText = JSON.stringify(renderer.toJSON());

    expect(initialText).toContain("Model changed to gpt-5");
    expect(buttonLabels(renderer)).toEqual(["Details", "Dismiss"]);
    expect(findButton(renderer, "Details").props["aria-expanded"]).toBe(false);
    expect(detailsRegion(renderer).props.hidden).toBe(true);
    expect(findButton(renderer, "Details").props["aria-controls"]).toBe(detailsRegion(renderer).props.id);

    act(() => {
      findButton(renderer, "Details").props.onClick();
    });
    expect(onOpenDetails).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }));
    expect(initialText).toContain("chat_session:session-1");
    expect(findButton(renderer, "Details").props["aria-expanded"]).toBe(true);
    expect(detailsRegion(renderer).props.hidden).toBe(false);

    act(() => {
      findButton(renderer, "Dismiss").props.onClick();
    });
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }));
    expect(renderer.toJSON()).toBeNull();
  });

  it("honors a host-owned terminal dismissal without mutating the plan", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ChatChangePlanCard
          plan={plan({ status: "completed", result: { summary: "Applied.", evidenceRefs: [] } })}
          dismissed
        />,
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });
});

function buttonLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType("button").map((button) => button.children.join(""));
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === label);
  if (!button) {
    throw new Error(`Expected button ${label}`);
  }
  return button;
}

function detailsRegion(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ className: "chat-change-plan-details" });
}

function secondaryActionsRegion(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ className: "chat-change-plan-secondary-actions" });
}
