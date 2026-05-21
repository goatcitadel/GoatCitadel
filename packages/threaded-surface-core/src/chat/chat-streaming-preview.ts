export interface ChatStreamingPreview {
  sessionId: string;
  turnId: string;
  messageId?: string;
  text: string;
  visibleText: string;
  isRunning: boolean;
  updatedAt: number;
}

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
  noNewlineRevealChars?: number;
  isReducedMotion?: () => boolean;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface ResolveVisibleStreamingTextOptions {
  force?: boolean;
  reducedMotion?: boolean;
  noNewlineRevealDelayMs?: number;
  noNewlineRevealChars?: number;
}

const DEFAULT_MAX_DELAY_MS = 50;
const DEFAULT_NO_NEWLINE_DELAY_MS = 250;
const DEFAULT_NO_NEWLINE_CHARS = 80;

export function isReducedMotionPreferred(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}

export function resolveVisibleStreamingText(
  text: string,
  startedAt: number,
  now: number,
  options: ResolveVisibleStreamingTextOptions = {},
): string {
  if (!text || options.force || options.reducedMotion) {
    return text;
  }
  const lastNewlineIndex = text.lastIndexOf("\n");
  if (lastNewlineIndex >= 0) {
    return text.slice(0, lastNewlineIndex + 1);
  }
  const revealDelay = options.noNewlineRevealDelayMs ?? DEFAULT_NO_NEWLINE_DELAY_MS;
  const revealChars = options.noNewlineRevealChars ?? DEFAULT_NO_NEWLINE_CHARS;
  if (now - startedAt >= revealDelay || text.length >= revealChars) {
    return text;
  }
  return "";
}

export class ChatStreamingPreviewBuffer {
  private readonly onFlush: (preview: ChatStreamingPreview | null) => void;
  private readonly now: () => number;
  private readonly maxDelayMs: number;
  private readonly noNewlineRevealDelayMs: number;
  private readonly noNewlineRevealChars: number;
  private readonly isReducedMotion: () => boolean;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private frameHandle: number | null = null;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private seed: ChatStreamingPreviewSeed | null = null;
  private text = "";
  private visibleText = "";
  private startedAt = 0;

  constructor(options: ChatStreamingPreviewBufferOptions) {
    this.onFlush = options.onFlush;
    this.now = options.now ?? (() => Date.now());
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.noNewlineRevealDelayMs = options.noNewlineRevealDelayMs ?? DEFAULT_NO_NEWLINE_DELAY_MS;
    this.noNewlineRevealChars = options.noNewlineRevealChars ?? DEFAULT_NO_NEWLINE_CHARS;
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
    if (!options.forceVisible && snapshot.visibleText !== snapshot.text && snapshot.text.lastIndexOf("\n") < 0) {
      const elapsedMs = snapshot.updatedAt - this.startedAt;
      const delayMs = Math.max(0, this.noNewlineRevealDelayMs - elapsedMs);
      this.timerHandle = this.setTimer(() => {
        this.timerHandle = null;
        this.flush();
      }, delayMs);
    }
    return snapshot;
  }

  finish(options: { clear?: boolean; forceVisible?: boolean } = {}): ChatStreamingPreview | null {
    const snapshot = this.flush({ forceVisible: options.forceVisible ?? true });
    if (options.clear !== false) {
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

  private scheduleFlush(): void {
    if (this.frameHandle === null) {
      this.frameHandle = this.requestFrame(() => {
        this.frameHandle = null;
        this.flush();
      });
    }
    if (this.timerHandle === null) {
      this.timerHandle = this.setTimer(() => {
        this.timerHandle = null;
        this.flush();
      }, this.maxDelayMs);
    }
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
    this.visibleText = resolveVisibleStreamingText(this.text, this.startedAt, updatedAt, {
      force: forceVisible,
      reducedMotion: this.isReducedMotion(),
      noNewlineRevealDelayMs: this.noNewlineRevealDelayMs,
      noNewlineRevealChars: this.noNewlineRevealChars,
    });
    return {
      sessionId: this.seed.sessionId,
      turnId: this.seed.turnId,
      messageId: this.seed.messageId,
      text: this.text,
      visibleText: this.visibleText,
      isRunning: true,
      updatedAt,
    };
  }
}
