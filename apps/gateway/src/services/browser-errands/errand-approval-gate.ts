import { ConflictError } from "@goatcitadel/contracts";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ApprovalResolveInput,
  ChatAttachmentRecord,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { ErrandBrowser, ErrandOverlayPoint, ErrandTargetInfo } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ApprovalCreateCommitHook } from "../approval-lifecycle-service.js";
import { withCanonicalApprovalOutcome } from "../approval-canonical-outcome.js";
import { ERRAND_APPROVAL_TTL_MS } from "./errand-constants.js";
import type { ErrandApprovalInput, ErrandLoopDeps } from "./errand-loop.js";

export const ERRAND_APPROVAL_KIND = "browser.errand.action";
export const ERRAND_TOOL_NAME = "browser.errand";
export const ERRAND_WINDOW_ACTOR_ID = "operator:errand-window";
export const ERRAND_STOPPED_ACTOR_ID = "system:errand-stopped";
export const ERRAND_PAGE_CHANGED_TITLE = "The page changed. Approve again?";
/** How often the gate re-reads the approval record; realtime events only wake it sooner. */
export const ERRAND_APPROVAL_POLL_MS = 500;
/** How far the target's box may move between the request and the decision and still count as the same target. */
export const ERRAND_TARGET_RECT_TOLERANCE_PX = 24;
const APPROVAL_BANNER_TEXT = "Waiting for your OK";

export type ErrandApprovalAnswer = "approved" | "denied" | "expired" | "stopped";

export interface ErrandApprovalRuntime {
  createApproval(input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitHook): Promise<ApprovalRequest>;
  resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<unknown>;
  withdrawApproval(approvalId: string, actorId: string): Promise<void>;
}

export interface ErrandAttachmentUploader {
  upload(input: {
    sessionId: string;
    fileName: string;
    mimeType: "image/png";
    bytes: Buffer;
    analysis: "skip";
  }): Promise<Pick<ChatAttachmentRecord, "attachmentId" | "sha256">>;
}

export interface ErrandRealtimeSource {
  subscribeRealtime(listener: (event: RealtimeEvent) => void): () => void;
}

export interface ErrandApprovalGateDeps {
  sessionId: string;
  turnId: string;
  runId?: string;
  durableRunId?: string;
  toolRunId: string;
  workspaceId?: string;
  browser: Pick<ErrandBrowser, "overlay" | "describeTarget" | "currentUrl" | "captureForPeople">;
  approvals: ErrandApprovalRuntime;
  /** The authority for decisions (`approvals.get`), plus the event log and Chat's inline approval rows. */
  storage: Pick<AsyncStorage, "approvals" | "approvalEvents" | "chatInlineApprovals">;
  attachments: ErrandAttachmentUploader;
  /** A wake hint only; the stored approval record decides. */
  realtime: ErrandRealtimeSource;
  signal: AbortSignal;
  now(): number;
}

export interface ErrandApprovalGate {
  request(input: ErrandApprovalInput): Promise<ErrandApprovalAnswer>;
  /** Withdraws the approval the gate is waiting on, if any. */
  withdrawPending(actorId: string): Promise<void>;
  /** Records the after screenshot against the most recently approved request. */
  recordAfterScreenshot(png: Buffer): Promise<void>;
}

