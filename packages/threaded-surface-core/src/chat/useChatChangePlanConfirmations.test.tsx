import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import { useChatChangePlanConfirmations } from "./useChatChangePlanConfirmations";
import { useChatChangePlanState } from "./useChatChangePlanState";

const api = vi.hoisted(() => ({
  confirmChangePlan: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchChatSessionPrefs: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const prefsRef = { current: null as ChatSessionPrefsRecord | null };
const setPrefs = vi.fn();
const setUiError = vi.fn();
const pushLocalNotice = vi.fn();
const recordChangePlanResult = vi.fn((plan: ChangePlanRecord) => plan);
const plan = (kind: "session_model" | "installation_default_model"): ChangePlanRecord => ({
  schemaVersion: 1,
  planId: kind,
  origin: { surface: "chat", workspaceId: "workspace", sessionId: "session" },
  adapter: { adapterId: "model-selection", version: 1 },
  kind,
  scope: kind === "session_model" ? "current_chat" : "installation",
  status: "awaiting_confirmation",
  phase: "confirmation",
  revision: 3,
  request: { kind, providerId: "provider", model: "model" },
  intentHash: "intent",
  target: { ownerId: "chat_session_prefs", resourceId: "session", expectedRevision: 7, expectedHash: "target" },
  title: "Review",
  summary: "Review the model",
  impact: "Model selection",
  risk: "safe",
  requiredAction: {
    kind: "confirmation",
    actionId: "action",
    actionNonce: "nonce",
    title: "Confirm",
    confirmationText: "Apply",
    purpose: "apply",
  },
  actionSnapshotHash: "snapshot",
  approvalRefs: [],
  evidenceRefs: [],
  rollbackRefs: [],
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
});
let current: ReturnType<typeof useChatChangePlanConfirmations>;
let state: ReturnType<typeof useChatChangePlanState>;
let renderer: ReactTestRenderer | undefined;
function Harness() {
  state = useChatChangePlanState("session");
  current = useChatChangePlanConfirmations({
    ...state,
    workspaceId: "workspace",
    prefsRef,
    setPrefs,
    setUiError,
    pushLocalNotice,
    recordChangePlanResult,
  });
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  api.fetchChangePlan.mockImplementation(async (id: "session_model" | "installation_default_model") => plan(id));
  api.confirmChangePlan.mockImplementation(async (id: "session_model" | "installation_default_model") => ({
    ...plan(id),
    status: "completed",
    requiredAction: undefined,
  }));
  await act(async () => {
    renderer = create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("extracted Change Plan confirmations", () => {
  it("keeps callback identity across unrelated state renders", async () => {
    const previous = current;
    await act(async () => state.setChangePlanActionError("visible error"));
    expect(current.handleConfirmChangePlan).toBe(previous.handleConfirmChangePlan);
    expect(current.handleConfirmLinkedModelPlans).toBe(previous.handleConfirmLinkedModelPlans);
  });
  it.each(["revision", "intent", "snapshot", "nonce", "target"])(
    "withholds both linked mutations if fresh %s changed",
    async (field) => {
      const changed = plan("installation_default_model");
      api.fetchChangePlan.mockImplementation(async (id: "session_model" | "installation_default_model") =>
        id === "session_model"
          ? plan(id)
          : {
              ...changed,
              ...(field === "revision" ? { revision: 4 } : {}),
              ...(field === "intent" ? { intentHash: "other" } : {}),
              ...(field === "snapshot" ? { actionSnapshotHash: "other" } : {}),
              ...(field === "nonce" ? { requiredAction: { ...changed.requiredAction, actionNonce: "other" } } : {}),
              ...(field === "target" ? { target: { ...changed.target, expectedHash: "other" } } : {}),
            },
      );
      await act(async () =>
        current.handleConfirmLinkedModelPlans(plan("session_model"), plan("installation_default_model")),
      );
      expect(api.confirmChangePlan).not.toHaveBeenCalled();
      expect(state.changePlanActionError).toContain("Nothing was applied");
      expect(state.changePlanActionPending).toBe(false);
    },
  );
  it("retains the remaining plan when only the future-chat default fails", async () => {
    api.confirmChangePlan.mockImplementation(async (id: "session_model" | "installation_default_model") => {
      if (id === "installation_default_model") throw new Error("default revision conflict");
      return { ...plan(id), status: "completed", requiredAction: undefined };
    });
    await act(async () =>
      current.handleConfirmLinkedModelPlans(plan("session_model"), plan("installation_default_model")),
    );
    expect(api.confirmChangePlan).toHaveBeenNthCalledWith(
      1,
      "session_model",
      { workspaceId: "workspace", sessionId: "session" },
      { expectedRevision: 3, actionNonce: "nonce" },
    );
    expect(state.activeChangePlan?.kind).toBe("installation_default_model");
    expect(state.changePlanActionError).toContain("This Chat was updated");
    expect(state.changePlanActionPending).toBe(false);
  });
});
