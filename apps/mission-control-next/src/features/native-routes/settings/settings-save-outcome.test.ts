import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";

const api = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), fetchChangePlans: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlan: api.fetchChangePlan,
  fetchChangePlans: api.fetchChangePlans,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));

import {
  classifySettingsSaveFailure,
  describeWaitingChange,
  findActiveSettingsChange,
  findWaitingSettingsChange,
  waitingNoticeFor,
} from "./settings-save-outcome";

const http = (status: number, body?: unknown) => Object.assign(new Error("x"), { status, body, kind: "http" });

function plan(overrides: Record<string, unknown> = {}): ChangePlanRecord {
  return {
    planId: "plan-7",
    status: "awaiting_approval",
    kind: "runtime_configuration",
    origin: { surface: "settings", workspaceId: "default" },
    title: "Turn off Claude Code CLI: reuse one process between tool steps",
    createdAt: "2026-11-15T10:00:00.000Z",
    requiredAction: { kind: "approval", approvalId: "approval-7" },
    ...overrides,
  } as unknown as ChangePlanRecord;
}

afterEach(() => vi.resetAllMocks());

describe("classifySettingsSaveFailure", () => {
  it("names the waiting change behind a plan conflict", () => {
    expect(
      classifySettingsSaveFailure(
        http(409, { code: "WRITE_CONFLICT", details: { resourceKind: "change_plan", resourceId: "plan-7" } }),
      ),
    ).toEqual({ kind: "waiting", planId: "plan-7" });
    expect(
      classifySettingsSaveFailure(
        http(409, { code: "STATE_CONFLICT", details: { expectedRevision: 3, currentRevision: 4 } }),
      ),
    ).toEqual({ kind: "conflict" });
  });

  it("does not call a plan conflict without a usable plan id waiting", () => {
    for (const resourceId of [undefined, "", "   ", 7]) {
      expect(
        classifySettingsSaveFailure(
          http(409, { code: "WRITE_CONFLICT", details: { resourceKind: "change_plan", resourceId } }),
        ),
      ).toEqual({ kind: "conflict" });
    }
    expect(
      classifySettingsSaveFailure(
        http(409, { code: "WRITE_CONFLICT", details: { resourceKind: "settings", resourceId: "x" } }),
      ),
    ).toEqual({ kind: "conflict" });
  });

  it("treats a stated refusal as final and a lost answer as uncertain", () => {
    expect(
      classifySettingsSaveFailure(http(422, { error: "Secure channel credential storage is unavailable." })).kind,
    ).toBe("refused");
    expect(classifySettingsSaveFailure(http(400, { error: "Bad" })).kind).toBe("refused");
    expect(classifySettingsSaveFailure(http(422, { error: "x", committed: true })).kind).toBe("uncertain");
    expect(classifySettingsSaveFailure(http(422, { error: "x", mutationCommitted: true })).kind).toBe("uncertain");
    expect(classifySettingsSaveFailure(http(400, { details: { mutationCommitted: true } })).kind).toBe("uncertain");
    for (const status of [408, 429, 500, 503]) expect(classifySettingsSaveFailure(http(status)).kind).toBe("uncertain");
    expect(classifySettingsSaveFailure(new Error("Failed to fetch")).kind).toBe("uncertain");
    expect(classifySettingsSaveFailure("nope").kind).toBe("uncertain");
  });

  it("treats a response that never came as uncertain even from an API error object", () => {
    expect(
      classifySettingsSaveFailure(Object.assign(new Error("x"), { status: undefined, kind: "network" })).kind,
    ).toBe("uncertain");
  });
});

