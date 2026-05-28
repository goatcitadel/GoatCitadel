export type ChatStreamStatus = "idle" | "connecting" | "streaming" | "queued" | "error";

interface ChatStreamStatusBarProps {
  mode?: "chat" | "cowork" | "code";
  status: ChatStreamStatus;
  queuedCount: number;
  error: string | null;
  announce?: boolean;
}

function statusLabel(status: ChatStreamStatus, queuedCount: number, mode: "chat" | "cowork" | "code"): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "connecting":
      return mode === "cowork" ? "Connecting run response..." : "Connecting...";
    case "streaming":
      return mode === "cowork"
        ? queuedCount > 0
          ? `Run response streaming (${queuedCount} queued messages)`
          : "Run response streaming..."
        : queuedCount > 0
          ? `Streaming (${queuedCount} queued)`
          : "Streaming...";
    case "queued":
      return mode === "cowork"
        ? `${queuedCount} queued message${queuedCount === 1 ? "" : "s"}`
        : `${queuedCount} message${queuedCount === 1 ? "" : "s"} queued`;
    case "error":
      return mode === "cowork" ? "Run response error" : "Error";
  }
}

function statusTone(status: ChatStreamStatus): string {
  switch (status) {
    case "idle":
      return "idle";
    case "connecting":
    case "queued":
      return "pending";
    case "streaming":
      return "active";
    case "error":
      return "error";
  }
}

export function ChatStreamStatusBar({
  mode = "chat",
  status,
  queuedCount,
  error,
  announce = true,
}: ChatStreamStatusBarProps) {
  if (status === "idle" && queuedCount === 0 && !error) {
    return null;
  }

  const tone = statusTone(status);
  const label = statusLabel(status, queuedCount, mode);

  return (
    <div
      className={`chat-stream-status-bar tone-${tone}`}
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
    >
      <span className="chat-stream-status-indicator" />
      <span className="chat-stream-status-label">{label}</span>
      {error && status === "error" ? <span className="chat-stream-status-error">{error}</span> : null}
    </div>
  );
}
