import { ConflictError, type ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  cleanupRecoveredBackgroundProcess,
  forgetBrowserSessionState,
  killTurnBackgroundProcesses,
  readBackgroundProcessIdentity,
  type RecoveredProcessCleanupOutcome,
} from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";

type CleanupOwner = { stepId: string; childSessionId: string; childTurnId: string };
type CleanupStorage = Pick<AsyncStorage, "chatDelegationSteps" | "chatToolRuns" | "runImmediateTransaction">;
/** Live settlement shares the existing owners; volatile state must be released
 * even if retaining a process cleanup receipt subsequently fails. */
export async function cleanupDelegatedChildResources(
  storage: CleanupStorage,
  owner: CleanupOwner,
  resources = {
    forgetBrowserState: forgetBrowserSessionState,
    terminateLiveProcesses: killTurnBackgroundProcesses,
    cleanupRetainedProcesses: cleanupDelegatedChildProcesses,
  },
  closeRetainedMcpSessions?: (owner: { sessionId: string; turnId: string }) => number,
) {
  const step = await storage.chatDelegationSteps.get(owner.stepId);
  if (
    step.childSessionId !== owner.childSessionId ||
    step.childTurnId !== owner.childTurnId ||
    !["completed", "failed", "cancelled"].includes(step.status)
  ) {
    throw new ConflictError({ message: "Child resource cleanup requires the exact settled delegation step." });
  }
  const browserStateRemoved = resources.forgetBrowserState(owner.childSessionId);
  const mcpCloseRequested =
    closeRetainedMcpSessions?.({ sessionId: owner.childSessionId, turnId: owner.childTurnId }) ?? 0;
  const terminationRequested = resources.terminateLiveProcesses({
    sessionId: owner.childSessionId,
    turnId: owner.childTurnId,
  });
  const retainedProcesses = await resources.cleanupRetainedProcesses(storage, owner);
  return { browserStateRemoved, mcpCloseRequested, terminationRequested, retainedProcesses };
}

export async function cleanupDelegatedChildProcesses(
  storage: CleanupStorage,
  owner: CleanupOwner,
  cleanup = cleanupRecoveredBackgroundProcess,
  options?: { toolRunId: string },
): Promise<{ tracked: number; terminated: number; alreadyAbsent: number; unconfirmed: number }> {
  const step = await storage.chatDelegationSteps.get(owner.stepId);
  if (
    step.childSessionId !== owner.childSessionId ||
    step.childTurnId !== owner.childTurnId ||
    !["completed", "failed", "cancelled"].includes(step.status)
  ) {
    throw new ConflictError({ message: "Child process cleanup requires the exact settled delegation step." });
  }
  const exactOwner = { sessionId: owner.childSessionId, turnId: owner.childTurnId };
  const summary = { tracked: 0, terminated: 0, alreadyAbsent: 0, unconfirmed: 0 };
  const tools = options
    ? [await storage.chatToolRuns.get(options.toolRunId)]
    : await storage.chatToolRuns.listByTurn(owner.childTurnId);
  for (const tool of tools) {
    if (
      tool.sessionId !== owner.childSessionId ||
      tool.turnId !== owner.childTurnId ||
      tool.toolName !== "shell.exec_background" ||
      tool.status !== "executed" ||
      tool.reused ||
      !tool.result
    )
      continue;
    const result = tool.result;
    const prior = readRetainedCleanup(result, owner.stepId);
    if (prior === "terminated") {
      summary.tracked += 1;
      summary.terminated += 1;
      continue;
    }
    if (prior === "missing") {
      summary.tracked += 1;
      summary.alreadyAbsent += 1;
      continue;
    }
    const identity = readBackgroundProcessIdentity(result.processIdentity, exactOwner);
    const outcome = await storage.runImmediateTransaction(async () => {
      // Hold the exact step and receipt locks through the bounded native call.
      await assertCurrentCleanupOwner(storage, owner, tool.toolRunId, result);
      const settled = identity ? await cleanup(identity, exactOwner) : "unavailable";
      if (identity) await assertCurrentCleanupOwner(storage, owner, tool.toolRunId, result);
      const next = {
        ...result,
        backgroundProcessCleanup: {
          version: "background-process.cleanup.v1",
          stepId: owner.stepId,
          outcome: settled,
          scope: "recorded_process_only",
          descendants: "unconfirmed",
        },
      };
      if (!(await storage.chatToolRuns.compareAndSwapResult(tool.toolRunId, result, next))) {
        throw new ConflictError({ message: "Delegated child cleanup receipt changed before acknowledgement." });
      }
      return settled;
    });
    if (identity) summary.tracked += 1;
    if (outcome === "terminated") summary.terminated += 1;
    else if (outcome === "missing") summary.alreadyAbsent += 1;
    else summary.unconfirmed += 1;
  }
  return summary;
}

async function assertCurrentCleanupOwner(
  storage: CleanupStorage,
  owner: CleanupOwner,
  toolRunId: string,
  expected: NonNullable<ChatToolRunRecord["result"]>,
): Promise<void> {
  const step = await storage.chatDelegationSteps.getForUpdate(owner.stepId);
  const current = await storage.chatToolRuns.getForUpdate(toolRunId);
  if (
    step.childSessionId !== owner.childSessionId ||
    step.childTurnId !== owner.childTurnId ||
    !["completed", "failed", "cancelled"].includes(step.status) ||
    current.sessionId !== owner.childSessionId ||
    current.turnId !== owner.childTurnId ||
    current.toolName !== "shell.exec_background" ||
    current.status !== "executed" ||
    current.reused ||
    JSON.stringify(current.result) !== JSON.stringify(expected)
  ) {
    throw new ConflictError({ message: "Delegated child cleanup owner or process receipt changed." });
  }
}

