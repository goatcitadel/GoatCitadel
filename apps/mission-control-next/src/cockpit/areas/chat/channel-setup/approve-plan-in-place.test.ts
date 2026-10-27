import type { ApprovalRequest, ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvePlanInPlace, ensureHostsAllowed } from "./approve-plan-in-place";

const api = vi.hoisted(() => ({
  fetchChangePlan: vi.fn(),
  createChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  respondToChangePlan: vi.fn(),
  resolveApproval: vi.fn(),
  fetchApproval: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlan: api.fetchChangePlan,
  createChangePlan: api.createChangePlan,
  confirmChangePlan: api.confirmChangePlan,
  respondToChangePlan: api.respondToChangePlan,
  resolveApproval: api.resolveApproval,
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));

const ctx = { workspaceId: "w-1" };

const confirmation: ChangePlanRequiredAction = {
  kind: "confirmation",
  actionId: "act-c",
  actionNonce: "nonce-c",
  title: "Confirm",
  confirmationText: "Go ahead",
};
const approvalAction: ChangePlanRequiredAction = {
  kind: "approval",
  actionId: "act-a",
  actionNonce: "nonce-a",
  title: "Approve",
  risk: "caution",
  approvalId: "ap-1",
};

function plan(overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "p-1",
    origin: { surface: "settings", workspaceId: "w-1" },
    adapter: { adapterId: "channel_connection", version: 1 },
    kind: "channel_connection",
    scope: "channel",
    status: "awaiting_confirmation",
    phase: "confirmation",
    revision: 1,
    request: { kind: "channel_connection", channelKind: "channel.telegram", draftId: "d-1" },
    intentHash: "hash",
    target: { ownerId: "channel_setup_draft", resourceId: "d-1", expectedRevision: 4 },
    title: "Connect Telegram",
    summary: "Connect Telegram.",
    impact: "Turns on Telegram.",
    risk: "caution",
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "ap-1",
    kind: "change_plan_effect",
    riskLevel: "caution",
    status: "pending",
    payload: { planId: "p-1" },
    preview: {},
    createdAt: "2026-10-26T10:00:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}

function httpError(status: number): ApiRequestError {
  return new ApiRequestError(`API error ${status}: {}`, { kind: "http", method: "POST", path: "/x", status });
}

/** The name of every call the page made, in the order it made them. */
function calls(): string[] {
  return Object.entries(api)
    .flatMap(([name, mock]) => mock.mock.invocationCallOrder.map((order) => ({ order, name })))
    .sort((a, b) => a.order - b.order)
    .map((call) => call.name);
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("approvePlanInPlace", () => {
  it("confirms, approves its own approval, then continues to completion", async () => {
    api.fetchChangePlan
      .mockResolvedValueOnce(plan({ revision: 1, requiredAction: confirmation }))
      .mockResolvedValueOnce(
        plan({ revision: 3, status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
      )
      .mockResolvedValueOnce(
        plan({ revision: 3, status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
      )
      .mockResolvedValueOnce(plan({ revision: 5, status: "completed", phase: "terminal" }));
    api.confirmChangePlan.mockResolvedValue(plan({ revision: 2 }));
    api.fetchApproval
      .mockResolvedValueOnce(approval({ status: "pending" }))
      .mockResolvedValueOnce(approval({ status: "approved" }));
    api.resolveApproval.mockResolvedValue({});
    api.respondToChangePlan.mockResolvedValue(plan({ revision: 4, status: "applying" }));

    const outcome = await approvePlanInPlace("p-1", "w-1");

    expect(outcome).toMatchObject({ kind: "completed", plan: { planId: "p-1", status: "completed" } });
    expect(calls()).toEqual([
      "fetchChangePlan",
      "confirmChangePlan",
      "fetchChangePlan",
      "fetchApproval",
      "resolveApproval",
      "fetchChangePlan",
      "fetchApproval",
      "respondToChangePlan",
      "fetchChangePlan",
    ]);
    expect(api.fetchChangePlan).toHaveBeenNthCalledWith(1, "p-1", ctx);
    expect(api.confirmChangePlan).toHaveBeenCalledExactlyOnceWith("p-1", ctx, {
      expectedRevision: 1,
      actionNonce: "nonce-c",
    });
    expect(api.fetchApproval).toHaveBeenNthCalledWith(1, "ap-1", ctx);
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("ap-1", "approve");
    expect(api.respondToChangePlan).toHaveBeenCalledExactlyOnceWith("p-1", ctx, {
      expectedRevision: 3,
      actionId: "act-a",
      actionNonce: "nonce-a",
      values: {},
    });
  });

  it("never approves an approval for another change", async () => {
    api.fetchChangePlan.mockResolvedValue(
      plan({ status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    api.fetchApproval.mockResolvedValue(approval({ payload: { planId: "other" } }));

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({
      kind: "failed",
      message: "This approval belongs to another change.",
    });
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(api.respondToChangePlan).not.toHaveBeenCalled();
  });

  it("never approves an approval that is not a change approval", async () => {
    api.fetchChangePlan.mockResolvedValue(
      plan({ status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    api.fetchApproval.mockResolvedValue(approval({ kind: "tool_call", payload: { planId: "p-1" } }));

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({
      kind: "failed",
      message: "This approval belongs to another change.",
    });
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("hands off to Inbox when this sign-in can't approve", async () => {
    const waiting = plan({ status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction });
    api.fetchChangePlan.mockResolvedValue(waiting);
    api.fetchApproval.mockResolvedValue(approval());
    api.resolveApproval.mockRejectedValue(httpError(403));

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({ kind: "elsewhere", plan: waiting, approvalId: "ap-1" });
    expect(api.respondToChangePlan).not.toHaveBeenCalled();
  });

  it("hands off to Inbox on a 401 from the approval too", async () => {
    api.fetchChangePlan.mockResolvedValue(
      plan({ status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    api.fetchApproval.mockResolvedValue(approval());
    api.resolveApproval.mockRejectedValue(httpError(401));

    expect(await approvePlanInPlace("p-1", "w-1")).toMatchObject({ kind: "elsewhere", approvalId: "ap-1" });
  });

  it("reports other approval failures in plain words, not the raw response", async () => {
    api.fetchChangePlan.mockResolvedValue(
      plan({ status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    api.fetchApproval.mockResolvedValue(approval());
    api.resolveApproval.mockRejectedValue(
      new ApiRequestError("API error 500: leaky-marker stack", {
        kind: "http",
        method: "POST",
        path: "/x",
        status: 500,
      }),
    );

    const outcome = await approvePlanInPlace("p-1", "w-1");

    expect(outcome.kind).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("leaky-marker");
  });

  it("stops on a failed change with its summary", async () => {
    api.fetchChangePlan.mockResolvedValue(
      plan({ status: "failed", phase: "terminal", result: { summary: "Telegram refused the key." } }),
    );

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({ kind: "failed", message: "Telegram refused the key." });
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "rolled_back", "rollback_failed", "manual_required"] as const)(
    "stops on a %s change with the plan summary when it has no result",
    async (status) => {
      api.fetchChangePlan.mockResolvedValue(plan({ status, phase: "terminal", summary: "Nothing was changed." }));

      expect(await approvePlanInPlace("p-1", "w-1")).toEqual({ kind: "failed", message: "Nothing was changed." });
    },
  );

  it.each(["completed", "applied", "monitoring"] as const)("counts a %s change as done", async (status) => {
    const done = plan({ status, phase: "terminal" });
    api.fetchChangePlan.mockResolvedValue(done);

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({ kind: "completed", plan: done });
  });

  it("hands off actions the page can't do", async () => {
    const form = plan({
      status: "awaiting_input",
      phase: "input",
      requiredAction: { kind: "public_form", actionId: "act-f", actionNonce: "nonce-f", title: "Details", fields: [] },
    });
    api.fetchChangePlan.mockResolvedValue(form);

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({ kind: "elsewhere", plan: form });
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(api.respondToChangePlan).not.toHaveBeenCalled();
  });

  it("never confirms a rollback", async () => {
    const rollback = plan({ requiredAction: { ...confirmation, purpose: "rollback" } });
    api.fetchChangePlan.mockResolvedValue(rollback);

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({ kind: "elsewhere", plan: rollback });
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });

  it("hands off an approval that has no approval record yet", async () => {
    const withoutId: ChangePlanRequiredAction = {
      kind: "approval",
      actionId: "act-a",
      actionNonce: "nonce-a",
      title: "Approve",
      risk: "caution",
    };
    const waiting = plan({ status: "awaiting_approval", phase: "authorization", requiredAction: withoutId });
    api.fetchChangePlan.mockResolvedValue(waiting);

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({ kind: "elsewhere", plan: waiting });
    expect(api.fetchApproval).not.toHaveBeenCalled();
  });

  it.each(["rejected", "edited"] as const)("fails when the approval was turned down (%s)", async (status) => {
    api.fetchChangePlan.mockResolvedValue(
      plan({ status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    api.fetchApproval.mockResolvedValue(approval({ status }));

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({
      kind: "failed",
      message: "The approval was turned down.",
    });
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(api.respondToChangePlan).not.toHaveBeenCalled();
  });

  it("fails when the approval has expired", async () => {
    api.fetchChangePlan.mockResolvedValue(
      plan({ status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    // The gateway's own union has no "expired"; an expired approval reads as a rejection, but a future value is refused too.
    api.fetchApproval.mockResolvedValue({ ...approval(), status: "expired" });

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({
      kind: "failed",
      message: "The approval was turned down.",
    });
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("waits a second while the change is applying", async () => {
    vi.useFakeTimers();
    api.fetchChangePlan
      .mockResolvedValueOnce(plan({ status: "applying", phase: "mutation" }))
      .mockResolvedValueOnce(plan({ status: "verifying", phase: "validation" }))
      .mockResolvedValueOnce(plan({ status: "completed", phase: "terminal" }));

    const outcome = approvePlanInPlace("p-1", "w-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await outcome).toMatchObject({ kind: "completed" });
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(3);
  });

  it("gives up after 12 rounds without leaving a final wait", async () => {
    vi.useFakeTimers();
    api.fetchChangePlan.mockResolvedValue(plan({ status: "applying", phase: "mutation" }));

    const outcome = approvePlanInPlace("p-1", "w-1");
    await vi.advanceTimersByTimeAsync(11_000);

    expect(await outcome).toEqual({
      kind: "failed",
      message: "GoatCitadel is still turning this on. Check again in a moment.",
    });
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(12);
  });

  it("reports a failed read in plain words", async () => {
    api.fetchChangePlan.mockRejectedValue(httpError(404));

    expect(await approvePlanInPlace("p-1", "w-1")).toEqual({
      kind: "failed",
      message: "That item no longer exists. Refresh to see the latest.",
    });
  });
});

describe("ensureHostsAllowed", () => {
  const settings = (networkAllowlist: string[]) => ({ revision: 7, networkAllowlist });

  it("reads no settings when no host is needed", async () => {
    expect(await ensureHostsAllowed([], "w-1", [])).toEqual({ kind: "allowed" });
    expect(api.fetchSettings).not.toHaveBeenCalled();
  });

  it("allows hosts that are already listed, including by wildcard", async () => {
    api.fetchSettings.mockResolvedValue(settings(["api.telegram.org", "*.example.com"]));

    expect(await ensureHostsAllowed(["api.telegram.org", "bot.example.com"], "w-1", [])).toEqual({ kind: "allowed" });
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("adds only the missing hosts, once each, as a change that is never a Settings save", async () => {
    api.fetchSettings.mockResolvedValue(settings(["api.firecrawl.dev"]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(plan({ planId: "s-1", status: "completed", phase: "terminal" }));

    expect(
      await ensureHostsAllowed(["api.telegram.org", "api.firecrawl.dev", "api.telegram.org"], "w-1", [
        "api.telegram.org",
      ]),
    ).toEqual({ kind: "allowed" });
    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "w-1",
      surface: "settings",
      request: {
        kind: "runtime_configuration",
        change: { operation: "network_allowlist", entries: ["api.firecrawl.dev", "api.telegram.org"] },
      },
      idempotencyKey: "messaging-allow-hosts:api.telegram.org:7",
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("names several missing hosts in a sorted key and keeps the list's order", async () => {
    api.fetchSettings.mockResolvedValue(settings(["a.example.com"]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(plan({ planId: "s-1", status: "completed", phase: "terminal" }));

    await ensureHostsAllowed(["z.example.org", "api.telegram.org"], "w-1", ["z.example.org", "api.telegram.org"]);

    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        request: {
          kind: "runtime_configuration",
          change: { operation: "network_allowlist", entries: ["a.example.com", "z.example.org", "api.telegram.org"] },
        },
        idempotencyKey: "messaging-allow-hosts:api.telegram.org,z.example.org:7",
      }),
    );
  });

  it("confirms, approves and continues the host's own change in the caller's workspace, then allows it", async () => {
    const other = { workspaceId: "w-2" };
    const host = { planId: "s-1", kind: "runtime_configuration" as const };
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockResolvedValue(plan({ ...host, requiredAction: confirmation }));
    api.fetchChangePlan
      .mockResolvedValueOnce(plan({ ...host, revision: 1, requiredAction: confirmation }))
      .mockResolvedValueOnce(
        plan({
          ...host,
          revision: 3,
          status: "awaiting_approval",
          phase: "authorization",
          requiredAction: approvalAction,
        }),
      )
      .mockResolvedValueOnce(
        plan({
          ...host,
          revision: 3,
          status: "awaiting_approval",
          phase: "authorization",
          requiredAction: approvalAction,
        }),
      )
      .mockResolvedValueOnce(plan({ ...host, revision: 5, status: "completed", phase: "terminal" }));
    api.confirmChangePlan.mockResolvedValue(plan({ ...host, revision: 2 }));
    api.fetchApproval
      .mockResolvedValueOnce(approval({ payload: { planId: "s-1" }, status: "pending" }))
      .mockResolvedValueOnce(approval({ payload: { planId: "s-1" }, status: "approved" }));
    api.resolveApproval.mockResolvedValue({});
    api.respondToChangePlan.mockResolvedValue(plan({ ...host, revision: 4 }));

    // Completing the host's change is not the channel's change completing: the caller must carry on.
    expect(await ensureHostsAllowed(["api.telegram.org"], "w-2", ["api.telegram.org"])).toEqual({ kind: "allowed" });

    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "w-2" }));
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(4);
    for (const [id, context] of api.fetchChangePlan.mock.calls) expect([id, context]).toEqual(["s-1", other]);
    expect(api.confirmChangePlan).toHaveBeenCalledExactlyOnceWith("s-1", other, {
      expectedRevision: 1,
      actionNonce: "nonce-c",
    });
    expect(api.fetchApproval).toHaveBeenNthCalledWith(1, "ap-1", other);
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("ap-1", "approve");
    expect(api.respondToChangePlan).toHaveBeenCalledExactlyOnceWith("s-1", other, {
      expectedRevision: 3,
      actionId: "act-a",
      actionNonce: "nonce-a",
      values: {},
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("hands the host's change off when the page can't finish it", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(
      plan({ planId: "s-1", status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    api.fetchApproval.mockResolvedValue(approval({ payload: { planId: "s-1" } }));
    api.resolveApproval.mockRejectedValue(httpError(403));

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["api.telegram.org"])).toMatchObject({
      kind: "elsewhere",
      approvalId: "ap-1",
    });
  });

  it("fails when the host's change stops", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(
      plan({ planId: "s-1", status: "failed", phase: "terminal", result: { summary: "That host isn't allowed." } }),
    );

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["api.telegram.org"])).toEqual({
      kind: "failed",
      message: "That host isn't allowed.",
    });
  });

  it("reports a refused change in plain words", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockRejectedValue(httpError(409));

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["api.telegram.org"])).toEqual({
      kind: "failed",
      message: "This changed somewhere else. Refresh and try again.",
    });
    expect(api.fetchChangePlan).not.toHaveBeenCalled();
  });

  it("blocks a missing host the page never listed, and makes no change", async () => {
    api.fetchSettings.mockResolvedValue(settings(["a.example.com"]));

    expect(await ensureHostsAllowed(["api.telegram.org", "z.example.org"], "w-1", ["z.example.org"])).toEqual({
      kind: "blocked",
      reasons: [
        "GoatCitadel needs to reach api.telegram.org. Reload this page to see the change before turning it on.",
      ],
    });
    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", [])).toEqual({
      kind: "blocked",
      reasons: [
        "GoatCitadel needs to reach api.telegram.org. Reload this page to see the change before turning it on.",
      ],
    });
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("still adds a missing host the page listed", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(plan({ planId: "s-1", status: "completed", phase: "terminal" }));

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["API.Telegram.org"])).toEqual({ kind: "allowed" });
    expect(api.createChangePlan).toHaveBeenCalledOnce();
  });

  it("reports a failed settings read in plain words", async () => {
    api.fetchSettings.mockRejectedValue(httpError(500));

    expect(await ensureHostsAllowed(["api.telegram.org"], "w-1", ["api.telegram.org"])).toEqual({
      kind: "failed",
      message: "The gateway hit an error. Try again, or check System health.",
    });
  });
});
