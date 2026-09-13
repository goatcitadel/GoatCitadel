import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSettingsChange,
  __resetSettingsChangesForTests,
} from "./use-settings-change";
import {
  useSessionDraft,
  __resetSessionDraftsForTests,
} from "../library/session-drafts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
const mocks = vi.hoisted(() => ({ plan: vi.fn(), settings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlan: mocks.plan,
  fetchSettings: mocks.settings,
}));
const receipt = {
  planId: "plan-budget",
  revision: 2,
  status: "awaiting_approval" as const,
  risk: "caution" as const,
  summary: "Approval required",
};
function settings(
  revision = 1,
  budgetMode = "balanced",
  changePlanReceipt?: unknown,
) {
  return {
    revision,
    budgetMode,
    ...(changePlanReceipt ? { changePlanReceipt } : {}),
  } as RuntimeSettingsResponse;
}
function plan(status = "awaiting_approval") {
  return {
    ...receipt,
    status,
    revision: 3,
    kind: "runtime_configuration",
    origin: { surface: "settings", workspaceId: "default" },
    target: { ownerId: "runtime_settings", expectedRevision: 1 },
    request: {
      kind: "runtime_configuration",
      change: { operation: "budget_mode", mode: "power" },
    },
    evidenceRefs: [],
    rollbackRefs: [],
    summary: "Current plan status",
  };
}
describe("Settings save settlement", () => {
  let renderer: ReactTestRenderer;
  let editor: ReturnType<typeof useSessionDraft<string>>;
  let change: ReturnType<typeof useSettingsChange<string>>;
  const reload = vi.fn(async () => undefined);
  function Editor() {
    editor = useSessionDraft("settings-test:budget", "balanced", 1, {
      label: "Budget",
    });
    change = useSettingsChange({
      key: editor.key,
      operation: "budget_mode",
      matches: (value, submitted) => value.budgetMode === submitted,
      acceptSaved: editor.acceptSaved,
      reload,
    });
    return null;
  }
  beforeEach(() => {
    __resetSettingsChangesForTests();
    __resetSessionDraftsForTests();
    vi.clearAllMocks();
    mocks.plan.mockResolvedValue(plan());
    mocks.settings.mockResolvedValue(settings(2, "power"));
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
  });
  async function mount() {
    await act(async () => {
      renderer = create(<Editor />);
    });
  }
  async function submit() {
    await act(async () => {
      editor.setValue("power");
    });
    await act(async () => {
      change.receive(settings(1, "balanced", receipt), "power", 1);
    });
  }
  it("keeps the exact pending plan across route unmount and prevents duplicate submission", async () => {
    await mount();
    await submit();
    expect(change.isPending()).toBe(true);
    expect(editor.isDirty).toBe(true);
    expect(editor.baseRevision).toBe(1);
    await act(async () => renderer.unmount());
    await mount();
    expect(change.change?.receipt.planId).toBe("plan-budget");
    expect(change.isPending()).toBe(true);
    expect(mocks.plan).toHaveBeenCalledWith("plan-budget", {
      workspaceId: "default",
    });
  });
  it("acknowledges only the submitted draft after matching canonical settlement", async () => {
    await mount();
    await submit();
    await act(async () => editor.setValue("saver"));
    mocks.plan.mockResolvedValue(plan("completed"));
    await act(async () => {
      await change.refresh();
    });
    expect(change.hasPending).toBe(false);
    expect(editor.value).toBe("saver");
    expect(editor.isDirty).toBe(true);
    expect(editor.baseRevision).toBe(2);
  });
  it.each(["failed", "cancelled", "rolled_back"])(
    "preserves input and releases the save after %s",
    async (status) => {
      await mount();
      await submit();
      mocks.plan.mockResolvedValue(plan(status));
      await act(async () => {
        await change.refresh();
      });
      expect(editor.value).toBe("power");
      expect(editor.isDirty).toBe(true);
      expect(change.hasPending).toBe(false);
      expect(mocks.settings).not.toHaveBeenCalled();
    },
  );
  it.each(["manual_required", "rollback_failed", "applying", "verifying"])(
    "does not allow another mutation while %s needs reconciliation",
    async (status) => {
      await mount();
      await submit();
      mocks.plan.mockResolvedValue(plan(status));
      await act(async () => {
        await change.refresh();
      });
      expect(change.hasPending).toBe(true);
      expect(editor.isDirty).toBe(true);
    },
  );
  it("does not clear a draft for mismatched plan evidence or a completed plan with contradictory settings", async () => {
    await mount();
    await submit();
    mocks.plan.mockResolvedValue({ ...plan("completed"), planId: "unrelated" });
    await act(async () => {
      await change.refresh();
    });
    expect(change.change?.error).toContain("does not match");
    mocks.plan.mockResolvedValue(plan("completed"));
    mocks.settings.mockResolvedValue(settings(2, "balanced"));
    await act(async () => {
      await change.refresh();
    });
    expect(change.change?.error).toContain("do not confirm");
    expect(editor.isDirty).toBe(true);
    expect(change.hasPending).toBe(true);
  });
  it("retains the receipt through unavailable evidence", async () => {
    await mount();
    await submit();
    mocks.plan.mockRejectedValue(new Error("Gateway unavailable"));
    await act(async () => {
      await change.refresh();
    });
    expect(change.change?.error).toBe("Gateway unavailable");
    expect(change.hasPending).toBe(true);
    expect(editor.isDirty).toBe(true);
  });
  it("rejects unchanged revisions and false direct-save acknowledgement", async () => {
    await mount();
    await act(async () => editor.setValue("power"));
    expect(() => change.receive(settings(1, "power"), "power", 1)).toThrow(
      "do not confirm",
    );
    expect(() => change.receive(settings(2, "balanced"), "power", 1)).toThrow(
      "do not confirm",
    );
    expect(editor.isDirty).toBe(true);
    await act(async () => {
      expect(change.receive(settings(2, "power"), "power", 1)).toBe(true);
    });
    expect(editor.isDirty).toBe(false);
  });
  it("keeps an in-flight save blocked after the editor unmounts", async () => {
    await mount();
    await act(async () => { expect(change.beginSave()).toBe(true); });
    const original = change;
    await act(async () => renderer.unmount());
    await mount();
    expect(change.hasPending).toBe(true);
    expect(change.beginSave()).toBe(false);
    await act(async () => original.endSave());
    expect(change.hasPending).toBe(false);
  });
  it("acknowledges a delayed response only on its submitted record", async () => {
    let scopedEditor!: ReturnType<typeof useSessionDraft<string>>;
    let scopedChange!: ReturnType<typeof useSettingsChange<string>>;
    function Scoped({ id }: { id: string }) {
      scopedEditor = useSessionDraft("settings-scope:" + id, "balanced", 1, { label: id });
      scopedChange = useSettingsChange({ key: scopedEditor.key, operation: "budget_mode",
        matches: (value, submitted) => value.budgetMode === submitted, acceptSaved: scopedEditor.acceptSaved, reload });
      return null;
    }
    await act(async () => { renderer = create(<Scoped id="first" />); });
    await act(async () => scopedEditor.setValue("power"));
    const submittedChange = scopedChange;
    await act(async () => renderer.update(<Scoped id="second" />));
    await act(async () => scopedEditor.setValue("saver"));
    await act(async () => { expect(submittedChange.receive(settings(2, "power"), "power", 1)).toBe(true); });
    expect(scopedEditor.value).toBe("saver");
    expect(scopedEditor.baseRevision).toBe(1);
    await act(async () => renderer.update(<Scoped id="first" />));
    expect(scopedEditor.isDirty).toBe(false);
  });

});
