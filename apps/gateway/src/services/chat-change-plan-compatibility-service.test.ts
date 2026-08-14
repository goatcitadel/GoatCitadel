import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { ChatChangePlanCompatibilityService } from "./chat-change-plan-compatibility-service.js";

const actor = {
  workspaceId: "default",
  actorId: "operator-1",
  surface: "chat" as const,
  sessionId: "session-1",
};

function plan(overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    origin: actor,
    adapter: { adapterId: "model-selection", version: 1 },
    kind: "session_model",
    scope: "current_chat",
    status: "awaiting_confirmation",
    phase: "confirmation",
    revision: 1,
    request: { kind: "session_model", providerId: "openai", model: "gpt-5" },
    intentHash: "a".repeat(64),
    target: { ownerId: "chat_session_prefs", resourceId: "session-1", expectedRevision: 2 },
    title: "Use GPT-5 in this chat",
    summary: "Switch only this Chat.",
    impact: "Future Chats remain unchanged.",
    risk: "safe",
    requiredAction: {
      kind: "confirmation",
      actionId: "action-1",
      actionNonce: "nonce-1234567890",
      title: "Confirm",
      confirmationText: "Use GPT-5.",
    },
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatChangePlanCompatibilityService", () => {
  it("re-enters the singleton control plane for create and preserves the Chat projection", async () => {
    const create = vi.fn(async () => plan());
    const service = new ChatChangePlanCompatibilityService({
      controlPlane: { create, list: vi.fn(), confirmLegacy: vi.fn(), cancel: vi.fn() } as any,
      resolveActor: vi.fn(async () => actor),
    });
    const created = await service.create("session-1", {
      requesterActorId: "operator-1",
      request: { kind: "session_model", providerId: "openai", model: "gpt-5" },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ actor, request: expect.objectContaining({ kind: "session_model" }) }),
    );
    expect(created).toMatchObject({ sessionId: "session-1", status: "awaiting_confirmation" });
    expect(created.expiresAt).toBe("2026-08-13T00:15:00.000Z");
  });

  it("maps canonical completion to the one-window applied status without changing owner state", async () => {
    const confirmLegacy = vi.fn(async () => plan({ status: "completed", phase: "terminal", revision: 4 }));
    const service = new ChatChangePlanCompatibilityService({
      controlPlane: { create: vi.fn(), list: vi.fn(), confirmLegacy, cancel: vi.fn() } as any,
      resolveActor: vi.fn(async () => actor),
    });
    const confirmed = await service.confirm("session-1", "plan-1", 3);
    expect(confirmLegacy).toHaveBeenCalledWith(actor, "plan-1", 3);
    expect(confirmed.status).toBe("applied");
  });

  it("fails closed if a projected plan belongs to another Chat", async () => {
    const service = new ChatChangePlanCompatibilityService({
      controlPlane: {
        create: vi.fn(),
        list: vi.fn(async () => [plan({ origin: { ...actor, sessionId: "session-2" } })]),
        confirmLegacy: vi.fn(),
        cancel: vi.fn(),
      } as any,
      resolveActor: vi.fn(async () => actor),
    });
    await expect(service.list("session-1")).rejects.toMatchObject({ httpStatus: 404 });
  });
});