interface Asked {
  approvalId: string;
  input: ErrandApprovalInput;
  origin: string;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function isReadable(target: ErrandTargetInfo): boolean {
  return target.text.trim() !== "" || target.role.trim() !== "";
}

function sameTarget(expected: ErrandTargetInfo, actual: ErrandTargetInfo | null): boolean {
  if (!isReadable(expected)) {
    return true;
  }
  if (!actual || actual.text !== expected.text || actual.role !== expected.role) {
    return false;
  }
  const a = expected.rect;
  const b = actual.rect;
  return [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every(
    (delta) => Math.abs(delta) <= ERRAND_TARGET_RECT_TOLERANCE_PX,
  );
}

function answerFor(approval: ApprovalRequest): ErrandApprovalAnswer {
  if (approval.status === "approved") {
    return "approved";
  }
  switch (approval.resolutionOutcome) {
    case "expired":
      return "expired";
    case "withdrawn":
      return "stopped";
    default:
      return "denied";
  }
}

export function createErrandApprovalGate(deps: ErrandApprovalGateDeps): ErrandApprovalGate {
  const { browser, storage, signal } = deps;
  let pendingId: string | undefined;
  let lastApproved: Asked | undefined;
  const wakers = new Set<() => void>();
  const wakeAll = (): void => {
    for (const wake of [...wakers]) {
      wake();
    }
  };

  const onAbort = (): void => wakeAll();
  signal.addEventListener("abort", onAbort, { once: true });

  /** Listens for this request's decision hints until the returned function is called. */
  const listen = (approvalId: string): (() => void) => {
    const unsubscribeRealtime = deps.realtime.subscribeRealtime((event) => {
      if (event.eventType === "approval_resolved" && event.payload.approvalId === approvalId) {
        wakeAll();
      }
    });
    const unsubscribeOverlay = browser.overlay.onEvent((event) => {
      if ((event.type !== "approve" && event.type !== "deny") || event.requestId !== approvalId) {
        return;
      }
      void deps.approvals
        .resolveApproval(approvalId, {
          decision: event.type === "approve" ? "approve" : "reject",
          resolvedBy: ERRAND_WINDOW_ACTOR_ID,
        })
        // Another surface may have decided first; the stored record still decides.
        .catch(() => undefined)
        .finally(wakeAll);
    });
    return () => {
      unsubscribeRealtime();
      unsubscribeOverlay();
    };
  };

  const sleep = (): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ERRAND_APPROVAL_POLL_MS);
      wakers.add(done);
    });

  const withdraw = async (approvalId: string, actorId: string): Promise<void> => {
    try {
      await deps.approvals.withdrawApproval(approvalId, actorId);
    } catch (error) {
      // Already decided elsewhere; the errand does not act on it either way.
      if (!(error instanceof ConflictError)) {
        throw error;
      }
    }
  };

  /** Waits for a decision; undefined means the errand was stopped (the approval is withdrawn). */
  const waitForDecision = async (approvalId: string): Promise<ApprovalRequest | undefined> => {
    for (;;) {
      if (signal.aborted) {
        await withdraw(approvalId, ERRAND_STOPPED_ACTOR_ID);
        return undefined;
      }
      const current = await storage.approvals.get(approvalId);
      if (current.status !== "pending") {
        return withCanonicalApprovalOutcome(storage, current);
      }
      await sleep();
    }
  };

  /**
   * Draws the window's approval card and returns a function that puts the driving banner back. The card is a
   * convenience: when the overlay cannot draw (render rejects), Chat still shows the approval.
   */
  const showCard = (approvalId: string, input: ErrandApprovalInput, title: string): (() => void) => {
    const cursor: ErrandOverlayPoint = { x: input.target.x, y: input.target.y };
    const shown = browser.overlay
      .snapshot()
      .then((snapshot) => (snapshot.mode === "driving" ? snapshot.bannerText : null))
      .catch(() => null)
      .then(async (drivingBanner) => {
        await browser.overlay
          .render({
            mode: "approval",
            bannerText: APPROVAL_BANNER_TEXT,
            cursor,
            requestId: approvalId,
            title,
            body: input.body,
            targetRect: input.target.rect,
          })
          .catch(() => undefined);
        return drivingBanner;
      });
    return () => {
      void shown.then(async (drivingBanner) => {
        if (drivingBanner !== null) {
          await browser.overlay.render({ mode: "driving", bannerText: drivingBanner, cursor }).catch(() => undefined);
        }
      });
    };
  };

  const ask = async (input: ErrandApprovalInput, title: string): Promise<Asked> => {
    const screenshot = await deps.attachments.upload({
      sessionId: deps.sessionId,
      fileName: "errand-before.png",
      mimeType: "image/png",
      bytes: input.peopleScreenshotPng,
      analysis: "skip",
    });
    const origin = originOf(input.pageUrl);
    const summary = `${title} — ${input.body}`;
    const expiresAt = new Date(deps.now() + ERRAND_APPROVAL_TTL_MS).toISOString();
    const onCreated: ApprovalCreateCommitHook = async (approval) => {
      await storage.chatInlineApprovals.upsert({
        approvalId: approval.approvalId,
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        kind: ERRAND_APPROVAL_KIND,
        toolName: ERRAND_TOOL_NAME,
        status: "pending",
        reason: summary,
        riskLevel: "caution",
        expiresAt: approval.expiresAt,
        details: {
          category: input.category,
          title,
          body: input.body,
          pageUrl: input.pageUrl,
          screenshotAttachmentId: screenshot.attachmentId,
          toolRunId: deps.toolRunId,
        },
        createdAt: approval.createdAt,
      });
      return undefined;
    };
    const approval = await deps.approvals.createApproval(
      {
        kind: ERRAND_APPROVAL_KIND,
        riskLevel: "caution",
        expiresAt,
        linkage: {
          sessionId: deps.sessionId,
          turnId: deps.turnId,
          ...(deps.workspaceId ? { workspaceId: deps.workspaceId } : {}),
          ...(deps.runId ? { runId: deps.runId } : {}),
          ...(deps.durableRunId ? { durableRunId: deps.durableRunId } : {}),
          toolName: ERRAND_TOOL_NAME,
          actionType: input.category,
          originSurface: "chat",
        },
        preview: {
          summary,
          url: input.pageUrl,
          title,
          screenshotAttachmentId: screenshot.attachmentId,
          screenshotSha256: screenshot.sha256,
        },
        payload: {
          category: input.category,
          targetText: input.target.text,
          targetRect: input.target.rect,
          pageOrigin: origin,
        },
      },
      onCreated,
    );
    return { approvalId: approval.approvalId, input, origin };
  };

  /** True when the page still shows what the operator approved. */
  const pageUnchanged = async (asked: Asked): Promise<{ unchanged: boolean; target: ErrandTargetInfo | null }> => {
    if (originOf(browser.currentUrl()) !== asked.origin) {
      return { unchanged: false, target: null };
    }
    if (!isReadable(asked.input.target)) {
      return { unchanged: true, target: null };
    }
    const target = await browser.describeTarget(asked.input.target.x, asked.input.target.y).catch(() => null);
    return { unchanged: sameTarget(asked.input.target, target), target };
  };

  const request = async (initial: ErrandApprovalInput): Promise<ErrandApprovalAnswer> => {
    let input = initial;
    let title = initial.title;
    for (;;) {
      if (signal.aborted) {
        return "stopped";
      }
      const asked = await ask(input, title);
      pendingId = asked.approvalId;
      const stopListening = listen(asked.approvalId);
      const hideCard = showCard(asked.approvalId, input, title);
      let decided: ApprovalRequest | undefined;
      try {
        decided = await waitForDecision(asked.approvalId);
      } finally {
        pendingId = undefined;
        stopListening();
        hideCard();
      }
      if (!decided) {
        return "stopped";
      }
      const answer = answerFor(decided);
      if (answer !== "approved") {
        return answer;
      }
      const check = await pageUnchanged(asked);
      if (check.unchanged) {
        lastApproved = asked;
        return "approved";
      }
      const pageUrl = browser.currentUrl();
      const peopleScreenshotPng = await browser.captureForPeople().catch(() => input.peopleScreenshotPng);
      input = { ...input, pageUrl, peopleScreenshotPng, target: check.target ?? input.target };
      title = ERRAND_PAGE_CHANGED_TITLE;
    }
  };

  const withdrawPending = async (actorId: string): Promise<void> => {
    const approvalId = pendingId;
    if (approvalId) {
      await withdraw(approvalId, actorId);
      wakeAll();
    }
  };

  const recordAfterScreenshot = async (png: Buffer): Promise<void> => {
    const approved = lastApproved;
    if (!approved) {
      return;
    }
    lastApproved = undefined;
    const screenshot = await deps.attachments.upload({
      sessionId: deps.sessionId,
      fileName: "errand-after.png",
      mimeType: "image/png",
      bytes: png,
      analysis: "skip",
    });
    await storage.approvalEvents.append({
      approvalId: approved.approvalId,
      eventType: "errand_after_screenshot",
      actorId: "system:errand",
      payload: {
        screenshotAttachmentId: screenshot.attachmentId,
        screenshotSha256: screenshot.sha256,
        pageUrl: browser.currentUrl(),
      },
    });
  };

  return { request, withdrawPending, recordAfterScreenshot };
}

/** Wires a gate into the errand loop's approval hooks. */
export function errandLoopApprovalHooks(
  gate: ErrandApprovalGate,
): Required<Pick<ErrandLoopDeps, "requestApproval" | "afterApprovedAction">> {
  return {
    requestApproval: (input) => gate.request(input),
    afterApprovedAction: (png) => gate.recordAfterScreenshot(png),
  };
}
