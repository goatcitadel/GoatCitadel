import { randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ConnectorDeliveryWorkflowPayload,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";
import { ErrandBrowserLaunchError, type ErrandBrowser, type ErrandOverlayEvent } from "@goatcitadel/policy-engine";
import {
  createErrandApprovalGate,
  errandLoopApprovalHooks,
  ERRAND_STOPPED_ACTOR_ID,
  ERRAND_WINDOW_ACTOR_ID,
  type ErrandApprovalGate,
  type ErrandApprovalGateDeps,
} from "./errand-approval-gate.js";
import { runErrandLoop, type ErrandLoopDeps, type ErrandOutcome, type ErrandProgress } from "./errand-loop.js";
import { resolveOwnedErrandOrigin, type ErrandOrigin, type ErrandOriginDeps } from "./errand-origin.js";
import type { ErrandTrackedDelivery } from "./errand-approval-delivery.js";
import { warnErrandButtonClearFailure } from "./errand-approval-buttons.js";
import type { ErrandChannelReplies, PendingErrandDelivery } from "./errand-channel-replies.js";
import { warnErrandNoticeFailure } from "./errand-channel-notices.js";
import { ERRAND_APPROVAL_KIND } from "./errand-constants.js";

export const BROWSER_ERRAND_DISABLED_MESSAGE = "Browser errands are turned off. Turn on Browser errands in Settings.";
export const BROWSER_ERRAND_REMOTE_HARDENED_MESSAGE =
  "Browser errands aren't available on this GoatCitadel. They need GoatCitadel running on your own PC.";
/** A channel sender who is not the operator's own account (see `isErrandOwner`) asked for an errand. */
export const BROWSER_ERRAND_OWNER_ONLY_MESSAGE = "Only the owner can start a browser errand here.";
/** Someone other than the operator's own account answered an errand approval in a channel. */
export const BROWSER_ERRAND_OWNER_ANSWER_MESSAGE = "Only the owner can answer this.";
export const BROWSER_ERRAND_BUSY_MESSAGE = "Another errand is running. Stop it or wait for it to finish.";
export const BROWSER_ERRAND_NO_TURN_MESSAGE = "Browser errands run only inside a Chat turn.";
export const BROWSER_ERRAND_NO_GOAL_MESSAGE = "Say what the errand is.";
export const BROWSER_ERRAND_PROFILE_LOCKED_MESSAGE =
  "The errand browser is already open in another GoatCitadel or didn't close cleanly. Close Chrome windows using the GoatCitadel profile and try again.";
export const BROWSER_ERRAND_CHROME_MISSING_MESSAGE =
  "GoatCitadel couldn't find Google Chrome on this PC. Install Chrome and try again.";
export const BROWSER_ERRAND_LAUNCH_FAILED_MESSAGE = "The errand browser didn't start. Try again.";
export const BROWSER_ERRAND_SHUTTING_DOWN_MESSAGE = "GoatCitadel is shutting down, so the errand can't start.";
/** How long Gateway shutdown waits for a running errand to withdraw its approval and settle before closing Chrome. */
export const ERRAND_DISPOSE_SETTLE_MS = 5_000;
export const BROWSER_ERRAND_WINDOW_CLOSED_SUMMARY = "The errand window was closed.";
export const BROWSER_ERRAND_APPROVAL_UNRECORDED_SUMMARY = "GoatCitadel couldn't record the approval, so it stopped.";

export const ERRAND_BANNER_TEXT = "GoatCitadel is using this browser";
export const ERRAND_SIGN_IN_BANNER_TEXT = "Sign in, then press Hand back";
export const ERRAND_TAKEN_OVER_BANNER_TEXT = "You're in control. Press Hand back when you're done";
/** A step thumbnail is uploaded at most this often, so Chat shows progress without storing every screenshot. */
export const ERRAND_THUMBNAIL_EVERY_STEPS = 3;
export const ERRAND_PLANNED_BEFORE_TAKEOVER_MESSAGE =
  "The operator took over after that screenshot, so nothing was run. Look at the screen again.";
/** The window stays on the final page this long after an errand, then closes. */
export const ERRAND_IDLE_CLOSE_MS = 15 * 60_000;
const ERRAND_GOAL_MAX_CHARS = 2_000;
const STATUS_HISTORY_LIMIT = 20;
const VIEWPORT_CENTER = { x: 640, y: 400 } as const;

export type ErrandViewState = "running" | "waiting_on_you" | "taken_over" | "finished";

export interface ErrandStatusView {
  errandId: string;
  toolRunId: string;
  state: ErrandViewState;
  stepCount: number;
  stepText: string;
  thumbnailAttachmentId?: string;
  finalAttachmentId?: string;
  modelRequests: number;
  outcome?: ErrandOutcome["status"];
  summary?: string;
}

export interface BrowserErrandToolResult extends Record<string, unknown> {
  outcome: ErrandOutcome["status"];
  answer?: string;
  summary: string;
  steps: number;
  modelRequests: number;
  visitedUrls: string[];
  finalScreenshotAttachmentId?: string;
}

type GateDeps = Pick<ErrandApprovalGateDeps, "approvals" | "storage" | "attachments" | "realtime" | "escalate">;

export interface BrowserErrandServiceDeps {
  isEnabled(): Promise<boolean>;
  deploymentProfile(): string;
  /** Reads where a turn came from and who sent it, for the owner rule. */
  origin: ErrandOriginDeps;
  launchBrowser(signal: AbortSignal): Promise<ErrandBrowser>;
  callModel(
    request: ChatCompletionRequest,
    lineage: { errandId: string; sessionId: string; turnId: string; workspaceId?: string },
  ): Promise<ChatCompletionResponse>;
  gate: GateDeps;
  now?(): number;
  /** Tests inject a fake loop or gate; production uses the real ones. */
  runLoop?: typeof runErrandLoop;
  createGate?: (deps: ErrandApprovalGateDeps) => ErrandApprovalGate;
  idleCloseMs?: number;
  disposeSettleMs?: number;
  /** Builds the answers to APPROVE / DENY / STOP replies in channel conversations, from this service. */
  channelReplies?(service: BrowserErrandService): ErrandChannelReplies;
}

interface ActiveErrand {
  view: ErrandStatusView;
  /** Where the errand was started: Chat on the PC, or the operator's channel conversation. */
  origin: ErrandOrigin;
  controller: AbortController;
  gate?: ErrandApprovalGate;
  handBackWaiters: Set<(answer: "resumed" | "stopped") => void>;
  takenOverSince?: number;
  takenOverMs: number;
  /** Counts the operator's Take overs; a batch planned from a screenshot taken before the latest one never runs. */
  takeovers: number;
  /** `takeovers` when the latest screenshot for the model was taken. */
  takeoversAtCapture: number;
  windowClosed: boolean;
  /** The gate could not record (or withdraw) an approval, so the errand was stopped without one. */
  approvalUnrecorded: boolean;
  /** Set the moment Stop starts, before its withdrawal is awaited: from then on no approval or action goes ahead. */
  stopping: boolean;
  /** Resolves once the run has finished its cleanup, whatever its outcome. */
  settled?: Promise<void>;
  /**
   * This errand's approvals queued to channel conversations, oldest first. A text reply there can answer one only once
   * its provider send has completed (`deliveredAt`, read from the delivery and kept once known).
   */
  deliveries: ReadonlyArray<ErrandTrackedDelivery & { deliveredAt?: number }>;
  /** The deliveries whose buttons were already sent for removal, by delivery run id. */
  buttonsCleared: Set<string>;
}

/**
 * When the delivery's provider send completed, kept on the errand once known. A send still queued, failed or unreadable
 * reads as undefined, so a reply in that conversation does not match it yet.
 */
async function confirmDelivery(
  errand: ActiveErrand,
  item: ActiveErrand["deliveries"][number],
): Promise<number | undefined> {
  const deliveredAt = await item.sentAt().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- bounded diagnostic; the reply simply does not match yet.
    console.warn("[goatcitadel] errand approval delivery could not be read", {
      deliveryRunId: item.deliveryRunId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
  if (deliveredAt !== undefined) {
    errand.deliveries = errand.deliveries.map((entry) => (entry === item ? { ...entry, deliveredAt } : entry));
  }
  return deliveredAt;
}

/** Approval evidence could not be recorded: the errand stops (fail closed) and its summary says why. */
function stopApprovalUnrecorded(errand: ActiveErrand, error: unknown): void {
  // eslint-disable-next-line no-console -- bounded diagnostic; the errand stops and says why.
  console.warn("[goatcitadel] browser errand approval could not be recorded", {
    errandId: errand.view.errandId,
    error: error instanceof Error ? error.message : String(error),
  });
  errand.approvalUnrecorded = true;
  errand.controller.abort();
}

/** Runs one browser errand at a time in GoatCitadel's own Chrome window, for the `browser.errand` tool. */
export class BrowserErrandService {
  private active: ActiveErrand | undefined;
  private browser: ErrandBrowser | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly views = new Map<string, ErrandStatusView>();
  private readonly gateDependencies: GateDeps;
  private disposed = false;

  /** Answers whole-message APPROVE / DENY / STOP replies in the conversations this errand asked in. */
  public readonly channelReplies: ErrandChannelReplies | undefined;

  public constructor(private readonly deps: BrowserErrandServiceDeps) {
    this.gateDependencies = deps.gate;
    this.channelReplies = deps.channelReplies?.(this);
  }

  /** Where the running errand was started, if one is running. */
  public getActiveOrigin(): ErrandOrigin | undefined {
    const origin = this.active?.origin;
    return origin ? { ...origin } : undefined;
  }

  /**
   * Remembers that the running errand's approval was queued to a channel conversation. It targets the single active
   * errand (only one runs at a time); a record that arrives after that errand ended is dropped. Queueing is not
   * delivery: the record counts for a reply only once `sentAt` reports the completed provider send.
   */
  public recordDelivery(record: ErrandTrackedDelivery): void {
    const errand = this.active;
    if (!errand) {
      return;
    }
    const { approvalId, connectionId, target, deliveryRunId, sentAt, buttons, providerMessageId } = record;
    errand.deliveries = [
      ...errand.deliveries,
      {
        approvalId,
        connectionId,
        target,
        deliveryRunId,
        sentAt,
        ...(buttons !== undefined ? { buttons } : {}),
        ...(providerMessageId ? { providerMessageId } : {}),
      },
    ];
  }

  /** A committed send can finish after its approval or errand ended; no errand state is retained for that wait. */
  public async onConnectorDeliveryCompleted(
    deliveryRunId: string,
    payload: ConnectorDeliveryWorkflowPayload,
    checkpointState: Record<string, unknown>,
  ): Promise<void> {
    const action = payload.payload;
    const approvalId = payload.correlationId?.trim();
    const target = typeof action?.target === "string" ? action.target.trim() : "";
    const template = action?.interactiveActionTemplate;
    const result = checkpointState.result as Record<string, unknown> | undefined;
    const messageId = typeof result?.providerMessageId === "string" ? result.providerMessageId.trim() : "";
    if (
      this.disposed ||
      !this.channelReplies?.clearButtons ||
      payload.connectorType !== "integration_connection" ||
      payload.action !== "channel.send" ||
      !payload.connectorId.startsWith("integration:") ||
      !approvalId ||
      !target ||
      !messageId ||
      typeof template !== "object" ||
      template === null ||
      !Array.isArray((template as Record<string, unknown>).buttons) ||
      ((template as Record<string, unknown>).buttons as unknown[]).length === 0
    ) {
      return;
    }
    // Keep this reference across the read so a concurrent answer's normal cleanup shares its claim set.
    const errand = this.active;
    try {
      const approval = await this.gateDependencies.storage.approvals.get(approvalId);
      if (approval.kind !== ERRAND_APPROVAL_KIND) return;
      const active = this.active;
      if (
        approval.status === "pending" &&
        active?.gate?.pendingApprovalId() === approvalId &&
        !active.stopping &&
        !active.controller.signal.aborted
      )
        return;
      const owner = errand?.deliveries.some((item) => item.deliveryRunId === deliveryRunId) ? errand : undefined;
      await this.clearDeliveredButtons(owner, [
        {
          approvalId,
          connectionId: payload.connectorId.slice("integration:".length),
          target,
          deliveryRunId,
          buttons: true,
          sentAt: async () => undefined,
          providerMessageId: async () => messageId,
        },
      ]);
    } catch (error) {
      warnErrandButtonClearFailure(error);
    }
  }

  /**
   * The approval the running errand is waiting on right now, when its send to this conversation completed no later than
   * `sentAt` (when the answering message arrived) and its stored record is still pending. An older or stale delivery
   * to the same conversation never counts, so a reply can only answer the question that was already in front of it.
   */
  public async pendingDeliveryFor(
    connectionId: string,
    target: string,
    sentAt: number = Number.POSITIVE_INFINITY,
  ): Promise<PendingErrandDelivery | undefined> {
    const errand = this.active;
    const gate = errand?.gate;
    const approvalId = gate?.pendingApprovalId();
    if (!errand || !gate || !approvalId || errand.stopping) {
      return undefined;
    }
    let delivered = false;
    for (const item of errand.deliveries) {
      if (item.approvalId !== approvalId || item.connectionId !== connectionId || item.target !== target) {
        continue;
      }
      const deliveredAt = item.deliveredAt ?? (await confirmDelivery(errand, item));
      if (deliveredAt !== undefined && deliveredAt <= sentAt) {
        delivered = true;
        break;
      }
    }
    if (!delivered || !(await gate.isPending(approvalId))) {
      return undefined;
    }
    return { approvalId, errandId: errand.view.errandId };
  }

  public getStatus(toolRunId: string): ErrandStatusView | undefined {
    const view = this.views.get(toolRunId);
    return view ? { ...view } : undefined;
  }

  public async stop(errandId: string, actorId: string): Promise<boolean> {
    const errand = this.active;
    if (!errand || errand.view.errandId !== errandId) {
      return false;
    }
    // Fence first, synchronously: an approval decided while the withdrawal below is in flight must not be acted on.
    errand.stopping = true;
    // Withdraw under the stopping actor before the abort lets the gate withdraw it as a system stop.
    await errand.gate?.withdrawPending(actorId).catch(() => undefined);
    errand.controller.abort();
    this.resolveHandBack(errand, "stopped");
    return true;
  }

  /** Gateway shutdown: refuses new errands, stops the running one (withdrawing its approval), then closes Chrome. */
  public async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    const errand = this.active;
    if (errand) {
      errand.stopping = true;
      // Withdraw while storage is still open, so no approval is left pending after shutdown.
      await errand.gate?.withdrawPending(ERRAND_STOPPED_ACTOR_ID).catch(() => undefined);
      errand.controller.abort();
      this.resolveHandBack(errand, "stopped");
      await this.settleWithin(errand.settled, this.deps.disposeSettleMs ?? ERRAND_DISPOSE_SETTLE_MS);
    }
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }

  public async run(request: ToolInvokeRequest): Promise<BrowserErrandToolResult> {
    if (this.disposed) {
      throw new Error(BROWSER_ERRAND_SHUTTING_DOWN_MESSAGE);
    }
    const goal = typeof request.args.goal === "string" ? request.args.goal.trim().slice(0, ERRAND_GOAL_MAX_CHARS) : "";
    const turnId = request.turnId?.trim();
    const toolRunId = request.toolRunId?.trim();
    await this.assertAllowed();
    if (!turnId || !toolRunId) {
      throw new Error(BROWSER_ERRAND_NO_TURN_MESSAGE);
    }
    // Chat on the PC, or the operator's own account in one of their channels; anyone else, or an origin that can't be
    // read, is refused.
    const origin = await resolveOwnedErrandOrigin(this.deps.origin, request.sessionId, turnId).catch(() => undefined);
    if (!origin) {
      throw new Error(BROWSER_ERRAND_OWNER_ONLY_MESSAGE);
    }
    if (!goal) {
      throw new Error(BROWSER_ERRAND_NO_GOAL_MESSAGE);
    }
    if (this.disposed) {
      throw new Error(BROWSER_ERRAND_SHUTTING_DOWN_MESSAGE);
    }
    if (this.active) {
      throw new Error(BROWSER_ERRAND_BUSY_MESSAGE);
    }
    const errand: ActiveErrand = {
      view: {
        errandId: randomUUID(),
        toolRunId,
        state: "running",
        stepCount: 0,
        stepText: "Starting",
        modelRequests: 0,
      },
      origin,
      controller: new AbortController(),
      handBackWaiters: new Set(),
      takenOverMs: 0,
      takeovers: 0,
      takeoversAtCapture: 0,
      windowClosed: false,
      approvalUnrecorded: false,
      stopping: false,
      deliveries: [],
      buttonsCleared: new Set(),
    };
    // Claimed before any await, so a second call in the same tick is refused.
    this.active = errand;
    this.remember(errand.view);
    const work = this.runClaimed(errand, request, { goal, turnId, toolRunId });
    errand.settled = work.then(
      () => undefined,
      () => undefined,
    );
    return await work;
  }

  private async runClaimed(
    errand: ActiveErrand,
    request: ToolInvokeRequest,
    ids: { goal: string; turnId: string; toolRunId: string },
  ): Promise<BrowserErrandToolResult> {
    const { goal, turnId, toolRunId } = ids;
    const onTurnAbort = (): void =>
      void this.stop(errand.view.errandId, ERRAND_STOPPED_ACTOR_ID).catch(() => undefined);
    request.signal?.addEventListener("abort", onTurnAbort, { once: true });
    try {
      if (request.signal?.aborted) {
        errand.controller.abort();
      }
      const browser = await this.acquireBrowser(errand.controller.signal);
      return await this.runWithBrowser(errand, browser, { request, goal, turnId, toolRunId });
    } catch (error) {
      this.finishView(errand, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", onTurnAbort);
      if (this.active === errand) {
        this.active = undefined;
      }
      this.scheduleIdleClose();
    }
  }

  private async assertAllowed(): Promise<void> {
    if (!(await this.deps.isEnabled())) {
      throw new Error(BROWSER_ERRAND_DISABLED_MESSAGE);
    }
    if (this.deps.deploymentProfile() === "remote_hardened") {
      throw new Error(BROWSER_ERRAND_REMOTE_HARDENED_MESSAGE);
    }
  }

  private async acquireBrowser(signal: AbortSignal): Promise<ErrandBrowser> {
    this.clearIdleTimer();
    if (this.browser && !this.browser.isClosed()) {
      return this.browser;
    }
    this.browser = undefined;
    try {
      const launched = await this.deps.launchBrowser(signal);
      if (this.disposed) {
        // Shutdown began while Chrome was starting: close it now so it never holds the profile past shutdown.
        await launched.close().catch(() => undefined);
        throw new Error(BROWSER_ERRAND_SHUTTING_DOWN_MESSAGE);
      }
      this.browser = launched;
      return launched;
    } catch (error) {
      if (error instanceof ErrandBrowserLaunchError) {
        throw new Error(
          error.code === "profile_locked"
            ? BROWSER_ERRAND_PROFILE_LOCKED_MESSAGE
            : error.code === "chrome_missing"
              ? BROWSER_ERRAND_CHROME_MISSING_MESSAGE
              : BROWSER_ERRAND_LAUNCH_FAILED_MESSAGE,
          { cause: error },
        );
      }
      if (error instanceof Error && error.message === BROWSER_ERRAND_SHUTTING_DOWN_MESSAGE) {
        throw error;
      }
      throw new Error(BROWSER_ERRAND_LAUNCH_FAILED_MESSAGE, { cause: error });
    }
  }

  private async runWithBrowser(
    errand: ActiveErrand,
    browser: ErrandBrowser,
    ids: { request: ToolInvokeRequest; goal: string; turnId: string; toolRunId: string },
  ): Promise<BrowserErrandToolResult> {
    const { request, turnId, toolRunId } = ids;
    const signal = errand.controller.signal;
    const { now: injectedNow } = this.deps;
    const realNow = injectedNow ?? Date.now;
    const offClosed = browser.onClosed(() => {
      errand.windowClosed = true;
      errand.controller.abort();
      this.resolveHandBack(errand, "stopped");
    });
    const offOverlay = browser.overlay.onEvent((event) => this.onOverlayEvent(errand, browser, event, realNow));
    const gate = (this.deps.createGate ?? createErrandApprovalGate)({
      ...this.gateDependencies,
      sessionId: request.sessionId,
      turnId,
      toolRunId,
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      browser,
      signal,
      now: realNow,
      origin: errand.origin,
    });
    errand.gate = gate;
    const hooks = errandLoopApprovalHooks(gate);
    const uploads: Array<Promise<void>> = [];
    let lastThumbnailStep = -ERRAND_THUMBNAIL_EVERY_STEPS;
    const upload = async (fileName: string, png: Buffer): Promise<string> =>
      (
        await this.gateDependencies.attachments.upload({
          sessionId: request.sessionId,
          fileName,
          mimeType: "image/png",
          bytes: png,
          analysis: "skip",
        })
      ).attachmentId;

    const loopDeps: ErrandLoopDeps = {
      callModel: async (modelRequest) => {
        errand.view.modelRequests += 1;
        return await this.deps.callModel(modelRequest, {
          errandId: errand.view.errandId,
          sessionId: request.sessionId,
          turnId,
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        });
      },
      browser: this.pausable(errand, browser),
      requestApproval: async (input) => {
        errand.view.state = "waiting_on_you";
        try {
          const answer = await hooks.requestApproval(input);
          // Stop started while the decision came in: the approval is not acted on.
          return errand.stopping ? "stopped" : answer;
        } catch (error) {
          // The approval could not be recorded or withdrawn; the errand must not act without one.
          stopApprovalUnrecorded(errand, error);
          return "stopped";
        } finally {
          this.settleState(errand);
          // Answered, from whichever surface: the channel messages that asked lose their buttons.
          this.clearAnsweredButtons(errand);
        }
      },
      afterApprovedAction: async (png) => {
        try {
          await hooks.afterApprovedAction(png);
        } catch (error) {
          // The approved action's "after" evidence could not be stored: stop rather than act on without it. The
          // rethrow ends the loop, which sees the abort and reports "stopped", not the raw storage error.
          stopApprovalUnrecorded(errand, error);
          throw new Error(BROWSER_ERRAND_APPROVAL_UNRECORDED_SUMMARY, { cause: error });
        }
      },
      lastDenialReason: hooks.lastDenialReason,
      waitForHandBack: (reason) => this.waitForHandBack(errand, browser, reason),
      onProgress: (progress: ErrandProgress) => {
        errand.view.stepCount = progress.step;
        errand.view.stepText = progress.text;
        if (progress.modelScreenshotPng && progress.step - lastThumbnailStep >= ERRAND_THUMBNAIL_EVERY_STEPS) {
          lastThumbnailStep = progress.step;
          uploads.push(
            upload("errand-step.png", progress.modelScreenshotPng)
              .then((attachmentId) => {
                errand.view.thumbnailAttachmentId = attachmentId;
              })
              .catch(() => undefined),
          );
        }
        if (errand.view.state === "running") {
          void this.renderDriving(browser, `${ERRAND_BANNER_TEXT} · step ${progress.step}`).catch(() => undefined);
        }
      },
      // Time the operator spends driving the window does not count against the errand's time limit.
      now: () => realNow() - errand.takenOverMs - (errand.takenOverSince ? realNow() - errand.takenOverSince : 0),
      signal,
    };

    try {
      await this.renderDriving(browser, ERRAND_BANNER_TEXT);
      const loopOutcome = await (this.deps.runLoop ?? runErrandLoop)(loopDeps, { goal: ids.goal });
      const outcome: ErrandOutcome = errand.windowClosed
        ? { ...loopOutcome, status: "window_closed", summary: BROWSER_ERRAND_WINDOW_CLOSED_SUMMARY }
        : errand.approvalUnrecorded
          ? { ...loopOutcome, summary: BROWSER_ERRAND_APPROVAL_UNRECORDED_SUMMARY }
          : loopOutcome;
      await Promise.all(uploads);
      let finalScreenshotAttachmentId: string | undefined;
      if (outcome.finalScreenshotPng && !errand.windowClosed) {
        finalScreenshotAttachmentId = await upload("errand-final.png", outcome.finalScreenshotPng).catch(
          () => undefined,
        );
      }
      if (finalScreenshotAttachmentId) {
        errand.view.finalAttachmentId = finalScreenshotAttachmentId;
      }
      this.finishView(errand, outcome.status, outcome.summary);
      // A disposed service (the Gateway is shutting down) sends nothing more to channels.
      if (!this.disposed) {
        void this.channelReplies?.notices
          ?.finished(errand.origin, {
            sessionId: request.sessionId,
            ...(finalScreenshotAttachmentId ? { finalScreenshotAttachmentId } : {}),
          })
          .catch(warnErrandNoticeFailure(errand.origin.kind === "channel" ? errand.origin.connectionId : undefined));
      }
      errand.view.stepCount = outcome.steps;
      errand.view.modelRequests = outcome.modelRequests;
      return {
        outcome: outcome.status,
        ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}),
        summary: outcome.summary,
        steps: outcome.steps,
        modelRequests: outcome.modelRequests,
        visitedUrls: [...outcome.visitedUrls],
        ...(finalScreenshotAttachmentId ? { finalScreenshotAttachmentId } : {}),
      };
    } finally {
      // A delivery recorded after its approval was answered loses its buttons when the errand ends.
      this.clearAnsweredButtons(errand);
      offClosed();
      offOverlay();
      if (!browser.isClosed()) {
        // The window stays on the final page with GoatCitadel's overlay gone.
        await browser.overlay.render({ mode: "hidden" }).catch(() => undefined);
      }
      if (browser.isClosed() && this.browser === browser) {
        this.browser = undefined;
      }
    }
  }

  /** While the operator has taken over, the loop waits before it looks at or touches the page again. */
  private pausable(errand: ActiveErrand, browser: ErrandBrowser): ErrandLoopDeps["browser"] {
    const untilHandedBack = async (): Promise<void> => {
      if (errand.takenOverSince !== undefined && !errand.controller.signal.aborted) {
        await new Promise<"resumed" | "stopped">((resolve) => errand.handBackWaiters.add(resolve));
      }
    };
    return {
      overlay: browser.overlay,
      currentUrl: () => browser.currentUrl(),
      describeTarget: (x, y) => browser.describeTarget(x, y),
      describeFocused: () => browser.describeFocused(),
      captureForPeople: () => browser.captureForPeople(),
      captureForModel: async () => {
        await untilHandedBack();
        errand.takeoversAtCapture = errand.takeovers;
        return await browser.captureForModel();
      },
      runActions: async (actions, beforeAction) => {
        await untilHandedBack();
        if (errand.takeovers !== errand.takeoversAtCapture) {
          // The operator took over after the screenshot this batch was planned from, so the page may have changed:
          // none of it runs, and the loop looks again before the next plan.
          return { ran: 0, halted: true, error: ERRAND_PLANNED_BEFORE_TAKEOVER_MESSAGE };
        }
        return await browser.runActions(actions, async (action, index) => {
          // A Take over mid-batch stops the rest of it: wait for Hand back, then let the model look again.
          if (errand.takenOverSince !== undefined) {
            await untilHandedBack();
            return "halt";
          }
          if (errand.stopping) {
            return "halt";
          }
          const takeoversBefore = errand.takeovers;
          const decision = await beforeAction(action, index);
          // Re-checked after the (possibly long) approval wait, right before the action is dispatched.
          if (errand.stopping) {
            return "halt";
          }
          if (errand.takeovers !== takeoversBefore || errand.takenOverSince !== undefined) {
            // The operator took over while the approval was prepared or awaited: the page may have changed, so the
            // action is not dispatched; wait for Hand back and let the model look again.
            await untilHandedBack();
            return "halt";
          }
          return decision;
        });
      },
    };
  }

  private onOverlayEvent(errand: ActiveErrand, browser: ErrandBrowser, event: ErrandOverlayEvent, now: () => number) {
    switch (event.type) {
      case "stop":
        void this.stop(errand.view.errandId, ERRAND_WINDOW_ACTOR_ID).catch(() => undefined);
        return;
      case "take_over":
        if (errand.takenOverSince === undefined && errand.handBackWaiters.size === 0) {
          errand.takenOverSince = now();
          errand.takeovers += 1;
          errand.view.state = "taken_over";
          void browser.overlay
            .render({ mode: "taken_over", bannerText: ERRAND_TAKEN_OVER_BANNER_TEXT })
            // Best-effort: the banner is cosmetic; the pause itself is enforced by the Gateway.
            .catch(() => undefined);
        }
        return;
      case "hand_back":
        if (errand.takenOverSince !== undefined) {
          errand.takenOverMs += now() - errand.takenOverSince;
          errand.takenOverSince = undefined;
        }
        this.resolveHandBack(errand, "resumed");
        errand.view.state = "running";
        void this.renderDriving(browser, ERRAND_BANNER_TEXT).catch(() => undefined);
        return;
      default:
        // Approve and Not now belong to the approval gate.
        return;
    }
  }

  private async waitForHandBack(
    errand: ActiveErrand,
    browser: ErrandBrowser,
    reason: "sign_in" | "bot_check" | "operator",
  ): Promise<"resumed" | "stopped"> {
    if (errand.controller.signal.aborted) {
      return "stopped";
    }
    errand.view.state = reason === "operator" ? "taken_over" : "waiting_on_you";
    // Wait before drawing the banner, so a Stop, window close or Hand back during the render still reaches this wait.
    const handedBack = new Promise<"resumed" | "stopped">((resolve) => errand.handBackWaiters.add(resolve));
    await browser.overlay
      .render(
        reason === "sign_in"
          ? { mode: "sign_in", bannerText: ERRAND_SIGN_IN_BANNER_TEXT }
          : { mode: "taken_over", bannerText: ERRAND_TAKEN_OVER_BANNER_TEXT },
      )
      .catch(() => undefined);
    if (errand.controller.signal.aborted) {
      this.resolveHandBack(errand, "stopped");
    }
    // A sign-in or bot-check pause tells the operator's channel, unless Stop already ended it during the render; the
    // notice is withdrawn once the pause ends.
    const cancelNotice =
      reason === "operator" || errand.controller.signal.aborted
        ? undefined
        : this.channelReplies?.notices?.signInPaused(errand.origin, reason);
    try {
      return await handedBack;
    } finally {
      cancelNotice?.();
    }
  }

  /**
   * Takes the buttons off every channel message this errand has asked with so far, once each; it runs when an approval
   * is answered, so none of them is still waiting. Best effort, in the background, never failing the errand.
   */
  private clearAnsweredButtons(errand: ActiveErrand): void {
    void this.clearDeliveredButtons(errand, errand.deliveries).catch(warnErrandButtonClearFailure);
  }

  private async clearDeliveredButtons(
    errand: ActiveErrand | undefined,
    deliveries: readonly ErrandTrackedDelivery[],
  ): Promise<void> {
    const clearButtons = this.channelReplies?.clearButtons;
    if (!clearButtons || this.disposed) return;
    const ready = await Promise.all(
      deliveries.map(async (item): Promise<ErrandTrackedDelivery | undefined> => {
        if (item.buttons !== true || errand?.buttonsCleared.has(item.deliveryRunId)) return undefined;
        let messageId: string | undefined;
        try {
          messageId = (await item.providerMessageId?.())?.trim();
        } catch (error) {
          warnErrandButtonClearFailure(error);
          return undefined;
        }
        // An unfinished send is not a cleanup attempt. The post-completion hook will revisit it.
        if (!messageId || errand?.buttonsCleared.has(item.deliveryRunId)) return undefined;
        errand?.buttonsCleared.add(item.deliveryRunId);
        return { ...item, providerMessageId: async () => messageId };
      }),
    );
    const delivered = ready.filter((item): item is ErrandTrackedDelivery => item !== undefined);
    if (delivered.length > 0) await clearButtons(delivered);
  }

  private resolveHandBack(errand: ActiveErrand, answer: "resumed" | "stopped"): void {
    const waiters = [...errand.handBackWaiters];
    errand.handBackWaiters.clear();
    for (const resolve of waiters) {
      resolve(answer);
    }
  }

  private settleState(errand: ActiveErrand): void {
    if (errand.view.state !== "finished") {
      errand.view.state = errand.takenOverSince !== undefined ? "taken_over" : "running";
    }
  }

  /** Never rejects. */
  private async renderDriving(browser: ErrandBrowser, bannerText: string): Promise<void> {
    await browser.overlay
      .render({ mode: "driving", bannerText, cursor: { ...VIEWPORT_CENTER } })
      // Best-effort: the banner is cosmetic and never stops the errand.
      .catch(() => undefined);
  }

  private finishView(errand: ActiveErrand, outcome: ErrandOutcome["status"], summary: string): void {
    errand.view.state = "finished";
    errand.view.outcome = outcome;
    errand.view.summary = summary;
  }

  private remember(view: ErrandStatusView): void {
    this.views.set(view.toolRunId, view);
    while (this.views.size > STATUS_HISTORY_LIMIT) {
      const oldest = this.views.keys().next().value;
      if (oldest === undefined) break;
      this.views.delete(oldest);
    }
  }

  private async settleWithin(settled: Promise<void> | undefined, ms: number): Promise<void> {
    if (!settled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
    await Promise.race([settled, bound]);
    clearTimeout(timer);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (!this.browser || this.active || this.disposed) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.active) return;
      const browser = this.browser;
      this.browser = undefined;
      void browser?.close().catch(() => undefined);
    }, this.deps.idleCloseMs ?? ERRAND_IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }
}
