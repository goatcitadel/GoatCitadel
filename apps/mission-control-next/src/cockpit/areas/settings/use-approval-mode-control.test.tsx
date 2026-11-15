// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { gatewayAuthSettingsFixture } from "../../../features/native-routes/settings/gateway-auth.test-support";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { __resetApprovalModeUncertaintyForTests, retainApprovalModeUncertainty } from "./approval-mode-state";
import { useApprovalModeControl } from "./use-approval-mode-control";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchChangePlans: vi.fn(),
  base: "owner",
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: Root, client: QueryClient, owner: RuntimeSettingsResponse;
let control: ReturnType<typeof useApprovalModeControl>;
function Probe({ scope, safeOnly }: { scope: string; safeOnly: boolean }) {
  control = useApprovalModeControl({ scope, safeOnly });
  return null;
}
async function render(scope = "one", safeOnly = false) {
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <Probe scope={scope} safeOnly={safeOnly} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(control.settings.isFetching).toBe(false));
}
async function prepare(safeOnly = false) {
  await render("one", safeOnly);
  await act(async () => control.draft.setValue("approve_risky"));
}
beforeEach(() => {
  vi.resetAllMocks();
  api.base = "owner";
  owner = gatewayAuthSettingsFixture();
  api.fetchSettings.mockImplementation(async () => structuredClone(owner));
  api.patchSettings.mockImplementation(
    async (input: { toolApprovalMode: RuntimeSettingsResponse["toolApprovalMode"] }) => {
      owner = { ...owner, revision: owner.revision + 1, toolApprovalMode: input.toolApprovalMode };
      return structuredClone(owner);
    },
  );
  root = createRoot(document.createElement("div"));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  __resetApprovalModeUncertaintyForTests();
});

