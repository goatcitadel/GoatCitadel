import { createHash, randomUUID } from "node:crypto";
import type { BrowserContentGuardResult, UntrustedContentEnvelope } from "@goatcitadel/contracts";

const CANARY_PREFIX = "goatcitadel-canary";
const MAX_ACTIVE_CANARIES = 2_000;
const CANARY_TTL_MS = 6 * 60 * 60 * 1000;

export class BrowserContentGuardService {
  private readonly activeCanaries = new Map<string, number>();

  public createEnvelope(
    source: UntrustedContentEnvelope["source"],
    content: string,
    createdAt = new Date().toISOString(),
  ): UntrustedContentEnvelope {
    this.pruneActiveCanaries(Date.now());
    const canary = `${CANARY_PREFIX}-${createHash("sha256")
      .update(`${source}:${content}:${randomUUID()}`)
      .digest("hex")
      .slice(0, 20)}`;
    this.activeCanaries.set(canary, Date.now());
    this.pruneActiveCanaries(Date.now());
    return {
      envelopeId: randomUUID(),
      source,
      canary,
      contentPreview: content.slice(0, 500),
      createdAt,
    };
  }

  public scan(value: unknown): BrowserContentGuardResult {
    this.pruneActiveCanaries(Date.now());
    const serialized = serializeUnknown(value);
    const leakedCanaries = [...this.activeCanaries.keys()].filter((canary) => serialized.includes(canary));
    return {
      ok: leakedCanaries.length === 0,
      blocked: leakedCanaries.length > 0,
      leakedCanaries,
      reason: leakedCanaries.length > 0 ? "browser_content_canary_leak" : undefined,
    };
  }

  private pruneActiveCanaries(now: number): void {
    for (const [canary, createdAt] of this.activeCanaries) {
      if (now - createdAt > CANARY_TTL_MS) {
        this.activeCanaries.delete(canary);
      }
    }
    while (this.activeCanaries.size > MAX_ACTIVE_CANARIES) {
      const oldest = this.activeCanaries.keys().next().value;
      if (!oldest) {
        return;
      }
      this.activeCanaries.delete(oldest);
    }
  }
}

const DEFAULT_BROWSER_CONTENT_GUARD = new BrowserContentGuardService();

export function createUntrustedContentEnvelope(
  source: UntrustedContentEnvelope["source"],
  content: string,
): UntrustedContentEnvelope {
  return DEFAULT_BROWSER_CONTENT_GUARD.createEnvelope(source, content);
}

export function scanBrowserContentGuard(value: unknown): BrowserContentGuardResult {
  return DEFAULT_BROWSER_CONTENT_GUARD.scan(value);
}

function serializeUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
