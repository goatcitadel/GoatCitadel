import type { ChannelDroppedSender } from "@goatcitadel/contracts";

const DEFAULT_PER_CONNECTION = 5;
const DEFAULT_MAX_CONNECTIONS = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * A bounded, in-memory memory of the senders a channel connection turned away. It is a retained signal, not a
 * record: it clears on restart and entries expire, so setup can offer "Allow" without keeping a trail of strangers.
 */
export class ChannelDroppedSenderLog {
  private readonly now: () => Date;
  private readonly perConnection: number;
  private readonly maxConnections: number;
  private readonly ttlMs: number;
  /** Insertion order is the eviction order: a connection that drops a sender again moves to the end. */
  private readonly byConnection = new Map<string, Map<string, number>>();

  constructor(options: { now?: () => Date; perConnection?: number; maxConnections?: number; ttlMs?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.perConnection = options.perConnection ?? DEFAULT_PER_CONNECTION;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  record(entry: { connectionId: string; senderId: string }): void {
    const { connectionId, senderId } = entry;
    if (!connectionId || !senderId) return;
    const senders = this.byConnection.get(connectionId) ?? new Map<string, number>();
    this.byConnection.delete(connectionId);
    senders.delete(senderId);
    senders.set(senderId, this.now().getTime());
    while (senders.size > this.perConnection) {
      const oldest = senders.keys().next().value;
      if (oldest === undefined) break;
      senders.delete(oldest);
    }
    this.byConnection.set(connectionId, senders);
    while (this.byConnection.size > this.maxConnections) {
      const oldest = this.byConnection.keys().next().value;
      if (oldest === undefined) break;
      this.byConnection.delete(oldest);
    }
  }

  list(connectionId: string): ChannelDroppedSender[] {
    const senders = this.byConnection.get(connectionId);
    if (!senders) return [];
    const cutoff = this.now().getTime() - this.ttlMs;
    return [...senders.entries()]
      .filter(([, droppedAt]) => droppedAt >= cutoff)
      .sort((left, right) => right[1] - left[1])
      .map(([senderId, droppedAt]) => ({ senderId, droppedAt: new Date(droppedAt).toISOString() }));
  }
}