describe("findWaitingSettingsChange", () => {
  it("finds a waiting Settings change and tells a finished or foreign plan apart", async () => {
    api.fetchChangePlan.mockResolvedValue(plan());
    expect(await findWaitingSettingsChange("plan-7")).toEqual({
      kind: "open",
      change: {
        planId: "plan-7",
        approvalId: "approval-7",
        title: "Turn off Claude Code CLI: reuse one process between tool steps",
        stage: "approval",
      },
    });
    expect(api.fetchChangePlan).toHaveBeenCalledWith("plan-7", { workspaceId: "default" });
    for (const status of ["completed", "failed", "cancelled", "applied"]) {
      api.fetchChangePlan.mockResolvedValue(plan({ status }));
      expect(await findWaitingSettingsChange("plan-7")).toEqual({ kind: "finished" });
    }
    api.fetchChangePlan.mockResolvedValue(plan({ origin: { surface: "chat", workspaceId: "default" } }));
    expect(await findWaitingSettingsChange("plan-7")).toEqual({ kind: "foreign" });
    api.fetchChangePlan.mockResolvedValue(plan({ origin: { surface: "settings", workspaceId: "other" } }));
    expect(await findWaitingSettingsChange("plan-7")).toEqual({ kind: "foreign" });
    api.fetchChangePlan.mockRejectedValue(new Error("offline"));
    expect(await findWaitingSettingsChange("plan-7")).toEqual({ kind: "unreadable" });
  });

  it("separates a change being applied from one that waits for the operator", async () => {
    for (const status of ["applying", "verifying", "monitoring", "rolling_back"]) {
      api.fetchChangePlan.mockResolvedValue(plan({ status, requiredAction: undefined }));
      expect(await findWaitingSettingsChange("plan-7")).toMatchObject({ kind: "open", change: { stage: "applying" } });
    }
    for (const status of ["awaiting_input", "awaiting_confirmation"]) {
      api.fetchChangePlan.mockResolvedValue(plan({ status, requiredAction: { kind: "confirmation" } }));
      expect(await findWaitingSettingsChange("plan-7")).toMatchObject({ kind: "open", change: { stage: "review" } });
    }
    // Not ready for anyone and not listed in Inbox: nothing for the operator to open yet.
    for (const status of ["draft", "staging"]) {
      api.fetchChangePlan.mockResolvedValue(plan({ status, requiredAction: undefined }));
      expect(await findWaitingSettingsChange("plan-7")).toMatchObject({ kind: "open", change: { stage: "preparing" } });
    }
    // A secret Inbox cannot take is the operator's to enter where the change was started.
    api.fetchChangePlan.mockResolvedValue(
      plan({ status: "awaiting_input", requiredAction: { kind: "secure_input", actionId: "a" } }),
    );
    expect(await findWaitingSettingsChange("plan-7")).toMatchObject({ kind: "open", change: { stage: "credential" } });
    // An approval step with no approval to open is still something the operator must look at.
    api.fetchChangePlan.mockResolvedValue(plan({ requiredAction: { kind: "approval" } }));
    expect(await findWaitingSettingsChange("plan-7")).toMatchObject({ kind: "open", change: { stage: "review" } });
  });
});

describe("describeWaitingChange and waitingNoticeFor", () => {
  it("says the true thing for each stage", () => {
    expect(describeWaitingChange({ planId: "p", stage: "approval", approvalId: "a" })).toBe(
      "One change to this setting is already waiting for your approval.",
    );
    expect(describeWaitingChange({ planId: "p", stage: "review" })).toBe(
      "One change to this setting is waiting for your review.",
    );
    expect(describeWaitingChange({ planId: "p", stage: "applying" }, "rule")).toBe(
      "One change to this rule is still being applied. Refresh in a moment to see it.",
    );
    expect(describeWaitingChange({ planId: "p", unreadable: true })).toBe(
      "One change to this setting is already waiting.",
    );
  });

  it("holds only an open or an unreadable plan", () => {
    const change = { planId: "p", stage: "review" as const };
    expect(waitingNoticeFor({ kind: "open", change }, "p")).toBe(change);
    expect(waitingNoticeFor({ kind: "unreadable" }, "p")).toEqual({ planId: "p", unreadable: true });
    expect(waitingNoticeFor({ kind: "finished" }, "p")).toBeNull();
    expect(waitingNoticeFor({ kind: "foreign" }, "p")).toBeNull();
  });
});
describe("findActiveSettingsChange", () => {
  it("returns the newest open matching Settings plan", async () => {
    api.fetchChangePlans.mockResolvedValue({
      items: [
        plan({ planId: "old", createdAt: "2026-11-15T09:00:00.000Z" }),
        plan({ planId: "new", createdAt: "2026-11-15T11:00:00.000Z" }),
        plan({ planId: "done", status: "completed", createdAt: "2026-11-15T12:00:00.000Z" }),
        plan({
          planId: "chat",
          origin: { surface: "chat", workspaceId: "default" },
          createdAt: "2026-11-15T13:00:00.000Z",
        }),
        plan({ planId: "nomatch", title: "other", createdAt: "2026-11-15T14:00:00.000Z" }),
      ],
    });
    const found = await findActiveSettingsChange((candidate) => candidate.title.startsWith("Turn off"));
    expect(found).toMatchObject({ planId: "new", approvalId: "approval-7" });
    expect(api.fetchChangePlans).toHaveBeenCalledWith({ workspaceId: "default" }, { limit: 50 });
  });

  it("answers undefined when nothing is open and unreadable when the read fails", async () => {
    api.fetchChangePlans.mockResolvedValue({ items: [] });
    expect(await findActiveSettingsChange(() => true)).toBeUndefined();
    api.fetchChangePlans.mockRejectedValue(new Error("offline"));
    expect(await findActiveSettingsChange(() => true)).toBe("unreadable");
  });
});
