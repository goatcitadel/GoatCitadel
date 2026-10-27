import type {
  ApprovalRequest,
  ChangePlanRecord,
  ChangePlanRequiredAction,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeCleanupAndTurnOn, turnOnChannelDraft } from "./turn-on-channel";

const api = vi.hoisted(() => ({
  fetchChangePlan: vi.fn(),
  fetchChangePlans: vi.fn(),
  createChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  respondToChangePlan: vi.fn(),
  resolveApproval: vi.fn(),
  fetchApproval: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  validateChannelSetupDraft: vi.fn(),
  testChannelSetupDraft: vi.fn(),
  acknowledgeChannelSetupTest: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlan: api.fetchChangePlan,
  fetchChangePlans: api.fetchChangePlans,
  createChangePlan: api.createChangePlan,
  confirmChangePlan: api.confirmChangePlan,
  respondToChangePlan: api.respondToChangePlan,
  resolveApproval: api.resolveApproval,
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChannelSetupDraft: api.fetchChannelSetupDraft,
  validateChannelSetupDraft: api.validateChannelSetupDraft,
  testChannelSetupDraft: api.testChannelSetupDraft,
  acknowledgeChannelSetupTest: api.acknowledgeChannelSetupTest,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));

const input = {
  workspaceId: "w-1",
  draftId: "d-1",
  catalogId: "channel.telegram",
  requiredHosts: ["api.telegram.org"],
};
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
    target: { ownerId: "channel_setup_draft", resourceId: "d-1", expectedRevision: 8 },
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

const validation = (overrides: Partial<ChannelSetupValidationResult> = {}): ChannelSetupValidationResult => ({
  draftId: "d-1",
  draftRevision: 6,
  status: "ok",
  levels: [],
  issues: [],
  checkedAt: "2026-10-26T10:00:00.000Z",
  ...overrides,
});

const tested = (overrides: Partial<ChannelSetupTestResult> = {}): ChannelSetupTestResult => ({
  draftId: "d-1",
  draftRevision: 8,
  status: "ok",
  levels: [],
  issues: [],
  checkedAt: "2026-10-26T10:00:00.000Z",
  evidenceId: "ev-1",
  finalizationEligibility: { allowed: true, blockingReasons: [], evidenceId: "ev-1" },
  ...overrides,
});

/** The open channel plan any run ends on: the first read is its confirmation, then it reads as done. */
function arrangeEndToEnd() {
  api.createChangePlan.mockResolvedValue(plan({ requiredAction: confirmation }));
  api.fetchChangePlan
    .mockResolvedValueOnce(plan({ revision: 1, requiredAction: confirmation }))
    .mockResolvedValueOnce(
      plan({ revision: 3, status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    )
    .mockResolvedValueOnce(
      plan({ revision: 3, status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    )
    .mockResolvedValue(plan({ revision: 5, status: "completed", phase: "terminal" }));
  api.confirmChangePlan.mockResolvedValue(plan({ revision: 2 }));
  api.fetchApproval
    .mockResolvedValueOnce(approval({ status: "pending" }))
    .mockResolvedValueOnce(approval({ status: "approved" }));
  api.resolveApproval.mockResolvedValue({});
  api.respondToChangePlan.mockResolvedValue(plan({ revision: 4, status: "applying" }));
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchChangePlans.mockResolvedValue({ items: [] });
  api.fetchSettings.mockResolvedValue({ revision: 2, networkAllowlist: ["api.telegram.org"] });
  api.fetchChannelSetupDraft.mockResolvedValue({ draftId: "d-1", revision: 5 });
  api.validateChannelSetupDraft.mockResolvedValue(validation());
  api.testChannelSetupDraft.mockResolvedValue(tested());
});

describe("turnOnChannelDraft", () => {
  it("resumes an open change for the same draft", async () => {
    api.fetchChangePlans.mockResolvedValue({
      items: [
        plan({ planId: "p-other-draft", target: { ownerId: "channel_setup_draft", resourceId: "d-2" } }),
        plan({ planId: "p-done", status: "completed", phase: "terminal" }),
        plan({ planId: "p-failed", status: "failed", phase: "terminal" }),
        plan({ planId: "p-open", requiredAction: confirmation }),
      ],
    });
    api.fetchChangePlan.mockResolvedValue(plan({ planId: "p-open", status: "completed", phase: "terminal" }));

    const outcome = await turnOnChannelDraft(input);

    expect(outcome).toMatchObject({ kind: "completed", plan: { planId: "p-open" } });
    expect(api.fetchChangePlans).toHaveBeenCalledExactlyOnceWith(ctx, { limit: 50 });
    expect(api.fetchChangePlan).toHaveBeenCalledWith("p-open", ctx);
    expect(api.fetchSettings).not.toHaveBeenCalled();
    expect(api.validateChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });

  it("does not resume a change that is not a channel change for this draft", async () => {
    api.fetchChangePlans.mockResolvedValue({
      items: [
        plan({ planId: "p-model", request: { kind: "session_model" } }),
        plan({ planId: "p-owner", target: { ownerId: "settings", resourceId: "d-1" } }),
      ],
    });
    arrangeEndToEnd();

    expect(await turnOnChannelDraft(input)).toMatchObject({ kind: "completed" });
    expect(api.createChangePlan).toHaveBeenCalledOnce();
  });

  it("sends an open change it didn't make to Inbox, without confirming or approving it", async () => {
    const origins: ChangePlanRecord["origin"][] = [
      { surface: "chat", workspaceId: "w-1" },
      { surface: "chat", workspaceId: "w-1", sessionId: "s-1" },
      { surface: "settings", workspaceId: "w-1", sessionId: "s-1" },
      { surface: "settings", workspaceId: "w-1", turnId: "t-1" },
      { surface: "system", workspaceId: "w-1" },
    ];
    for (const origin of origins) {
      for (const mock of Object.values(api)) mock.mockClear();
      const open = plan({ planId: "p-chat", origin, requiredAction: approvalAction });
      api.fetchChangePlans.mockResolvedValue({ items: [open] });

      const outcome = await turnOnChannelDraft(input);

      // Its review stays in Inbox, on the approval it waits for.
      expect(outcome).toEqual({ kind: "elsewhere", plan: open, inInbox: true, approvalId: "ap-1" });
      expect(api.fetchChangePlan).not.toHaveBeenCalled();
      expect(api.confirmChangePlan).not.toHaveBeenCalled();
      expect(api.fetchApproval).not.toHaveBeenCalled();
      expect(api.resolveApproval).not.toHaveBeenCalled();
      expect(api.respondToChangePlan).not.toHaveBeenCalled();
      expect(api.createChangePlan).not.toHaveBeenCalled();
      expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
    }
  });

  it("sends a change bound to a chat session to Inbox even on its compatibility field", async () => {
    const open = plan({ planId: "p-session", sessionId: "s-1", requiredAction: confirmation });
    api.fetchChangePlans.mockResolvedValue({ items: [open] });

    expect(await turnOnChannelDraft(input)).toEqual({ kind: "elsewhere", plan: open, inInbox: true });
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });

  it("runs in order: resume lookup, hosts, validate, test, create, approve in place", async () => {
    arrangeEndToEnd();

    expect(await turnOnChannelDraft(input)).toMatchObject({ kind: "completed" });

    const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0]!;
    expect(order(api.fetchChangePlans)).toBeLessThan(order(api.fetchSettings));
    expect(order(api.fetchSettings)).toBeLessThan(order(api.validateChannelSetupDraft));
    expect(order(api.validateChannelSetupDraft)).toBeLessThan(order(api.testChannelSetupDraft));
    expect(order(api.testChannelSetupDraft)).toBeLessThan(order(api.createChangePlan));
    expect(order(api.createChangePlan)).toBeLessThan(order(api.confirmChangePlan));
    expect(order(api.confirmChangePlan)).toBeLessThan(order(api.resolveApproval));
    expect(order(api.resolveApproval)).toBeLessThan(order(api.respondToChangePlan));
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("d-1");
    expect(api.validateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("d-1", 5);
    expect(api.testChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("d-1", 6);
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("ap-1", "approve");
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("adds a missing host first, as its own change in the caller's workspace", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 2, networkAllowlist: ["api.firecrawl.dev"] });
    api.createChangePlan.mockImplementation(async ({ request }: { request: { kind: string } }) =>
      request.kind === "runtime_configuration"
        ? plan({ planId: "s-1", kind: "runtime_configuration", requiredAction: confirmation })
        : plan({ requiredAction: confirmation }),
    );
    // The host's change (s-1) is confirmed, approved and continued; the channel's change (p-1) then reads as done.
    api.fetchChangePlan.mockImplementation(async (planId: string) => {
      if (planId !== "s-1") return plan({ planId, status: "completed", phase: "terminal" });
      const read = api.fetchChangePlan.mock.calls.filter(([id]) => id === planId).length;
      const host = { planId, kind: "runtime_configuration" as const };
      if (read === 1) return plan({ ...host, requiredAction: confirmation });
      if (read <= 3) {
        return plan({ ...host, status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction });
      }
      return plan({ ...host, status: "completed", phase: "terminal" });
    });
    api.confirmChangePlan.mockResolvedValue(plan({ planId: "s-1" }));
    api.fetchApproval.mockImplementation(async (approvalId: string) =>
      approval({
        approvalId,
        payload: { planId: "s-1" },
        status: api.resolveApproval.mock.calls.length ? "approved" : "pending",
      }),
    );
    api.resolveApproval.mockResolvedValue({});
    api.respondToChangePlan.mockResolvedValue(plan({ planId: "s-1" }));

    // Completing the host's change must not end Turn on: the channel's own change is the result.
    expect(await turnOnChannelDraft(input)).toMatchObject({ kind: "completed", plan: { planId: "p-1" } });

    expect(api.createChangePlan).toHaveBeenNthCalledWith(1, {
      workspaceId: "w-1",
      surface: "settings",
      request: {
        kind: "runtime_configuration",
        change: { operation: "network_allowlist", entries: ["api.firecrawl.dev", "api.telegram.org"] },
      },
      idempotencyKey: "messaging-allow-hosts:api.telegram.org:2",
    });
    expect(api.createChangePlan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: "messaging-turn-on:d-1:8" }),
    );
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(api.fetchChangePlan).toHaveBeenCalledWith("s-1", ctx);
    expect(api.confirmChangePlan).toHaveBeenCalledExactlyOnceWith("s-1", ctx, {
      expectedRevision: 1,
      actionNonce: "nonce-c",
    });
    expect(api.fetchApproval).toHaveBeenCalledWith("ap-1", ctx);
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("ap-1", "approve");
    expect(api.respondToChangePlan).toHaveBeenCalledExactlyOnceWith("s-1", ctx, {
      expectedRevision: 1,
      actionId: "act-a",
      actionNonce: "nonce-a",
      values: {},
    });
    expect(api.resolveApproval.mock.invocationCallOrder[0]).toBeLessThan(
      api.validateChannelSetupDraft.mock.invocationCallOrder[0]!,
    );
  });

  it("stops when a host's change must be finished elsewhere", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 2, networkAllowlist: [] });
    api.createChangePlan.mockResolvedValue(plan({ planId: "s-1", kind: "runtime_configuration" }));
    api.fetchChangePlan.mockResolvedValue(
      plan({ planId: "s-1", status: "awaiting_approval", phase: "authorization", requiredAction: approvalAction }),
    );
    api.fetchApproval.mockResolvedValue(approval({ payload: { planId: "s-1" } }));
    api.resolveApproval.mockRejectedValue(
      new ApiRequestError("API error 403", { kind: "http", method: "POST", path: "/x", status: 403 }),
    );

    expect(await turnOnChannelDraft(input)).toMatchObject({ kind: "elsewhere", approvalId: "ap-1" });
    expect(api.createChangePlan).toHaveBeenCalledOnce();
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(api.validateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("stops with the issue messages when the setup doesn't validate", async () => {
    api.validateChannelSetupDraft.mockResolvedValue(
      validation({
        status: "error",
        issues: [
          { key: "botToken", level: "error", message: "The bot key is missing." },
          { key: "note", level: "info", message: "Telegram is quick to set up." },
          { key: "target", level: "warn", message: "No chat is chosen yet." },
        ],
      }),
    );

    expect(await turnOnChannelDraft(input)).toEqual({
      kind: "blocked",
      reasons: ["The bot key is missing.", "No chat is chosen yet."],
    });
    expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });

  it.each(["error", "idle"] as const)(
    "blocks with a plain reason when validation is %s without a message",
    async (status) => {
      api.validateChannelSetupDraft.mockResolvedValue(validation({ status, issues: [] }));

      const outcome = await turnOnChannelDraft(input);

      expect(outcome).toMatchObject({ kind: "blocked" });
      expect(outcome.kind === "blocked" && outcome.reasons).toHaveLength(1);
      expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
      expect(api.createChangePlan).not.toHaveBeenCalled();
    },
  );

  it("blocks when validation is idle, with its messages", async () => {
    api.validateChannelSetupDraft.mockResolvedValue(
      validation({ status: "idle", issues: [{ key: "draft", level: "warn", message: "Nothing is set up yet." }] }),
    );

    expect(await turnOnChannelDraft(input)).toEqual({ kind: "blocked", reasons: ["Nothing is set up yet."] });
    expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("goes on to the test and the change when validation only warns", async () => {
    arrangeEndToEnd();
    api.validateChannelSetupDraft.mockResolvedValue(
      validation({ status: "warn", issues: [{ key: "target", level: "warn", message: "No chat is chosen yet." }] }),
    );

    expect(await turnOnChannelDraft(input)).toMatchObject({ kind: "completed" });

    // The test's own eligibility is the gate, so the warning doesn't stop either call.
    expect(api.testChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("d-1", 6);
    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ idempotencyKey: "messaging-turn-on:d-1:8" }),
    );
  });

  it("stops for the test message it couldn't remove", async () => {
    api.testChannelSetupDraft.mockResolvedValue(
      tested({
        evidenceId: "ev-top",
        finalizationEligibility: {
          allowed: false,
          blockingReasons: ["The test message was sent, but it couldn't be removed."],
          requiresAcknowledgement: true,
          evidenceId: "ev-9",
        },
      }),
    );

    expect(await turnOnChannelDraft(input)).toEqual({ kind: "needs_cleanup_ack", evidenceId: "ev-9" });
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });

  it("uses the test's own record when the eligibility names none", async () => {
    api.testChannelSetupDraft.mockResolvedValue(
      tested({
        evidenceId: "ev-top",
        finalizationEligibility: { allowed: false, blockingReasons: [], requiresAcknowledgement: true },
      }),
    );

    expect(await turnOnChannelDraft(input)).toEqual({ kind: "needs_cleanup_ack", evidenceId: "ev-top" });
  });

  it("stops with the reasons when the test doesn't allow turning on", async () => {
    api.testChannelSetupDraft.mockResolvedValue(
      tested({
        status: "error",
        finalizationEligibility: { allowed: false, blockingReasons: ["Telegram refused the bot key."] },
      }),
    );

    expect(await turnOnChannelDraft(input)).toEqual({ kind: "blocked", reasons: ["Telegram refused the bot key."] });
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });

  it("treats a test with no eligibility as not allowed", async () => {
    api.testChannelSetupDraft.mockResolvedValue(tested({ finalizationEligibility: undefined }));

    expect(await turnOnChannelDraft(input)).toMatchObject({ kind: "blocked" });
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });

  it("binds the change to the tested draft version", async () => {
    arrangeEndToEnd();
    api.testChannelSetupDraft.mockResolvedValue(tested({ draftRevision: 9 }));

    await turnOnChannelDraft({ ...input, draftId: "d-1" });

    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "w-1",
      surface: "settings",
      request: { kind: "channel_connection", channelKind: "channel.telegram", draftId: "d-1" },
      idempotencyKey: "messaging-turn-on:d-1:9",
    });
  });

  it("reports a failed step in plain words", async () => {
    api.testChannelSetupDraft.mockRejectedValue(
      new ApiRequestError("API error 409: {}", { kind: "http", method: "POST", path: "/x", status: 409 }),
    );

    expect(await turnOnChannelDraft(input)).toEqual({
      kind: "failed",
      message: "This changed somewhere else. Refresh and try again.",
    });
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });
});

describe("acknowledgeCleanupAndTurnOn", () => {
  const ackInput = { workspaceId: "w-1", draftId: "d-1", catalogId: "channel.telegram", evidenceId: "ev-9" };

  it("acknowledging continues without testing again", async () => {
    arrangeEndToEnd();
    api.fetchChannelSetupDraft.mockResolvedValue({ draftId: "d-1", revision: 8 });
    api.acknowledgeChannelSetupTest.mockResolvedValue(
      tested({
        draftRevision: 8,
        evidenceId: "ev-10",
        finalizationEligibility: { allowed: true, blockingReasons: [] },
      }),
    );

    expect(await acknowledgeCleanupAndTurnOn(ackInput)).toMatchObject({ kind: "completed" });

    expect(api.acknowledgeChannelSetupTest).toHaveBeenCalledExactlyOnceWith("d-1", {
      expectedRevision: 8,
      evidenceId: "ev-9",
      acknowledgement: "cleanup",
    });
    expect(api.validateChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.fetchChangePlans).not.toHaveBeenCalled();
    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "w-1",
      surface: "settings",
      request: { kind: "channel_connection", channelKind: "channel.telegram", draftId: "d-1" },
      idempotencyKey: "messaging-turn-on:d-1:8",
    });
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("ap-1", "approve");
  });

  it("stops when the acknowledgement still doesn't allow turning on", async () => {
    api.acknowledgeChannelSetupTest.mockResolvedValue(
      tested({ finalizationEligibility: { allowed: false, blockingReasons: ["Run the test again."] } }),
    );

    expect(await acknowledgeCleanupAndTurnOn(ackInput)).toEqual({ kind: "blocked", reasons: ["Run the test again."] });
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });

  it("reports a refused acknowledgement in plain words", async () => {
    api.acknowledgeChannelSetupTest.mockRejectedValue(
      new ApiRequestError("API error 409: {}", { kind: "http", method: "POST", path: "/x", status: 409 }),
    );

    expect(await acknowledgeCleanupAndTurnOn(ackInput)).toEqual({
      kind: "failed",
      message: "This changed somewhere else. Refresh and try again.",
    });
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });
});
