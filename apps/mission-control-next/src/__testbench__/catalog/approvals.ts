import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/approvals";
import { approveChatTool, denyChatTool, fetchChatPendingApprovals } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchDurableRun } from "@goatcitadel/mission-control-shared/api/durable";
import { ensure, pass, waitFor } from "../runner/assert";
import type { CheckContext, CheckDef, RouteKey } from "../runner/types";
import { createScratchSession, requireWorkspace } from "./context";
import { seedChatApprovalScenario, type ChatApprovalScenario } from "./dev-verification";

const SEED_ROUTES: readonly RouteKey[] = [
  "POST /api/v1/chat/sessions",
  "POST /api/v1/dev/verification/chat-approval-scenario",
  "GET /api/v1/chat/tools/approvals",
  "GET /api/v1/approvals",
];

const SEED_STEPS = ["Create session", "Seed approval scenario", "Approval is pending"] as const;

async function seedPendingApproval(ctx: CheckContext): Promise<ChatApprovalScenario> {
  const session = await ctx.step("Create session", () => createScratchSession(ctx, "approval"));
  const scenario = await ctx.step("Seed approval scenario", () =>
    seedChatApprovalScenario({ sessionId: session.sessionId, workspaceId: requireWorkspace(ctx) }, ctx.signal),
  );
  await ctx.step("Approval is pending", async () => {
    const pending = await fetchChatPendingApprovals(session.sessionId);
    ensure(
      pending.items.some((item) => item.approvalId === scenario.approvalId),
      "The seeded approval is not pending for the session.",
      pending,
    );
  });
  return scenario;
}

function waitForApprovalStatus(ctx: CheckContext, approvalId: string, status: "approved" | "rejected") {
  return waitFor(
    async () => (await fetchApprovals({ status, limit: 200 })).items.find((item) => item.approvalId === approvalId),
    (found) => found !== undefined,
    { signal: ctx.signal, timeoutMs: 15_000, label: `Recording the approval as ${status}` },
  );
}

export const approvalChecks: readonly CheckDef[] = [
  {
    id: "approvals.reject",
    kind: "journey",
    domain: "approvals",
    title: "Reject a pending tool approval",
    tier: "mutate",
    needsWorkspace: true,
    routes: [...SEED_ROUTES, "POST /api/v1/chat/tools/deny"],
    steps: [...SEED_STEPS, "Reject the approval", "Approval recorded as rejected"],
    async run(ctx) {
      const scenario = await seedPendingApproval(ctx);
      const denied = await ctx.step("Reject the approval", () => denyChatTool(scenario.sessionId, scenario.approvalId));
      ensure(denied.ok, "The gateway did not accept the rejection.", denied);
      const approval = await ctx.step("Approval recorded as rejected", () =>
        waitForApprovalStatus(ctx, scenario.approvalId, "rejected"),
      );
      return pass("The approval was rejected and recorded.", approval);
    },
  },
  {
    id: "approvals.approve",
    kind: "journey",
    domain: "approvals",
    title: "Approve a pending tool approval and resume the turn",
    tier: "host",
    needsWorkspace: true,
    timeoutMs: 120_000,
    description:
      "Approving the seeded shell.exec approval lets the turn resume, which may run its `pnpm test` command on this machine.",
    routes: [...SEED_ROUTES, "POST /api/v1/chat/tools/approve", "GET /api/v1/durable/runs/:runId"],
    steps: [...SEED_STEPS, "Approve the approval", "Durable run leaves waiting", "Approval recorded as approved"],
    async run(ctx) {
      const scenario = await seedPendingApproval(ctx);
      const approved = await ctx.step("Approve the approval", () =>
        approveChatTool(scenario.sessionId, scenario.approvalId),
      );
      ensure(approved.ok, "The gateway did not accept the approval.", approved);
      const run = await ctx.step("Durable run leaves waiting", () =>
        waitFor(
          () => fetchDurableRun(scenario.chatTurnDurableRunId),
          (current) => current.status !== "waiting",
          { signal: ctx.signal, timeoutMs: 30_000, label: "The durable run waking" },
        ),
      );
      const approval = await ctx.step("Approval recorded as approved", () =>
        waitForApprovalStatus(ctx, scenario.approvalId, "approved"),
      );
      return pass(`Approved; the durable run is now ${run.status}.`, { approval, run });
    },
  },
];
