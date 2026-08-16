import type { ChatStreamingPreview } from "@goatcitadel/contracts";

export type { ChatStreamingPreview };

export type ChatVisualStreamMode = "smooth" | "instant";

export interface ChatStreamingPreviewSeed {
  sessionId: string;
  turnId: string;
  messageId?: string;
}

export interface ChatStreamingPreviewDelta {
  sessionId: string;
  turnId: string;
  messageId?: string;
  delta: string;
}

interface ChatStreamingPreviewBufferOptions {
  onFlush: (preview: ChatStreamingPreview | null) => void;
  now?: () => number;
  maxDelayMs?: number;
  noNewlineRevealDelayMs?: number;
  revealCharsPerFrame?: number;
  isReducedMotion?: () => boolean;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface ChatStreamingPreviewFinishOptions {
  clear?: boolean;
  forceVisible?: boolean;
  finalText?: string;
}

interface ResolveVisibleStreamingTextOptions {
  force?: boolean;
  reducedMotion?: boolean;
  previousVisibleText?: string;
  revealCharsPerFrame?: number;
}

const DEFAULT_MAX_DELAY_MS = 50;
const DEFAULT_NO_NEWLINE_DELAY_MS = 250;
const DEFAULT_REVEAL_CHARS_PER_FRAME = 18;

export const STREAM_CATCH_UP_FRAMES = 15; // drain horizon ≈ 250 ms at 60 fps
export const MAX_REVEAL_CHARS_PER_FRAME = 600; // never a wall of text in one frame

export function isReducedMotionPreferred(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}

export function resolveVisibleStreamingText(text: string, options: ResolveVisibleStreamingTextOptions = {}): string {
  if (!text || options.force || options.reducedMotion) {
    return text;
  }

  const previousVisibleText = options.previousVisibleText ?? "";
  const visiblePrefixLength = text.startsWith(previousVisibleText) ? previousVisibleText.length : 0;
  if (visiblePrefixLength >= text.length) {
    return text;
  }

  const backlog = text.length - visiblePrefixLength;
  const base = Math.max(1, options.revealCharsPerFrame ?? DEFAULT_REVEAL_CHARS_PER_FRAME);
  const adaptive = Math.min(MAX_REVEAL_CHARS_PER_FRAME, Math.max(base, Math.ceil(backlog / STREAM_CATCH_UP_FRAMES)));
  const targetLength = Math.min(text.length, visiblePrefixLength + adaptive);
  return text.slice(0, targetLength);
}

function hasHiddenStreamingText(preview: ChatStreamingPreview): boolean {
  return preview.visibleText.length < preview.text.length;
}

function resolveFallbackDelayMs(
  snapshot: ChatStreamingPreview,
  startedAt: number,
  noNewlineRevealDelayMs: number,
): number {
  if (snapshot.text.lastIndexOf("\n") >= 0) {
    return DEFAULT_MAX_DELAY_MS;
  }
  const elapsedMs = snapshot.updatedAt - startedAt;
  return Math.max(16, Math.min(DEFAULT_MAX_DELAY_MS, noNewlineRevealDelayMs - elapsedMs));
}

export class ChatStreamingPreviewBuffer {
  private readonly onFlush: (preview: ChatStreamingPreview | null) => void;
  private readonly now: () => number;
  private readonly maxDelayMs: number;
  private readonly noNewlineRevealDelayMs: number;
  private readonly revealCharsPerFrame: number;
  private readonly isReducedMotion: () => boolean;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly deferFinalClear: boolean;
  private frameHandle: number | null = null;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private seed: ChatStreamingPreviewSeed | null = null;
  private text = "";
  private visibleText = "";
  private startedAt = 0;
  private clearAfterVisible = false;

  constructor(options: ChatStreamingPreviewBufferOptions) {
    this.onFlush = options.onFlush;
    this.now = options.now ?? (() => Date.now());
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.noNewlineRevealDelayMs = options.noNewlineRevealDelayMs ?? DEFAULT_NO_NEWLINE_DELAY_MS;
    this.revealCharsPerFrame = options.revealCharsPerFrame ?? DEFAULT_REVEAL_CHARS_PER_FRAME;
    this.isReducedMotion = options.isReducedMotion ?? isReducedMotionPreferred;
    this.requestFrame =
      options.requestFrame ??
      ((callback) => {
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          return window.requestAnimationFrame(callback);
        }
        return Number(setTimeout(callback, 16));
      });
    this.cancelFrame =
      options.cancelFrame ??
      ((handle) => {
        if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(handle);
          return;
        }
        clearTimeout(handle);
      });
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.deferFinalClear = Boolean(
      options.requestFrame || (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"),
    );
  }

