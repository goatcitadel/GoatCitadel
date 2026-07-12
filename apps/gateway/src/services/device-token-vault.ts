/**
 * In-memory, single-use vault for approved device-access tokens.
 *
 * SECURITY: the approved device token is an operator-equivalent credential.
 * It must NEVER be persisted in plaintext at rest. Instead, the approval flow
 * stashes the plaintext here keyed by `requestId`; the status-poll delivery
 * path claims it exactly once and hands it to the waiting device, after which
 * the entry is gone. If the gateway restarts (or the entry expires) the token
 * is simply unavailable — the device keeps waiting / re-requests, which is the
 * same observable framing as "approved, awaiting secure handoff".
 *
 * This holds no disk state on purpose. A claim is destructive (single-use),
 * mirroring the previous "null the column after delivery" semantics.
 */

export interface DeviceTokenVaultEntry {
  readonly token: string;
  /** Epoch milliseconds. The entry is invalid once the authoritative clock passes this. */
  readonly expiresAt: number;
  /** Original ISO expiry, surfaced to the device in the status response. */
  readonly expiresAtIso?: string;
}

export interface DeviceTokenClaim {
  readonly token: string;
  readonly deviceTokenExpiresAt?: string;
}

export interface DeviceTokenVaultOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class DeviceTokenVault {
  private readonly entries = new Map<string, DeviceTokenVaultEntry>();
  private readonly now: () => number;

  constructor(options: DeviceTokenVaultOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Stash a plaintext token for later single-use delivery. Overwrites any
   * prior entry for the same request id (re-approval is not expected, but a
   * later approval should win).
   */
  public store(requestId: string, token: string, expiresAtIso?: string, authoritativeNowMs = this.now()): void {
    const expiresAt = parseExpiry(expiresAtIso);
    if (!Number.isFinite(authoritativeNowMs)) {
      this.entries.delete(requestId);
      return;
    }
    // Opportunistic cleanup so a never-polled approval cannot leak forever.
    this.sweep(authoritativeNowMs);
    if (expiresAt === undefined || authoritativeNowMs >= expiresAt) {
      this.entries.delete(requestId);
      return;
    }
    this.entries.set(requestId, { token, expiresAt, expiresAtIso });
  }

  /**
   * Atomically read-and-remove the token for a request id. Returns `undefined`
   * when the entry is absent (already delivered, never stored, or gateway
   * restarted) or expired. Single-use by construction.
   */
  public claim(requestId: string, authoritativeNowMs = this.now()): DeviceTokenClaim | undefined {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(requestId);
    if (!Number.isFinite(authoritativeNowMs) || authoritativeNowMs >= entry.expiresAt) {
      return undefined;
    }
    return { token: entry.token, deviceTokenExpiresAt: entry.expiresAtIso };
  }

  /** Whether a (non-expired) token is currently held for the request id. */
  public has(requestId: string, authoritativeNowMs = this.now()): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return false;
    }
    if (!Number.isFinite(authoritativeNowMs) || authoritativeNowMs >= entry.expiresAt) {
      this.entries.delete(requestId);
      return false;
    }
    return true;
  }

  /** Remove an entry without delivering it (e.g. rejection/cleanup). */
  public delete(requestId: string): void {
    this.entries.delete(requestId);
  }

  /** Drop every entry whose TTL has elapsed. Safe to call frequently. */
  public sweep(authoritativeNowMs = this.now()): void {
    if (!Number.isFinite(authoritativeNowMs)) {
      this.entries.clear();
      return;
    }
    for (const [requestId, entry] of this.entries) {
      if (authoritativeNowMs >= entry.expiresAt) {
        this.entries.delete(requestId);
      }
    }
  }

  /** Number of live (not-yet-claimed) entries. Test/diagnostics aid. */
  public get size(): number {
    return this.entries.size;
  }
}

function parseExpiry(expiresAtIso?: string): number | undefined {
  if (expiresAtIso) {
    const parsed = Date.parse(expiresAtIso);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  // An operator-equivalent credential without a valid TTL must never be held.
  return undefined;
}
