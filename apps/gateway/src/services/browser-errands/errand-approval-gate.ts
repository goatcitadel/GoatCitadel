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
import { ERRAND_APPROVAL_KIND, ERRAND_APPROVAL_TTL_MS, ERRAND_ESCALATE_AFTER_MS } from "./errand-constants.js";
import { persistableUrl, type ErrandApprovalInput, type ErrandLoopDeps } from "./errand-loop.js";
import type { ErrandOrigin } from "./errand-origin.js";
import type { ErrandEscalationStage } from "./errand-escalation.js";

export { ERRAND_APPROVAL_KIND };
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
  browser: Pick<
    ErrandBrowser,
    "overlay" | "describeTargetBeneathOverlay" | "describeFocusedBeneathOverlay" | "currentUrl" | "captureForPeople"
  >;
  approvals: ErrandApprovalRuntime;
  /** The authority for decisions (`approvals.get`), plus the event log and Chat's inline approval rows. */
  storage: Pick<AsyncStorage, "approvals" | "approvalEvents" | "chatInlineApprovals">;
  attachments: ErrandAttachmentUploader;
  /** A wake hint only; the stored approval record decides. */
  realtime: ErrandRealtimeSource;
  signal: AbortSignal;
  now(): number;
  /** Where the errand was started; with `escalate`, decides when an approval also goes beyond the window and Chat. */
  origin?: ErrandOrigin;
  /**
   * Sends a waiting approval out beyond the window and Chat: stage "asked" at once (channel errands only), stage
   * "waited" after ERRAND_ESCALATE_AFTER_MS (every errand). Never awaited by the gate; the "waited" timer is cancelled
   * once the approval is decided or the errand stops.
   */
  escalate?: (approval: ApprovalRequest, origin: ErrandOrigin, stage: ErrandEscalationStage) => Promise<void>;
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
  /** Whether the stored approval record is still pending; a record that cannot be read counts as not pending. */
  isPending(approvalId: string): Promise<boolean>;
  /** The approval the gate is waiting on right now, if any. */
  pendingApprovalId(): string | undefined;
  /** Why the last `request` returned "denied" without an operator deny, for the errand summary; else undefined. */
  readonly lastReason: string | undefined;
}

interface Asked {
  approval: ApprovalRequest;
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

/** A password, one-time-code or unreadable (opaque) surface the operator did not approve as one. */
function becameSensitive(expected: ErrandTargetInfo, actual: ErrandTargetInfo): boolean {
  return (
    (actual.isPasswordLike && !expected.isPasswordLike) ||
    (actual.isOneTimeCode && !expected.isOneTimeCode) ||
    (actual.isOpaque && !expected.isOpaque)
  );
}

function sameTarget(expected: ErrandTargetInfo, actual: ErrandTargetInfo | null, targetsFocus: boolean): boolean {
  if (!isReadable(expected) && expected.backendNodeId === undefined) {
    // Nothing readable was approved: it is the same only while nothing readable or sensitive has appeared there.
    return actual === null || (!isReadable(actual) && !becameSensitive(expected, actual));
  }
  if (!actual || actual.text !== expected.text || actual.role !== expected.role || becameSensitive(expected, actual)) {
    return false;
  }
  // A key press lands on whatever has focus, and only node identity tells two identical fields apart: without it,
  // the focused field cannot be shown to be the approved one.
  if (targetsFocus && expected.backendNodeId === undefined) {
    return false;
  }
  // Another element with the same text, role and box (a second, identical field) is still a different target.
  if (expected.backendNodeId !== undefined && actual.backendNodeId !== expected.backendNodeId) {
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
  const { browser, storage, signal, sessionId, origin: errandOrigin, escalate } = deps;
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
        pageUrl: persistableUrl(browser.currentUrl()),
        reasked,
      },
    });
  };

  const ask = async (input: ErrandApprovalInput, title: string): Promise<Asked> => {
    const screenshot = await deps.attachments.upload({
      sessionId,
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
        sessionId,
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
          pageUrl: persistableUrl(input.pageUrl),
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
          sessionId,
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
          url: persistableUrl(input.pageUrl),
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
    return { approval, approvalId: approval.approvalId, input, origin };
  };

  /**
   * Sends the approval beyond the window and Chat: a channel errand's "asked" stage at once, and every errand's
   * "waited" stage after ERRAND_ESCALATE_AFTER_MS. Returns the cancel for the timer; each re-ask is a new approval
   * with its own.
   */
  const scheduleEscalation = (approval: ApprovalRequest): (() => void) => {
    if (!escalate || !errandOrigin) {
      return () => undefined;
    }
    const send = (stage: ErrandEscalationStage): void => {
      // A synchronous throw from `escalate` lands in the same catch as a rejection.
      void Promise.resolve()
        .then(() => escalate(approval, errandOrigin, stage))
        .catch((error: unknown) => {
          // The approval still waits in the window and Chat; only the extra reach failed.
          // eslint-disable-next-line no-console -- bounded diagnostic; the approval record is unaffected.
          console.warn("[goatcitadel] errand approval could not be sent beyond the window and Chat", {
            approvalId: approval.approvalId,
            stage,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
    if (errandOrigin.kind === "channel") {
      send("asked");
    }
    const timer = setTimeout(() => send("waited"), ERRAND_ESCALATE_AFTER_MS);
    // The timer never keeps the Gateway process alive on its own.
    timer.unref?.();
    return () => clearTimeout(timer);
  };

  /** True when the page still shows what the operator approved. */
  const pageUnchanged = async (
    asked: Asked,
  ): Promise<{ unchanged: boolean; originChanged: boolean; target: ErrandTargetInfo | null }> => {
    if (originOf(browser.currentUrl()) !== asked.origin) {
      return { unchanged: false, originChanged: true, target: null };
    }
    const expected = asked.input.target;
    // Read beneath the approval card: the card and its blocker cover the page until the driving banner is back. A
    // keyboard action lands on whatever has focus, so it re-reads focus, not the point: page script may have moved it.
    const target = await (
      asked.input.targetsFocus
        ? browser.describeFocusedBeneathOverlay()
        : browser.describeTargetBeneathOverlay(expected.x, expected.y)
    ).catch(() => null);
    return {
      unchanged: sameTarget(expected, target, asked.input.targetsFocus === true),
      originChanged: false,
      target,
    };
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
      const stopEscalation = scheduleEscalation(asked.approval);
      let decided: ApprovalRequest | undefined;
      try {
        decided = await waitForDecision(asked.approvalId);
      } finally {
        pendingId = undefined;
        stopListening();
        stopEscalation();
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
      sessionId,
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
        pageUrl: persistableUrl(browser.currentUrl()),
      },
    });
  };

  const isPending = async (approvalId: string): Promise<boolean> =>
    await storage.approvals.get(approvalId).then(
      (approval) => approval.status === "pending",
      () => false,
    );

  return {
    request,
    withdrawPending,
    recordAfterScreenshot,
    isPending,
    pendingApprovalId: () => pendingId,
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
