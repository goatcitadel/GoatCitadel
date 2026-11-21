import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, ChatSessionPrefsRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import { useChatModelChangePlans } from "./useChatModelChangePlans";
import { useChatChangePlanState } from "./useChatChangePlanState";

const api = vi.hoisted(() => ({
  createChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  cancelChangePlan: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchChatSessionPrefs: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prefsRef = { current: null as ChatSessionPrefsRecord | null };
const setPrefs = vi.fn();
const setUiError = vi.fn();
const pushLocalNotice = vi.fn();
const session = { sessionId: "session" } as ChatSessionRecord;
const otherSession = { sessionId: "other" } as ChatSessionRecord;
let shown: ChatSessionRecord = session;
const prefs = { revision: 7, thinkingLevel: "standard" } as unknown as ChatSessionPrefsRecord;

const plan = (kind: "session_model" | "installation_default_model" = "session_model"): ChangePlanRecord => ({
  schemaVersion: 1,
  planId: kind,
  origin: { surface: "chat", workspaceId: "workspace", sessionId: "session" },
  adapter: { adapterId: "model-selection", version: 1 },
  kind,
  scope: "current_chat",
  status: "awaiting_confirmation",
  phase: "confirmation",
  revision: 3,
  request: { kind, providerId: "provider", model: "model", thinkingLevel: "extended" },
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
const applied = (overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord =>
  ({
    ...plan(),
    status: "completed",
    revision: 4,
    requiredAction: undefined,
    result: { summary: "This Chat now uses Provider / model at extended effort." },
    ...overrides,
  }) as ChangePlanRecord;

let current: ReturnType<typeof useChatModelChangePlans>;
let state: ReturnType<typeof useChatChangePlanState>;
let renderer: ReactTestRenderer | undefined;
function Harness() {
  state = useChatChangePlanState("session");
  current = useChatModelChangePlans({
    workspaceId: "workspace",
    selectedSession: shown,
    prefs,
    selectedProviderId: "provider",
    selectedModel: "model",
    prefsRef,
    setPrefs,
    setUiError,
    pushLocalNotice,
    setChatChangePlanSnapshot: state.setChatChangePlanSnapshot,
    setActiveChangePlan: state.setActiveChangePlan,
    setLinkedDefaultChangePlan: state.setLinkedDefaultChangePlan,
    setChangePlanActionError: state.setChangePlanActionError,
  });
  return null;
}
const switchToOther = () =>
  act(async () => {
    shown = otherSession;
    renderer?.update(<Harness />);
  });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const request = () => act(async () => current.requestThreadModelPatch({ thinkingLevel: "extended" }));
async function requestUntil(started: () => void) {
  let completion: Promise<void> | undefined;
  await act(async () => {
    completion = current.requestThreadModelPatch({ thinkingLevel: "extended" });
    await vi.waitFor(started);
  });
  return { completion };
}
const cardPlans = () => state.chatChangePlans.map((item) => `${item.planId}:${item.status}`);

beforeEach(async () => {
  vi.clearAllMocks();
  prefsRef.current = null;
  shown = session;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => state.setChatChangePlanSnapshot({ ownerSessionId: "session", items: [] }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("a model change for one Chat", () => {
  it("applies a safe model change for this Chat when Done is pressed, with no review card", async () => {
    api.createChangePlan.mockResolvedValue(plan());
    api.confirmChangePlan.mockResolvedValue(applied());
    api.fetchChatSessionPrefs.mockResolvedValue({ revision: 8, thinkingLevel: "extended" });
    await request();
    expect(api.confirmChangePlan).toHaveBeenCalledExactlyOnceWith(
      "session_model",
      { workspaceId: "workspace", sessionId: "session" },
      { expectedRevision: 3, actionNonce: "nonce" },
    );
    expect(setPrefs).toHaveBeenCalledWith({ revision: 8, thinkingLevel: "extended" });
    expect(prefsRef.current).toEqual({ revision: 8, thinkingLevel: "extended" });
    expect(pushLocalNotice).toHaveBeenCalledWith("This Chat now uses Provider / model at extended effort.", "success");
    expect(cardPlans()).toEqual(["session_model:completed"]);
    expect(state.activeChangePlan).toBeNull();
  });

  it.each([
    ["is not marked safe", { risk: "caution" as const }],
    [
      "needs more than a plain confirmation",
      {
        requiredAction: {
          kind: "secure_input" as const,
          actionId: "action",
          actionNonce: "nonce",
          title: "Enter a key",
        },
      },
    ],
  ])("keeps the review card for a plan that %s", async (_label, change) => {
    api.createChangePlan.mockResolvedValue({ ...plan(), ...change });
    await request();
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(setPrefs).not.toHaveBeenCalled();
    expect(cardPlans()).toEqual(["session_model:awaiting_confirmation"]);
  });

  it("treats an applied answer like a completed one: the Chat's settings are read again", async () => {
    api.createChangePlan.mockResolvedValue(plan());
    api.confirmChangePlan.mockResolvedValue(applied({ status: "applied" }));
    api.fetchChatSessionPrefs.mockResolvedValue({ revision: 8, thinkingLevel: "extended" });
    await request();
    expect(setPrefs).toHaveBeenCalledWith({ revision: 8, thinkingLevel: "extended" });
    expect(cardPlans()).toEqual(["session_model:applied"]);
  });

  it("shows an applied change as applied when only the confirm's answer was lost", async () => {
    api.createChangePlan.mockResolvedValue(plan());
    api.confirmChangePlan.mockRejectedValue(new Error("network lost"));
    api.fetchChangePlan.mockResolvedValue(applied());
    api.fetchChatSessionPrefs.mockResolvedValue({ revision: 8, thinkingLevel: "extended" });
    await request();
    expect(api.fetchChangePlan).toHaveBeenCalledExactlyOnceWith("session_model", {
      workspaceId: "workspace",
      sessionId: "session",
    });
    expect(setPrefs).toHaveBeenCalledWith({ revision: 8, thinkingLevel: "extended" });
    expect(pushLocalNotice).toHaveBeenCalledWith("This Chat now uses Provider / model at extended effort.", "success");
    expect(setUiError).not.toHaveBeenCalled();
    expect(cardPlans()).toEqual(["session_model:completed"]);
  });

  it("shows the failure the Gateway recorded when a lost answer hid a failed change", async () => {
    api.createChangePlan.mockResolvedValue(plan());
    api.confirmChangePlan.mockRejectedValue(new Error("network lost"));
    api.fetchChangePlan.mockResolvedValue({
      ...plan(),
      status: "failed",
      revision: 4,
      requiredAction: undefined,
      result: { summary: "The model owner refused the change." },
    });
    await request();
    expect(cardPlans()).toEqual(["session_model:failed"]);
    expect(pushLocalNotice).not.toHaveBeenCalled();
    expect(setPrefs).not.toHaveBeenCalled();
  });

  it("keeps the review card and says so when the apply is refused", async () => {
    api.createChangePlan.mockResolvedValue(plan());
    api.confirmChangePlan.mockRejectedValue(new Error("revision conflict"));
    api.fetchChangePlan.mockResolvedValue(plan());
    await request();
    expect(setUiError).toHaveBeenCalledWith(expect.stringContaining("revision conflict"));
    expect(pushLocalNotice).not.toHaveBeenCalled();
    expect(setPrefs).not.toHaveBeenCalled();
    expect(cardPlans()).toEqual(["session_model:awaiting_confirmation"]);
  });

  it("shows a plan that ended without applying as it ended, and reports no success", async () => {
    api.createChangePlan.mockResolvedValue(plan());
    api.confirmChangePlan.mockResolvedValue({
      ...plan(),
      status: "failed",
      requiredAction: undefined,
      result: { summary: "The model owner refused the change." },
    });
    await request();
    expect(cardPlans()).toEqual(["session_model:failed"]);
    expect(pushLocalNotice).not.toHaveBeenCalled();
    expect(setPrefs).not.toHaveBeenCalled();
    expect(api.fetchChatSessionPrefs).not.toHaveBeenCalled();
  });

  it("says when the change applied but the Chat's settings could not be read again", async () => {
    api.createChangePlan.mockResolvedValue(plan());
    api.confirmChangePlan.mockResolvedValue(applied());
    api.fetchChatSessionPrefs.mockRejectedValue(new Error("offline"));
    await request();
    expect(pushLocalNotice).toHaveBeenCalledWith("This Chat now uses Provider / model at extended effort.", "success");
    expect(setUiError).toHaveBeenCalledWith(expect.stringContaining("could not be read again"));
  });

  describe("when the operator opens another Chat while the change is pending", () => {
    it("leaves the other Chat's settings, notices and card alone when the confirm resolves", async () => {
      const confirm = deferred<ChangePlanRecord>();
      api.createChangePlan.mockResolvedValue(plan());
      api.confirmChangePlan.mockReturnValue(confirm.promise);
      api.fetchChatSessionPrefs.mockResolvedValue({ revision: 8, thinkingLevel: "extended" });
      prefsRef.current = { revision: 1, model: "other-model" } as unknown as ChatSessionPrefsRecord;
      const { completion } = await requestUntil(() => expect(api.confirmChangePlan).toHaveBeenCalledOnce());
      await switchToOther();
      await act(async () => {
        confirm.resolve(applied());
        await completion;
      });
      expect(api.confirmChangePlan).toHaveBeenCalledOnce();
      expect(api.fetchChatSessionPrefs).not.toHaveBeenCalled();
      expect(setPrefs).not.toHaveBeenCalled();
      expect(prefsRef.current).toEqual({ revision: 1, model: "other-model" });
      expect(pushLocalNotice).not.toHaveBeenCalled();
      expect(state.activeChangePlan).toBeNull();
    });

    it("does not publish the re-read settings when the Chat changes during that read", async () => {
      const reread = deferred<ChatSessionPrefsRecord>();
      api.createChangePlan.mockResolvedValue(plan());
      api.confirmChangePlan.mockResolvedValue(applied());
      api.fetchChatSessionPrefs.mockReturnValue(reread.promise);
      prefsRef.current = { revision: 1, model: "other-model" } as unknown as ChatSessionPrefsRecord;
      const { completion } = await requestUntil(() => expect(api.fetchChatSessionPrefs).toHaveBeenCalledOnce());
      await switchToOther();
      await act(async () => {
        reread.resolve({ revision: 8, thinkingLevel: "extended" } as ChatSessionPrefsRecord);
        await completion;
      });
      expect(setPrefs).not.toHaveBeenCalled();
      expect(prefsRef.current).toEqual({ revision: 1, model: "other-model" });
      expect(setUiError).not.toHaveBeenCalled();
    });

    it("does not publish the re-read settings after a lost answer for the Chat that was left", async () => {
      const lookup = deferred<ChangePlanRecord>();
      api.createChangePlan.mockResolvedValue(plan());
      api.confirmChangePlan.mockRejectedValue(new Error("network lost"));
      api.fetchChangePlan.mockReturnValue(lookup.promise);
      api.fetchChatSessionPrefs.mockResolvedValue({ revision: 8, thinkingLevel: "extended" });
      const { completion } = await requestUntil(() => expect(api.fetchChangePlan).toHaveBeenCalledOnce());
      await switchToOther();
      await act(async () => {
        lookup.resolve(applied());
        await completion;
      });
      expect(setPrefs).not.toHaveBeenCalled();
      expect(prefsRef.current).toBeNull();
      expect(pushLocalNotice).not.toHaveBeenCalled();
    });

    it("shows no refusal for the Chat that was left", async () => {
      const confirm = deferred<ChangePlanRecord>();
      api.createChangePlan.mockResolvedValue(plan());
      api.confirmChangePlan.mockReturnValue(confirm.promise);
      api.fetchChangePlan.mockResolvedValue(plan());
      const { completion } = await requestUntil(() => expect(api.confirmChangePlan).toHaveBeenCalledOnce());
      await switchToOther();
      await act(async () => {
        confirm.reject(new Error("revision conflict"));
        await completion;
      });
      expect(setUiError).not.toHaveBeenCalled();
      expect(setPrefs).not.toHaveBeenCalled();
    });

    it("still applies the change when the operator stays on the Chat", async () => {
      api.createChangePlan.mockResolvedValue(plan());
      api.confirmChangePlan.mockResolvedValue(applied());
      api.fetchChatSessionPrefs.mockResolvedValue({ revision: 8, thinkingLevel: "extended" });
      await request();
      expect(setPrefs).toHaveBeenCalledWith({ revision: 8, thinkingLevel: "extended" });
      expect(prefsRef.current).toEqual({ revision: 8, thinkingLevel: "extended" });
    });
  });
});
