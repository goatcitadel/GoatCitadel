export type DevDiagnosticsLevel = "debug" | "info" | "warn" | "error";

export type DevDiagnosticsCategory =
  | "ui"
  | "api"
  | "sse"
  | "refresh"
  | "chat"
  | "orchestration"
  | "gateway"
  | "tools"
  | "model"
  | "runtime"
  | "voice"
  | "meet"
  | "mcp"
  | "addons"
  | "office"
  | "dependency";

export type RuntimeDiagnosticStatus =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "degraded";

export type RuntimeDiagnosticKind =
  | "run.lifecycle"
  | "turn.lifecycle"
  | "model.call"
  | "tool.invocation"
  | "delegation.lifecycle"
  | "chat.dispatch"
  | "voice.session"
  | "meet.session"
  | "mcp.transport"
  | "dependency.report";

export interface RuntimeDiagnosticError {
  name?: string;
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface RuntimeDiagnosticLinkage {
  sessionId?: string;
  chatId?: string;
  turnId?: string;
  runId?: string;
  taskId?: string;
  stepId?: string;
  toolRunId?: string;
  meetingSessionId?: string;
}

export interface RuntimeDiagnosticEventInput {
  kind: RuntimeDiagnosticKind | string;
  status: RuntimeDiagnosticStatus;
  message: string;
  level?: DevDiagnosticsLevel;
  category?: DevDiagnosticsCategory | string;
  event?: string;
  correlationId?: string;
  linkage?: RuntimeDiagnosticLinkage;
  providerId?: string;
  modelId?: string;
  toolName?: string;
  durationMs?: number;
  error?: RuntimeDiagnosticError;
  metadata?: Record<string, unknown>;
}

export interface DevDiagnosticsEvent {
  id: string;
  timestamp: string;
  level: DevDiagnosticsLevel;
  category: DevDiagnosticsCategory | string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
  correlationId?: string;
  sessionId?: string;
  chatId?: string;
  turnId?: string;
  runId?: string;
  taskId?: string;
  stepId?: string;
  toolRunId?: string;
  meetingSessionId?: string;
  route?: string;
  providerId?: string;
  modelId?: string;
  toolName?: string;
  durationMs?: number;
  runtimeKind?: RuntimeDiagnosticKind | string;
  runtimeStatus?: RuntimeDiagnosticStatus;
  runtimeError?: RuntimeDiagnosticError;
  source: "client" | "gateway";
}

export interface DevDiagnosticsListResponse {
  items: DevDiagnosticsEvent[];
}