const CLEANUP_SCAN_CURSOR = "delegated_child_process_cleanup_cursor_v1";
type CleanupScanCursor = {
  version: 1;
  afterStepId: string;
  currentStepId?: string;
  afterTool?: { startedAt: string; toolRunId: string };
};

/** Discovery progress only: exact step/tool records remain the sole authority.
 * Each maintenance call pages at most 32 step + 32 tool rows and attempts at most
 * one retained process. A crash before ACK replays safely through creation identity. */
export async function reconcileDelegatedChildProcessCleanup(
  storage: CleanupStorage & Pick<AsyncStorage, "systemSettings">,
  cleanup = cleanupRecoveredBackgroundProcess,
): Promise<{ attempted: number; failed: number; malformedSteps?: number }> {
  const previous = await storage.systemSettings.get<CleanupScanCursor>(CLEANUP_SCAN_CURSOR);
  const value = previous?.value;
  const cursor: CleanupScanCursor =
    value?.version === 1 &&
    typeof value.afterStepId === "string" &&
    value.afterStepId.length <= 512 &&
    (value.currentStepId === undefined ||
      (typeof value.currentStepId === "string" && value.currentStepId.length <= 512)) &&
    (value.afterTool === undefined ||
      (value.afterTool !== null &&
        typeof value.afterTool === "object" &&
        typeof value.afterTool.startedAt === "string" &&
        value.afterTool.startedAt.length <= 128 &&
        typeof value.afterTool.toolRunId === "string" &&
        value.afterTool.toolRunId.length <= 512))
      ? value
      : { version: 1, afterStepId: "" };
  let step;
  let malformedSteps = 0;
  if (cursor.currentStepId) {
    try {
      step = await storage.chatDelegationSteps.get(cursor.currentStepId);
    } catch {
      await storage.systemSettings.compareAndSet(CLEANUP_SCAN_CURSOR, previous, {
        version: 1,
        afterStepId: cursor.currentStepId,
      });
      return { attempted: 0, failed: 1 };
    }
  } else {
    const page = await storage.chatDelegationSteps.listResourceCleanupPage(cursor.afterStepId, 32);
    malformedSteps = page.malformedCount;
    step = page.items.find(
      (candidate) =>
        ["completed", "failed", "cancelled"].includes(candidate.status) &&
        candidate.childSessionId &&
        candidate.childTurnId,
    );
    if (!step) {
      await storage.systemSettings.compareAndSet(CLEANUP_SCAN_CURSOR, previous, {
        version: 1,
        afterStepId: page.nextAfterStepId ?? "",
      });
      return { attempted: 0, failed: 0, ...(malformedSteps ? { malformedSteps } : {}) };
    }
  }
  if (!step.childSessionId || !step.childTurnId || !["completed", "failed", "cancelled"].includes(step.status)) {
    await storage.systemSettings.compareAndSet(CLEANUP_SCAN_CURSOR, previous, { version: 1, afterStepId: step.stepId });
    return { attempted: 0, failed: 0 };
  }
  const owner = { stepId: step.stepId, childSessionId: step.childSessionId, childTurnId: step.childTurnId };
  const page = await storage.chatToolRuns.listByTurnPageWithCursor(owner.childTurnId, cursor.afterTool, 32);
  const candidate = page.items.find(
    (tool) =>
      tool.sessionId === owner.childSessionId &&
      tool.toolName === "shell.exec_background" &&
      tool.status === "executed" &&
      !tool.reused &&
      tool.result &&
      !readRetainedCleanup(tool.result, owner.stepId),
  );
  const last = candidate ?? page.nextAfter;
  const next: CleanupScanCursor = last
    ? {
        version: 1,
        afterStepId: step.stepId,
        currentStepId: step.stepId,
        afterTool: { startedAt: last.startedAt, toolRunId: last.toolRunId },
      }
    : { version: 1, afterStepId: step.stepId };
  // Persist the pre-action position first. If the process exits now, this exact
  // candidate remains discoverable without relying on watcher projection ACKs.
  const claimed = await storage.systemSettings.compareAndSet(CLEANUP_SCAN_CURSOR, previous, {
    version: 1,
    afterStepId: step.stepId,
    currentStepId: step.stepId,
    ...(cursor.afterTool ? { afterTool: cursor.afterTool } : {}),
  } satisfies CleanupScanCursor);
  if (!claimed) return { attempted: 0, failed: 0 };
  let failed = 0;
  try {
    if (candidate) await cleanupDelegatedChildProcesses(storage, owner, cleanup, { toolRunId: candidate.toolRunId });
  } catch {
    // Keep other tools/steps moving; an unacknowledged receipt is retried after
    // the bounded cursor wraps. The native helper itself never falls back to PID.
    failed = 1;
  } finally {
    await storage.systemSettings.compareAndSet(CLEANUP_SCAN_CURSOR, claimed, next);
  }
  return { attempted: candidate ? 1 : 0, failed, ...(malformedSteps ? { malformedSteps } : {}) };
}

function readRetainedCleanup(
  result: NonNullable<ChatToolRunRecord["result"]>,
  stepId: string,
): RecoveredProcessCleanupOutcome | undefined {
  const value = result.backgroundProcessCleanup;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.version === "background-process.cleanup.v1" &&
    record.stepId === stepId &&
    (record.outcome === "terminated" || record.outcome === "missing")
    ? record.outcome
    : undefined;
}
