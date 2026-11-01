import { randomUUID } from "node:crypto";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeRequest } from "@goatcitadel/contracts";
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

export const BROWSER_ERRAND_DISABLED_MESSAGE = "Browser errands are turned off. Turn on Browser errands in Settings.";
export const BROWSER_ERRAND_REMOTE_HARDENED_MESSAGE =
  "Browser errands aren't available on this GoatCitadel. They need GoatCitadel running on your own PC.";
export const BROWSER_ERRAND_CHANNEL_MESSAGE =
  "Errands from channels arrive in a later update. Start this one from Chat on your PC.";
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

type GateDeps = Pick<ErrandApprovalGateDeps, "approvals" | "storage" | "attachments" | "realtime">;

export interface BrowserErrandServiceDeps {
  isEnabled(): Promise<boolean>;
  deploymentProfile(): string;
  /** The session's channel: "mission" for Chat in Mission Control, otherwise the channel the turn came in on. */
  sessionChannel(sessionId: string): Promise<string | undefined>;
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
}

interface ActiveErrand {
  view: ErrandStatusView;
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
  /** Resolves once the run has finished its cleanup, whatever its outcome. */
  settled?: Promise<void>;
}

/** Runs one browser errand at a time in GoatCitadel's own Chrome window, for the `browser.errand` tool. */
export class BrowserErrandService {
  private active: ActiveErrand | undefined;
  private browser: ErrandBrowser | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly views = new Map<string, ErrandStatusView>();
  private disposed = false;

  public constructor(private readonly deps: BrowserErrandServiceDeps) {}

  public getStatus(toolRunId: string): ErrandStatusView | undefined {
    const view = this.views.get(toolRunId);
    return view ? { ...view } : undefined;
  }

  public async stop(errandId: string, actorId: string): Promise<boolean> {
    const errand = this.active;
    if (!errand || errand.view.errandId !== errandId) {
      return false;
    }
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
    await this.assertAllowed(request.sessionId);
    if (!turnId || !toolRunId) {
      throw new Error(BROWSER_ERRAND_NO_TURN_MESSAGE);
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
      controller: new AbortController(),
      handBackWaiters: new Set(),
      takenOverMs: 0,
      takeovers: 0,
      takeoversAtCapture: 0,
      windowClosed: false,
      approvalUnrecorded: false,
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

  private async assertAllowed(sessionId: string): Promise<void> {
    if (!(await this.deps.isEnabled())) {
      throw new Error(BROWSER_ERRAND_DISABLED_MESSAGE);
    }
    if (this.deps.deploymentProfile() === "remote_hardened") {
      throw new Error(BROWSER_ERRAND_REMOTE_HARDENED_MESSAGE);
    }
    const channel = await this.deps.sessionChannel(sessionId).catch(() => undefined);
    if (channel !== "mission") {
      throw new Error(BROWSER_ERRAND_CHANNEL_MESSAGE);
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
    const realNow = this.deps.now ?? Date.now;
    const offClosed = browser.onClosed(() => {
      errand.windowClosed = true;
      errand.controller.abort();
      this.resolveHandBack(errand, "stopped");
    });
    const offOverlay = browser.overlay.onEvent((event) => this.onOverlayEvent(errand, browser, event, realNow));
    const gate = (this.deps.createGate ?? createErrandApprovalGate)({
      ...this.deps.gate,
      sessionId: request.sessionId,
      turnId,
      toolRunId,
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      browser,
      signal,
      now: realNow,
    });
    errand.gate = gate;
    const hooks = errandLoopApprovalHooks(gate);
    const uploads: Array<Promise<void>> = [];
    let lastThumbnailStep = -ERRAND_THUMBNAIL_EVERY_STEPS;
    const upload = async (fileName: string, png: Buffer): Promise<string> =>
      (
        await this.deps.gate.attachments.upload({
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
          return await hooks.requestApproval(input);
        } catch (error) {
          // The approval could not be recorded or withdrawn; the errand must not act without one.
          // eslint-disable-next-line no-console -- bounded diagnostic; the errand stops and says why.
          console.warn("[goatcitadel] browser errand approval could not be recorded", {
            errandId: errand.view.errandId,
            error: error instanceof Error ? error.message : String(error),
          });
          errand.approvalUnrecorded = true;
          errand.controller.abort();
          return "stopped";
        } finally {
          this.settleState(errand);
        }
      },
      afterApprovedAction: hooks.afterApprovedAction,
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
          return await beforeAction(action, index);
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
    return await handedBack;
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
