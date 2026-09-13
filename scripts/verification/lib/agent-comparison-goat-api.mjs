import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { createGoatComparisonClient } from "./agent-comparison-goat-client.mjs";

// HTTP only: keep admission, idempotency, Chat routing, and durable execution in
// the product. Headless runs retain pending approvals. Supervised runs forward
// only an explicit console decision and wait for the native durable owner.
export async function executeGoatComparisonTurn({
  baseUrl,
  token,
  workspace,
  prompt,
  profile,
  retain,
  signal,
  fetchImpl = fetch,
  onApprovalReady,
  pollMs = 1000,
  nativeScope,
}) {
  const supervision = new AbortController();
  const activeSignal = AbortSignal.any([supervision.signal, ...(signal ? [signal] : [])]);
  const api = createGoatComparisonClient({ baseUrl, token, retain, signal: activeSignal, fetchImpl });
  if (!path.isAbsolute(workspace ?? "") || !path.basename(workspace))
    throw new Error("The native comparison workspace must be an absolute non-root directory.");
  if (onApprovalReady !== undefined && typeof onApprovalReady !== "function")
    throw new Error("The native approval console must be explicitly attached.");
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 10_000)
    throw new Error("Use a bounded native status polling interval.");
  if (
    nativeScope &&
    (Object.keys(nativeScope).some((key) => !["workspaceId", "projectId", "sessionId"].includes(key)) ||
      !identifier(nativeScope.workspaceId) ||
      !identifier(nativeScope.projectId) ||
      (nativeScope.sessionId !== undefined && !identifier(nativeScope.sessionId)))
  )
    throw new Error("Use the exact native workflow scope.");
  const scope = nativeScope ?? (await api("workspace", "/workspaces", { name: "Comparison", slug: "comparison" }));
  const workspaceId = identifier(scope.workspaceId);
  let project;
  if (nativeScope) {
    const projects = await api("projects", `/chat/projects?workspaceId=${workspaceId}&view=all&limit=1000`);
    project = projects.items?.find((entry) => entry.projectId === nativeScope.projectId);
    if (
      !Array.isArray(projects.items) ||
      projects.items.length >= 1000 ||
      project?.workspaceId !== workspaceId ||
      project.workspacePath !== "."
    )
      throw new Error("The native workflow project changed workspace or path.");
  } else
    project = await api("project", "/chat/projects", {
      workspaceId,
      name: "Comparison fixture",
      // Keep the Gateway workspace and its fallback probe directory inside the
      // same jail. This project selects the configured workspace root itself.
      workspacePath: ".",
    });
  let session;
  if (nativeScope?.sessionId) {
    const sessions = await api("sessions", `/chat/sessions?workspaceId=${workspaceId}&limit=200`);
    session = sessions.items?.find((entry) => entry.sessionId === nativeScope.sessionId);
    if (
      !Array.isArray(sessions.items) ||
      sessions.nextCursor ||
      session?.workspaceId !== workspaceId ||
      session.projectId !== project.projectId
    )
      throw new Error("The native workflow session changed workspace or project.");
  } else
    session = await api("session", "/chat/sessions", {
      workspaceId,
      projectId: identifier(project.projectId),
      title: "Comparison task",
      mode: "chat",
    });
  const sessionId = identifier(session.sessionId);
  const input = {
    content: prompt,
    providerId: "comparison",
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
    webMode: "off",
    memoryMode: "off",
    useMemory: false,
    subagentPolicy: "off",
  };
  const preflight = await api("route-preflight", `/chat/sessions/${sessionId}/route-preflight`, {
    action: "send",
    ...input,
  });
  if (preflight.decision?.effectiveProviderId !== "comparison" || preflight.decision.effectiveModel !== profile.model)
    throw new Error("The Gateway selected a different provider/model than the reviewed profile.");
  const result = await api("agent-send", `/chat/sessions/${sessionId}/agent-send`, {
    ...input,
    routeDecision: preflight.decision,
  });
  let thread = await api("thread", `/chat/sessions/${sessionId}/thread`);
  if (onApprovalReady) {
    const turnId = identifier(result.turnId ?? result.trace?.turnId);
    const findTurn = () => {
      if (thread.sessionId !== sessionId) throw new Error("The native thread changed session scope.");
      const turn = thread.turns?.find((entry) => entry.turnId === turnId);
      if (!turn || turn.trace?.sessionId !== sessionId || turn.trace.turnId !== turnId)
        throw new Error("The native turn is missing or changed scope.");
      return turn;
    };
    const runId = identifier(findTurn().trace.durable?.runId);
    let sequence = 0;
    const name = (prefix) => `${prefix}-${String(++sequence).padStart(4, "0")}`;
    const scoped = (approval) =>
      approval?.linkage?.sessionId === sessionId &&
      approval.linkage.turnId === turnId &&
      approval.linkage.workspaceId === workspaceId &&
      approval.linkage.runId === runId;
    const pending = async () => {
      const page = await api(
        name("approvals"),
        `/approvals?status=pending&limit=200&workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      if (!Array.isArray(page.items) || page.nextCursor)
        throw new Error("The native approval inventory is incomplete.");
      return {
        approvals: page.items
          .filter((approval) => approval.status === "pending" && scoped(approval))
          .map((approval) => ({
            id: approval.approvalId,
            kind: approval.kind,
            summary: approval.shellExplanations?.[0]?.command ?? approval.kind,
            request: approval,
          })),
      };
    };
    let console;
    try {
      console = await onApprovalReady({
        workspace,
        signal: activeSignal,
        onClosed: () => supervision.abort(),
        pending,
        resolve: async ({ approvalId, decision }) => {
          if (
            !["allow-once", "deny"].includes(decision) ||
            typeof approvalId !== "string" ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(approvalId)
          )
            throw new Error("Choose one exact native approval and allow-once or deny.");
          const replay = await api(name("approval-replay"), `/approvals/${approvalId}/replay`);
          if (
            replay.approval?.approvalId !== approvalId ||
            replay.approval.status !== "pending" ||
            !scoped(replay.approval) ||
            !replay.durableRunId ||
            replay.durableRunId !== replay.approval.linkage.durableRunId ||
            replay.durableRunId === runId
          )
            throw new Error("The approval is no longer pending for this exact durable Chat turn.");
          // The approval owns a separate wait workflow. The Chat workflow must
          // still be waiting for that exact approval before a decision is sent.
          const waitRunId = identifier(replay.durableRunId);
          const waitRun = await api(name("durable"), `/durable/runs/${waitRunId}`);
          const chatRun = await api(name("durable"), `/durable/runs/${runId}`);
          const awaitsApproval = (run) =>
            run.status === "waiting" &&
            run.metadata?.waitForEvent?.eventKey === "approval.resolved" &&
            run.metadata.waitForEvent.correlationId === approvalId;
          if (
            waitRun.runId !== waitRunId ||
            waitRun.workflowKey !== "approval.wait" ||
            waitRun.payload?.approvalId !== approvalId ||
            waitRun.metadata?.approvalId !== approvalId ||
            !awaitsApproval(waitRun) ||
            chatRun.runId !== runId ||
            chatRun.workflowKey !== "chat.turn.execute" ||
            chatRun.payload?.workspaceId !== workspaceId ||
            chatRun.payload.sessionId !== sessionId ||
            chatRun.payload.turnId !== turnId ||
            !awaitsApproval(chatRun)
          )
            throw new Error("The approval owners are no longer waiting for this exact durable Chat turn.");
          const action = `approval-${randomUUID()}`;
          const nativeDecision = decision === "allow-once" ? "approve" : "reject";
          await retain(`${action}-intent`, {
            sessionId,
            turnId,
            runId,
            waitRunId,
            approval: replay.approval,
            source: "operator_console",
            decision: nativeDecision,
            requestedAt: new Date().toISOString(),
          });
          try {
            return await api(`${action}-result`, `/approvals/${approvalId}/resolve`, { decision: nativeDecision });
          } catch (error) {
            await retain(`${action}-unconfirmed`, {
              sessionId,
              turnId,
              runId,
              approvalId,
              decision: nativeDecision,
              status: "unconfirmed",
              error: error.message.replaceAll(token, "[Gateway token]"),
            });
            throw error;
          }
        },
      });
      if (typeof console?.stop !== "function") throw new Error("The native approval console needs a close handle.");
      const terminal = (status) => ["completed", "failed", "cancelled", "dead_lettered"].includes(status);
      for (;;) {
        const turn = findTurn();
        if (turn.trace.durable?.runId !== runId) throw new Error("The native turn changed durable owners.");
        const durable = await api(name("durable"), `/durable/runs/${runId}`);
        if (durable.runId !== runId) throw new Error("The native durable owner changed identity.");
        if (["completed", "partial", "failed", "cancelled"].includes(turn.trace.status) && terminal(durable.status)) {
          const pendingEffects = durable.metadata?.generalChatPostCommitPending;
          const postCommit = durable.metadata?.generalChatPostCommit;
          let settled = !pendingEffects || postCommit?.parentLocalEffectsStatus === "settled";
          const children = new Set([
            ...Object.values(pendingEffects?.durableEffectRunIds ?? {}),
            ...Object.values(postCommit?.durableEffectRunIds ?? {}),
          ]);
          if (children.size > 20) throw new Error("The native post-turn inventory exceeds the comparison bound.");
          for (const childId of children) {
            const child = await api(name("durable"), `/durable/runs/${identifier(childId)}`);
            if (
              child.runId !== childId ||
              child.workflowKey !== "chat.post_commit.effect" ||
              child.payload?.parentRunId !== runId ||
              child.payload.input?.workspaceId !== workspaceId ||
              child.payload.input.sessionId !== sessionId ||
              child.payload.input.turnId !== turnId
            )
              throw new Error("The native post-turn child changed scope.");
            settled = terminal(child.status) && settled;
          }
          if (settled) break;
        }
        await delay(pollMs, undefined, { signal: activeSignal });
        thread = await api(name("thread"), `/chat/sessions/${sessionId}/thread`);
      }
      await retain("thread-final", { status: 200, body: thread });
    } finally {
      supervision.abort();
      await console?.stop();
    }
  }
  // A full retained thread supports the independent verifier; status alone is
  // deliberately not converted into a task success grade.
  return { workspaceId, projectId: project.projectId, sessionId, result, thread, taskOutcome: "unverified" };
}

function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(value))
    throw new Error("The Gateway did not return a canonical identifier.");
  return value;
}