  start(seed: ChatStreamingPreviewSeed): ChatStreamingPreview {
    this.cancelScheduledFlush();
    this.seed = seed;
    this.text = "";
    this.visibleText = "";
    this.startedAt = this.now();
    const snapshot = this.createSnapshot(false);
    this.onFlush(snapshot);
    return snapshot;
  }

  append(delta: ChatStreamingPreviewDelta): void {
    if (!this.seed || this.seed.sessionId !== delta.sessionId || this.seed.turnId !== delta.turnId) {
      this.start({ sessionId: delta.sessionId, turnId: delta.turnId, messageId: delta.messageId });
    } else if (delta.messageId && !this.seed.messageId) {
      this.seed = { ...this.seed, messageId: delta.messageId };
    }
    this.text += delta.delta;
    this.scheduleFlush();
  }

  flush(options: { forceVisible?: boolean } = {}): ChatStreamingPreview | null {
    this.cancelScheduledFlush();
    if (!this.seed) {
      this.onFlush(null);
      return null;
    }
    const snapshot = this.createSnapshot(Boolean(options.forceVisible));
    this.onFlush(snapshot);
    const hasHiddenText = !options.forceVisible && hasHiddenStreamingText(snapshot);
    if (hasHiddenText) {
      const delayMs = resolveFallbackDelayMs(snapshot, this.startedAt, this.noNewlineRevealDelayMs);
      this.timerHandle = this.setTimer(() => {
        this.timerHandle = null;
        this.flush();
      }, delayMs);
      this.scheduleFrameFlush();
    } else if (this.clearAfterVisible) {
      this.scheduleFinalClear();
    }
    return snapshot;
  }

  finish(options: ChatStreamingPreviewFinishOptions = {}): ChatStreamingPreview | null {
    const finalTextDivergesFromVisiblePrefix =
      options.finalText !== undefined && this.visibleText.length > 0 && !options.finalText.startsWith(this.visibleText);
    if (options.finalText !== undefined) {
      this.text = options.finalText;
    }
    const shouldClear = options.clear !== false;
    const forceVisible = finalTextDivergesFromVisiblePrefix ? true : (options.forceVisible ?? true);
    const shouldDeferClear = shouldClear && !forceVisible;
    this.clearAfterVisible = shouldDeferClear;
    const snapshot = this.flush({ forceVisible });
    if (shouldClear && !shouldDeferClear && (forceVisible || !snapshot || !hasHiddenStreamingText(snapshot))) {
      this.clearAfterVisible = false;
      this.clear();
    }
    return snapshot;
  }

  clear(): void {
    this.cancelScheduledFlush();
    this.seed = null;
    this.text = "";
    this.visibleText = "";
    this.startedAt = 0;
    this.clearAfterVisible = false;
    this.onFlush(null);
  }

  dispose(): void {
    this.cancelScheduledFlush();
  }

  getSnapshot(options: { forceVisible?: boolean } = {}): ChatStreamingPreview | null {
    if (!this.seed) {
      return null;
    }
    return this.createSnapshot(Boolean(options.forceVisible));
  }

  matches(sessionId: string, turnId: string): boolean {
    return this.seed?.sessionId === sessionId && this.seed.turnId === turnId;
  }

  isSettlingFinalText(): boolean {
    return this.clearAfterVisible && this.seed !== null;
  }

  private scheduleFlush(): void {
    this.scheduleFrameFlush();
    if (this.timerHandle === null) {
      this.timerHandle = this.setTimer(() => {
        this.timerHandle = null;
        this.flush();
      }, this.maxDelayMs);
    }
  }

  private scheduleFrameFlush(): void {
    if (this.frameHandle !== null) {
      return;
    }
    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.flush();
    });
  }

  private scheduleFinalClear(): void {
    if (!this.deferFinalClear) {
      this.clearAfterVisible = false;
      this.clear();
      return;
    }
    if (this.frameHandle !== null) {
      return;
    }
    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.clearAfterVisible = false;
      this.clear();
    });
  }

  private cancelScheduledFlush(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private createSnapshot(forceVisible: boolean): ChatStreamingPreview {
    if (!this.seed) {
      throw new Error("Cannot create a streaming preview snapshot without a seed.");
    }
    const updatedAt = this.now();
    this.visibleText = resolveVisibleStreamingText(this.text, {
      force: forceVisible,
      reducedMotion: this.isReducedMotion(),
      previousVisibleText: this.visibleText,
      revealCharsPerFrame: this.revealCharsPerFrame,
    });
    return {
      sessionId: this.seed.sessionId,
      turnId: this.seed.turnId,
      messageId: this.seed.messageId,
      text: this.text,
      visibleText: this.visibleText,
      updatedAt,
    };
  }
}
