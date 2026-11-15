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
  findActiveSettingsChange,
  findWaitingSettingsChange,
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
  it("finds a waiting Settings change and ignores finished or foreign plans", async () => {
    api.fetchChangePlan.mockResolvedValue(plan());
    expect(await findWaitingSettingsChange("plan-7")).toEqual({
      planId: "plan-7",
      approvalId: "approval-7",
      title: "Turn off Claude Code CLI: reuse one process between tool steps",
      applying: false,
    });
    expect(api.fetchChangePlan).toHaveBeenCalledWith("plan-7", { workspaceId: "default" });
    api.fetchChangePlan.mockResolvedValue(plan({ status: "completed" }));
    expect(await findWaitingSettingsChange("plan-7")).toBeUndefined();
    api.fetchChangePlan.mockResolvedValue(plan({ origin: { surface: "chat", workspaceId: "default" } }));
    expect(await findWaitingSettingsChange("plan-7")).toBeUndefined();
    api.fetchChangePlan.mockResolvedValue(plan({ origin: { surface: "settings", workspaceId: "other" } }));
    expect(await findWaitingSettingsChange("plan-7")).toBeUndefined();
    api.fetchChangePlan.mockRejectedValue(new Error("offline"));
    expect(await findWaitingSettingsChange("plan-7")).toBeUndefined();
  });

  it("reports a change being applied without an approval to decide", async () => {
    api.fetchChangePlan.mockResolvedValue(plan({ status: "verifying", requiredAction: undefined }));
    expect(await findWaitingSettingsChange("plan-7")).toMatchObject({ planId: "plan-7", applying: true });
    expect((await findWaitingSettingsChange("plan-7"))?.approvalId).toBeUndefined();
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
