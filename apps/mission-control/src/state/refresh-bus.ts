export type RefreshTopic =
  | "surface"
  | "quality"
  | "dashboard"
  | "chat"
  | "promptLab"
  | "approvals"
  | "tools"
  | "files"
  | "memory"
  | "agents"
  | "skills"
  | "mcp"
  | "tasks"
  | "improvement"
  | "integrations"
  | "npu"
  | "llamaCpp"
  | "system";

export interface RefreshSignal {
  topic: RefreshTopic;
  timestamp: number;
  reason: string;
  source?: string;
  eventType?: string;
  eventId?: string;
}

type RefreshHandler = (signal: RefreshSignal) => void;

const listeners = new Map<RefreshTopic, Set<RefreshHandler>>();

export function emitRefresh(
  topic: RefreshTopic,
  input: Omit<RefreshSignal, "topic" | "timestamp"> & { timestamp?: number },
): void {
  const signal: RefreshSignal = {
    topic,
    timestamp: input.timestamp ?? Date.now(),
    reason: input.reason,
    source: input.source,
    eventType: input.eventType,
    eventId: input.eventId,
  };

  const handlers = listeners.get(topic);
  if (!handlers || handlers.size === 0) {
    return;
  }

  for (const handler of handlers) {
    try {
      handler(signal);
    } catch {
      // Ignore subscriber errors so one bad callback cannot block others.
    }
  }
}

export function subscribeRefresh(topic: RefreshTopic, handler: RefreshHandler): () => void {
  const handlers = listeners.get(topic) ?? new Set<RefreshHandler>();
  handlers.add(handler);
  listeners.set(topic, handlers);

  return () => {
    const current = listeners.get(topic);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      listeners.delete(topic);
    }
  };
}
