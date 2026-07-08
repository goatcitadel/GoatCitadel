export interface BotLoopGuardConfig {
  readonly maxEventsPerWindow: number;
  readonly windowSeconds: number;
  readonly cooldownSeconds: number;
  readonly enabled: boolean;
}

export interface BotLoopGuardKey {
  readonly scope: string;
  readonly conversation: string;
  readonly participantA: string;
  readonly participantB: string;
}

export type BotLoopGuardDecision =
  | { readonly action: "allow" }
  | {
      readonly action: "suppress";
      readonly reason: "rate-cap" | "cooldown";
      readonly cooldownExpiresAt: string;
    };

interface BucketState {
  events: number[];
  suppressedUntil?: number;
  lastTouched: number;
}

// U+0000 separators keep the bucket-key field boundaries unambiguous:
// channel adapters pass ids through unvalidated and some (e.g. Nextcloud
// Talk actor ids) can contain spaces. The separator must stay written as
// an escape sequence - a raw NUL byte makes ripgrep treat the file as binary.
function canonicalKey(key: BotLoopGuardKey): string {
  const [a, b] = [key.participantA, key.participantB].sort();
  return `${key.scope}\u0000${key.conversation}\u0000${a}\u0000${b}`;
}

export class ChannelBotLoopGuard {
  private readonly buckets = new Map<string, BucketState>();

  public constructor(
    private readonly config: BotLoopGuardConfig,
    private readonly now: () => number = Date.now,
  ) {}

  public decide(key: BotLoopGuardKey): BotLoopGuardDecision {
    if (!this.config.enabled) {
      return { action: "allow" };
    }
    const k = canonicalKey(key);
    const ts = this.now();
    const bucket = this.buckets.get(k) ?? { events: [], lastTouched: ts };
    bucket.lastTouched = ts;

    if (bucket.suppressedUntil && bucket.suppressedUntil > ts) {
      this.buckets.set(k, bucket);
      return {
        action: "suppress",
        reason: "cooldown",
        cooldownExpiresAt: new Date(bucket.suppressedUntil).toISOString(),
      };
    }
    bucket.suppressedUntil = undefined;

    const windowMs = this.config.windowSeconds * 1000;
    bucket.events = bucket.events.filter((t) => ts - t < windowMs);

    if (bucket.events.length >= this.config.maxEventsPerWindow) {
      bucket.suppressedUntil = ts + this.config.cooldownSeconds * 1000;
      this.buckets.set(k, bucket);
      return {
        action: "suppress",
        reason: "rate-cap",
        cooldownExpiresAt: new Date(bucket.suppressedUntil).toISOString(),
      };
    }

    bucket.events.push(ts);
    this.buckets.set(k, bucket);
    return { action: "allow" };
  }

  public inspect(key: BotLoopGuardKey): { eventsInWindow: number; suppressedUntil?: string } {
    const bucket = this.buckets.get(canonicalKey(key));
    if (!bucket) {
      return { eventsInWindow: 0 };
    }
    const windowMs = this.config.windowSeconds * 1000;
    const ts = this.now();
    const inWindow = bucket.events.filter((t) => ts - t < windowMs).length;
    return {
      eventsInWindow: inWindow,
      suppressedUntil:
        bucket.suppressedUntil && bucket.suppressedUntil > ts
          ? new Date(bucket.suppressedUntil).toISOString()
          : undefined,
    };
  }

  public gc(): number {
    const ts = this.now();
    const idleHorizonMs = (this.config.cooldownSeconds + this.config.windowSeconds) * 1000;
    let evicted = 0;
    for (const [k, bucket] of this.buckets.entries()) {
      if (ts - bucket.lastTouched > idleHorizonMs) {
        this.buckets.delete(k);
        evicted++;
      }
    }
    return evicted;
  }
}