describe("approval save review lifetime", () => {
  it("retains normal save behavior under StrictMode", async () => {
    await prepare();
    await act(async () => control.requestSave());
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 41,
      toolApprovalMode: "approve_risky",
    });
    expect(control.draft.isDirty).toBe(false);
  });

  it("does not dispatch after unmount during the fresh owner read", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await act(async () => root.render(null));
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
    await render();
    expect(control.canSave).toBe(true);
  });

  it("does not dispatch after leaving and returning to the reviewed scope", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await render("two");
    await render("one");
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(control.draft.isDirty).toBe(true);
  });

  it("invalidates a pending preflight even when a changed draft is restored", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await act(async () => control.draft.setValue("approve_all"));
    await act(async () => control.draft.setValue("approve_risky"));
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("invalidates a preflight when another owner refresh changes the settings revision", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await act(async () => client.setQueryData(["system", "settings-approval-mode"], { ...owner, revision: 42 }));
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("does not dispatch to a different installation after the preflight", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    api.base = "other-owner";
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("acknowledges a dispatched origin draft after unmount without reporting a late view success", async () => {
    await prepare();
    const write = deferred<RuntimeSettingsResponse>();
    api.patchSettings.mockReturnValueOnce(write.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    owner = { ...owner, revision: 42, toolApprovalMode: "approve_risky" };
    await act(async () => {
      write.resolve(owner);
      expect(await pending).toBe(false);
    });
    await render();
    expect(control.draft.isDirty).toBe(false);
    expect(control.notice).toBeNull();
  });

  it("retains unknown dispatched outcome across unmount and scope remount", async () => {
    await prepare();
    const write = deferred<RuntimeSettingsResponse>();
    api.patchSettings.mockReturnValueOnce(write.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await act(async () => root.render(null));
    await act(async () => {
      write.resolve({ ...owner, revision: 42 });
      await pending;
    });
    await render("two");
    // The lost answer is checked at once; with the Gateway not answering about open changes it stays unconfirmed.
    await vi.waitFor(() => expect(control.uncertain?.checking).toBe(false));
    expect(control.uncertain?.message).toContain("isn't confirmed yet");
    expect(control.canSave).toBe(false);
    await act(async () => control.requestSave());
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
  });

  it("withholds bypass even for a forced first-run draft", async () => {
    await prepare(true);
    await act(async () => control.draft.setValue("bypass"));
    expect(control.canSave).toBe(false);
    await act(async () => control.requestSave());
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  describe("a save that does not apply cleanly", () => {
    const waitingPlan = (planId: string, approvalId: string, mode = "approve_all") => ({
      planId,
      status: "awaiting_approval",
      title: "Change the tool approval rule",
      origin: { surface: "settings", workspaceId: "default" },
      kind: "runtime_configuration",
      request: { kind: "runtime_configuration", change: { operation: "tool_approval_mode", mode } },
      target: { ownerId: "runtime_settings", resourceId: "tool_approval_mode", expectedRevision: 41 },
      createdAt: "2026-11-15T10:00:00.000Z",
      requiredAction: { kind: "approval", approvalId },
    });

    it("settles a lost save from the saved rule and unlocks", async () => {
      await prepare();
      api.patchSettings.mockImplementation(async () => {
        owner = { ...owner, revision: owner.revision + 1, toolApprovalMode: "approve_risky" };
        throw new Error("Failed to fetch");
      });
      api.fetchChangePlans.mockResolvedValue({ items: [] });
      await act(async () => void control.requestSave());
      await vi.waitFor(() => expect(control.uncertain).toBeUndefined());
      expect(control.locked).toBe(false);
      expect(control.notice).toBe("Tool approval rule saved and confirmed by GoatCitadel.");
      expect(api.patchSettings).toHaveBeenCalledTimes(1);
    });

    it("keeps the lock when the saved rule can't be read yet, and checks again on request", async () => {
      await prepare();
      api.patchSettings.mockImplementation(async () => {
        api.fetchSettings.mockRejectedValue(new Error("Failed to fetch"));
        throw new Error("Failed to fetch");
      });
      await act(async () => void control.requestSave());
      await vi.waitFor(() => expect(control.uncertain?.checking).toBe(false));
      expect(control.uncertain?.message).toBe(
        "GoatCitadel didn't answer, so this save isn't confirmed yet. Saving stays paused until the saved rule can be checked.",
      );
      expect(control.locked).toBe(true);
      expect(control.notice ?? "").not.toContain("not saved");

      // The Gateway answers on the next check: the write had been applied.
      owner = { ...owner, revision: owner.revision + 1, toolApprovalMode: "approve_risky" };
      api.fetchSettings.mockImplementation(async () => structuredClone(owner));
      api.fetchChangePlans.mockResolvedValue({ items: [] });
      await act(async () => control.reconcile());
      await vi.waitFor(() => expect(control.uncertain).toBeUndefined());
      expect(control.notice).toBe("Tool approval rule saved and confirmed by GoatCitadel.");
      expect(api.patchSettings).toHaveBeenCalledTimes(1);
    });

    it("keeps the lock when the open changes can't be read, never reporting not saved", async () => {
      await prepare();
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      api.fetchChangePlans.mockRejectedValue(new Error("Failed to fetch"));
      await act(async () => void control.requestSave());
      await vi.waitFor(() => expect(control.uncertain?.checking).toBe(false));
      expect(control.locked).toBe(true);
      expect(control.notice ?? "").not.toContain("was not saved");
    });

    it("says plainly when the rule was not saved", async () => {
      await prepare();
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      api.fetchChangePlans.mockResolvedValue({ items: [] });
      await act(async () => void control.requestSave());
      await vi.waitFor(() =>
        expect(control.notice).toBe("Your approval rule was not saved. Your draft is kept, so you can save it again."),
      );
      expect(control.uncertain).toBeUndefined();
      expect(control.locked).toBe(false);
      expect(control.draft.isDirty).toBe(true);
    });

    it("leads to the change a lost answer queued instead of unlocking into a second save", async () => {
      await prepare();
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      api.fetchChangePlans.mockResolvedValue({ items: [waitingPlan("plan-lost", "approval-lost", "approve_risky")] });
      await act(async () => void control.requestSave());
      await vi.waitFor(() =>
        expect(control.waiting).toMatchObject({ planId: "plan-lost", approvalId: "approval-lost" }),
      );
      expect(control.uncertain).toBeUndefined();
      expect(control.canSave).toBe(false);
      expect(api.patchSettings).toHaveBeenCalledTimes(1);
    });

    it("opens the waiting change a conflict names, whatever value it holds", async () => {
      await prepare();
      api.patchSettings.mockRejectedValue({
        status: 409,
        body: { code: "WRITE_CONFLICT", details: { resourceKind: "change_plan", resourceId: "plan-waiting" } },
      });
      api.fetchChangePlan.mockResolvedValue(waitingPlan("plan-waiting", "approval-waiting", "approve_all"));
      await act(async () => void control.requestSave());
      await vi.waitFor(() =>
        expect(control.waiting).toMatchObject({ planId: "plan-waiting", approvalId: "approval-waiting" }),
      );
      expect(control.uncertain).toBeUndefined();
      expect(control.canSave).toBe(false);
      expect(control.draft.value).toBe("approve_risky");
      expect(api.patchSettings).toHaveBeenCalledTimes(1);
    });

    it("shows a plain refusal as not saved without locking", async () => {
      await prepare();
      api.patchSettings.mockRejectedValue({ status: 422, body: { error: "That rule is managed." } });
      await act(async () => void control.requestSave());
      await vi.waitFor(() => expect(control.notice).toContain("Not saved."));
      expect(control.uncertain).toBeUndefined();
      expect(control.locked).toBe(false);
      expect(api.fetchChangePlans).not.toHaveBeenCalled();
    });

    it("calls a change that finished between the two reads saved, never not saved", async () => {
      await prepare();
      api.patchSettings.mockImplementation(async () => {
        // The plans read still sees the change being applied; by the settings read it has finished.
        owner = { ...owner, revision: owner.revision + 1, toolApprovalMode: "approve_risky" };
        throw new Error("Failed to fetch");
      });
      api.fetchChangePlans.mockResolvedValue({
        items: [
          {
            ...waitingPlan("plan-late", "approval-late", "approve_risky"),
            status: "applying",
            requiredAction: undefined,
          },
        ],
      });
      await act(async () => void control.requestSave());
      await vi.waitFor(() => expect(control.uncertain).toBeUndefined());
      expect(control.notice).toBe("Tool approval rule saved and confirmed by GoatCitadel.");
      expect(control.waiting).toBeNull();
      // The open changes are read before the saved rule.
      const plansRead = api.fetchChangePlans.mock.invocationCallOrder[0]!;
      const writeAt = api.patchSettings.mock.invocationCallOrder[0]!;
      const afterWrite = api.fetchSettings.mock.invocationCallOrder.filter((order) => order > writeAt);
      expect(afterWrite.every((order) => order > plansRead)).toBe(true);
    });

    it("shows nothing misleading when the named change finished before it was looked up", async () => {
      await prepare();
      api.patchSettings.mockRejectedValue({
        status: 409,
        body: { code: "WRITE_CONFLICT", details: { resourceKind: "change_plan", resourceId: "plan-waiting" } },
      });
      api.fetchChangePlan.mockResolvedValue({
        ...waitingPlan("plan-waiting", "approval-waiting"),
        status: "completed",
      });
      await act(async () => void control.requestSave());
      await vi.waitFor(() => expect(api.fetchChangePlan).toHaveBeenCalled());
      await act(async () => undefined);
      expect(control.waiting).toBeNull();
      expect(control.notice).toBeNull();
      expect(control.draft.value).toBe("approve_risky");
    });

    it("clears a held waiting change on a re-check once it was decided elsewhere", async () => {
      await prepare();
      api.patchSettings.mockRejectedValue({
        status: 409,
        body: { code: "WRITE_CONFLICT", details: { resourceKind: "change_plan", resourceId: "plan-waiting" } },
      });
      api.fetchChangePlan.mockResolvedValue(waitingPlan("plan-waiting", "approval-waiting"));
      await act(async () => void control.requestSave());
      await vi.waitFor(() => expect(control.waiting).toMatchObject({ stage: "approval" }));
      expect(control.notice).toBe("One change to this rule is already waiting for your approval.");
      expect(control.canSave).toBe(false);
      api.fetchChangePlan.mockResolvedValue({
        ...waitingPlan("plan-waiting", "approval-waiting"),
        status: "cancelled",
      });
      await act(async () => control.recheckWaiting());
      await vi.waitFor(() => expect(control.waiting).toBeNull());
      expect(control.notice).toBeNull();
      await vi.waitFor(() => expect(control.canSave).toBe(true));
    });

    it("says a change the operator must review waits for review, not that it is being applied", async () => {
      await prepare();
      api.patchSettings.mockRejectedValue({
        status: 409,
        body: { code: "WRITE_CONFLICT", details: { resourceKind: "change_plan", resourceId: "plan-waiting" } },
      });
      api.fetchChangePlan.mockResolvedValue({
        ...waitingPlan("plan-waiting", "approval-waiting"),
        status: "awaiting_confirmation",
        requiredAction: { kind: "confirmation" },
      });
      await act(async () => void control.requestSave());
      await vi.waitFor(() => expect(control.waiting).toMatchObject({ stage: "review" }));
      expect(control.notice).toBe("One change to this rule is waiting for your review.");
    });

    it("does not let a record from another Gateway lock this one", async () => {
      retainApprovalModeUncertainty({
        message: "GoatCitadel didn't answer, so this save isn't confirmed yet.",
        submitted: "approve_risky",
        baseRevision: 40,
        previous: "approve_all",
        installation: "another-owner",
        checking: false,
      });
      await render();
      expect(control.uncertain).toBeUndefined();
      expect(control.locked).toBe(false);
      await act(async () => control.draft.setValue("approve_risky"));
      expect(control.canSave).toBe(true);
      // It still holds for the Gateway it belongs to.
      api.base = "another-owner";
      await render("two");
      expect(control.uncertain?.installation).toBe("another-owner");
    });
  });
});
