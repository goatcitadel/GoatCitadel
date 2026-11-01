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
/** How many times the gate asks again after the page changed under an approval before it gives up. */
export const ERRAND_MAX_PAGE_CHANGED_REASKS = 3;
export const ERRAND_PAGE_KEPT_CHANGING_REASON = "The page kept changing, so GoatCitadel didn't act.";
export const ERRAND_APPROVAL_IN_FLIGHT_MESSAGE =
  "An errand approval is already waiting for a decision; the errand asks for one approval at a time.";

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
  /**
   * Asks the operator and waits for the decision. Single-flight: one request at a time (the errand loop awaits each);
   * a second call while one is in flight rejects with ERRAND_APPROVAL_IN_FLIGHT_MESSAGE.
   */
  request(input: ErrandApprovalInput): Promise<ErrandApprovalAnswer>;
  /** Withdraws the approval the gate is waiting on, if any. */
  withdrawPending(actorId: string): Promise<void>;
  /** Records the after screenshot against the most recently approved request. */
  recordAfterScreenshot(png: Buffer): Promise<void>;
  /** Why the last `request` returned "denied" without an operator deny, for the errand summary; else undefined. */
  readonly lastReason: string | undefined;
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

  /** Reads the driving banner shown before the first card, so it can be put back once the operator approves. */
  const readDrivingBanner = (): Promise<string | null> =>
    browser.overlay
      .snapshot()
      .then((snapshot) => (snapshot.mode === "driving" ? snapshot.bannerText : null))
      .catch(() => null);

  /**
   * Draws the window's approval card once the driving banner was read. The card is a convenience: when the overlay
   * cannot draw (render rejects), Chat still shows the approval. Returns a function that cancels a card not yet drawn.
   */
  const showCard = (
    drivingBanner: Promise<string | null>,
    approvalId: string,
    input: ErrandApprovalInput,
    title: string,
  ): { shown: Promise<void>; cancel: () => void } => {
    let cancelled = false;
    const shown = drivingBanner.then(async () => {
      if (cancelled) {
        return;
      }
      await browser.overlay
        .render({
          mode: "approval",
          bannerText: APPROVAL_BANNER_TEXT,
          cursor: { x: input.target.x, y: input.target.y },
          requestId: approvalId,
          title,
          body: input.body,
          targetRect: input.target.rect,
        })
        .catch(() => undefined);
    });
    return {
      shown,
      cancel: () => {
        cancelled = true;
      },
    };
  };

  /** Puts the driving banner back after an approval, before the loop acts. */
  const restoreDriving = async (
    drivingBanner: Promise<string | null>,
    shown: Promise<void>,
    input: ErrandApprovalInput,
  ): Promise<void> => {
    await shown;
    const bannerText = await drivingBanner;
    if (bannerText !== null) {
      const cursor: ErrandOverlayPoint = { x: input.target.x, y: input.target.y };
      await browser.overlay.render({ mode: "driving", bannerText, cursor }).catch(() => undefined);
    }
  };

  /** Inbox evidence: the operator approved, but the page changed, so the action was not taken. */
  const recordSuperseded = async (asked: Asked, originChanged: boolean, reasked: boolean): Promise<void> => {
    try {
      await appendSuperseded(asked, originChanged, reasked);
    } catch (error) {
      // Evidence only: the action is still not taken, and the errand carries on with its re-ask or give-up.
      // eslint-disable-next-line no-console -- bounded diagnostic; the approval record itself is already committed.
      console.warn("[goatcitadel] errand superseded evidence could not be recorded", {
        approvalId: asked.approvalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const appendSuperseded = async (asked: Asked, originChanged: boolean, reasked: boolean): Promise<void> => {
    await storage.approvalEvents.append({
      approvalId: asked.approvalId,
      eventType: "superseded",
      actorId: "system:errand",
      payload: {
        reason: "page_changed",
        actedOn: false,
        originChanged,
        approvedOrigin: asked.origin,
        pageUrl: browser.currentUrl(),
        reasked,
      },
    });
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
  const pageUnchanged = async (
    asked: Asked,
  ): Promise<{ unchanged: boolean; originChanged: boolean; target: ErrandTargetInfo | null }> => {
    if (originOf(browser.currentUrl()) !== asked.origin) {
      return { unchanged: false, originChanged: true, target: null };
    }
    if (!isReadable(asked.input.target)) {
      return { unchanged: true, originChanged: false, target: null };
    }
    const target = await browser.describeTarget(asked.input.target.x, asked.input.target.y).catch(() => null);
    return { unchanged: sameTarget(asked.input.target, target), originChanged: false, target };
  };

  let lastReason: string | undefined;
  let inFlight = false;

  const request = async (initial: ErrandApprovalInput): Promise<ErrandApprovalAnswer> => {
    if (inFlight) {
      throw new Error(ERRAND_APPROVAL_IN_FLIGHT_MESSAGE);
    }
    inFlight = true;
    try {
      return await requestOnce(initial);
    } finally {
      inFlight = false;
    }
  };

  const requestOnce = async (initial: ErrandApprovalInput): Promise<ErrandApprovalAnswer> => {
    lastReason = undefined;
    let input = initial;
    let title = initial.title;
    let drivingBanner: Promise<string | null> | undefined;
    for (let reasks = 0; ; reasks += 1) {
      if (signal.aborted) {
        return "stopped";
      }
      const asked = await ask(input, title);
      pendingId = asked.approvalId;
      const stopListening = listen(asked.approvalId);
      drivingBanner ??= readDrivingBanner();
      const card = showCard(drivingBanner, asked.approvalId, input, title);
      let decided: ApprovalRequest | undefined;
      try {
        decided = await waitForDecision(asked.approvalId);
      } finally {
        pendingId = undefined;
        stopListening();
        // A card not drawn yet must never land after the errand moved on.
        card.cancel();
      }
      if (!decided) {
        return "stopped";
      }
      const answer = answerFor(decided);
      if (answer !== "approved") {
        // Leave the overlay to the loop: it hides or ends it for a stopped, denied or expired errand.
        return answer;
      }
      const check = await pageUnchanged(asked);
      if (check.unchanged) {
        lastApproved = asked;
        await restoreDriving(drivingBanner, card.shown, input);
        return "approved";
      }
      const giveUp = reasks >= ERRAND_MAX_PAGE_CHANGED_REASKS;
      await recordSuperseded(asked, check.originChanged, !giveUp);
      if (giveUp) {
        lastReason = ERRAND_PAGE_KEPT_CHANGING_REASON;
        return "denied";
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

  return {
    request,
    withdrawPending,
    recordAfterScreenshot,
    get lastReason() {
      return lastReason;
    },
  };
}

/** Wires a gate into the errand loop's approval hooks. */
export function errandLoopApprovalHooks(
  gate: ErrandApprovalGate,
): Required<Pick<ErrandLoopDeps, "requestApproval" | "afterApprovedAction" | "lastDenialReason">> {
  return {
    requestApproval: (input) => gate.request(input),
    afterApprovedAction: (png) => gate.recordAfterScreenshot(png),
    lastDenialReason: () => gate.lastReason,
  };
}
