export type A2ABridgeStatus = "preview_ready" | "not_configured" | "configured" | "callable" | "blocked";

export type A2ABridgeProtocolBinding = "JSONRPC" | "GRPC" | "HTTP_JSON";

export type A2ABridgeTaskState = "submitted" | "working" | "input_required" | "completed" | "failed" | "canceled";

export type A2ABridgePublicationStatus = "draft_operator_preview" | "private_configured" | "public_discovery";

export type A2ABridgeExposure = "operator_api_only" | "public_discovery" | "a2a_peer_jsonrpc" | "a2a_peer_gateway";

export type A2ABridgeReplayPolicy = "preview_only" | "durable_task_binding" | "idempotent_external_side_effect";

export type A2APeerCredentialStatus = "configured" | "missing_secret" | "expired" | "revoked";

export type A2AJsonRpcMethod =
  | "SendMessage"
  | "SendStreamingMessage"
  | "GetTask"
  | "CancelTask"
  | "SubscribeToTask"
  | "SetTaskPushNotificationConfig"
  | "GetTaskPushNotificationConfig"
  | "ListTaskPushNotificationConfig"
  | "DeleteTaskPushNotificationConfig"
  | "GetAuthenticatedExtendedCard";

export interface A2APeerCredentialConfig {
  peerId: string;
  label?: string;
  token?: string;
  tokenEnv?: string;
  scopes?: string[];
  expiresAt?: string;
  revokedAt?: string;
}

export interface A2APeerCredentialHealth {
  peerId: string;
  label?: string;
  status: A2APeerCredentialStatus;
  scopes: string[];
  expiresAt?: string;
  revokedAt?: string;
  checkedAt: string;
}

export interface A2AOutboundPeerConfig {
  peerId: string;
  label?: string;
  agentCardUrl: string;
  token?: string;
  tokenEnv?: string;
  enabled?: boolean;
}

export interface A2ABridgeRuntimeConfig {
  enabled: boolean;
  publicDiscoveryEnabled: boolean;
  protocolVersion: "1.0";
  bindings: A2ABridgeProtocolBinding[];
  inbound: {
    enabled: boolean;
    peerCredentials: A2APeerCredentialConfig[];
  };
  outbound: {
    enabled: boolean;
    peers: A2AOutboundPeerConfig[];
  };
}

export interface A2ABridgeGovernance {
  exposure: A2ABridgeExposure;
  callable: boolean;
  approvalRequired: boolean;
  outboundNetworkEnabled: boolean;
  inboundJsonRpcEnabled: boolean;
  inboundHttpJsonEnabled: boolean;
  replayPolicy: A2ABridgeReplayPolicy;
  audit: "gateway_route" | "durable_gateway_audit";
  reasons: string[];
}

export interface A2ABridgeAgentInterface {
  url: string;
  protocolBinding: A2ABridgeProtocolBinding;
  protocolVersion: "1.0";
  enabled: boolean;
  reason?: string;
}

export interface A2ABridgeAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

export interface A2ABridgeAgentCard {
  name: string;
  description: string;
  version: string;
  protocolVersion: "1.0";
  publicationStatus: A2ABridgePublicationStatus;
  discoveryPublished: boolean;
  supportedInterfaces: A2ABridgeAgentInterface[];
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
    extendedAgentCard: boolean;
    extensions: string[];
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ABridgeAgentSkill[];
  security: Array<Record<string, string[]>>;
  governance: A2ABridgeGovernance;
}

export interface A2ABridgeStatusResponse {
  status: A2ABridgeStatus;
  checkedAt: string;
  agentCard: A2ABridgeAgentCard;
  previewRoutes: {
    agentCard: string;
    taskPreview: string;
    jsonRpc: string;
    httpJson: string;
    authenticatedExtendedCard: string;
    publicDiscovery?: string;
    outboundPreview?: string;
    outboundSend?: string;
  };
  peerCredentials: A2APeerCredentialHealth[];
  governance: A2ABridgeGovernance;
}

export interface A2ABridgeMessageTextPart {
  kind: "text";
  text: string;
}

export interface A2ABridgeMessageDataPart {
  kind: "data";
  data: Record<string, unknown>;
}

export interface A2ABridgeMessageFilePart {
  kind: "file";
  file: {
    name?: string;
    mimeType?: string;
    uri?: string;
    bytesBase64?: string;
  };
}

export type A2ABridgeMessagePart = A2ABridgeMessageTextPart | A2ABridgeMessageDataPart | A2ABridgeMessageFilePart;

export interface A2ABridgeMessage {
  role: "user" | "agent";
  messageId?: string;
  contextId?: string;
  parts: A2ABridgeMessagePart[];
  metadata?: Record<string, unknown>;
}

export interface A2ABridgeArtifact {
  artifactId: string;
  name?: string;
  uri?: string;
  parts: A2ABridgeMessagePart[];
  metadata?: Record<string, unknown>;
}

export interface A2ABridgeTaskStatus {
  state: A2ABridgeTaskState;
  timestamp: string;
  message?: A2ABridgeMessage;
}

export interface A2ABridgeTask {
  id: string;
  contextId: string;
  status: A2ABridgeTaskStatus;
  messages: A2ABridgeMessage[];
  artifacts: A2ABridgeArtifact[];
  metadata: Record<string, unknown>;
}

export interface A2ABridgeTaskEvent {
  sequence: number;
  taskId: string;
  contextId: string;
  kind: "task.status" | "task.message" | "task.artifact";
  timestamp: string;
  status?: A2ABridgeTaskStatus;
  message?: A2ABridgeMessage;
  artifact?: A2ABridgeArtifact;
}

export type A2ATaskPushEventKind = A2ABridgeTaskEvent["kind"];

export type A2ATaskPushDeliveryStatus = "pending" | "delivered" | "retry_scheduled" | "dead_lettered" | "blocked";

export interface A2ATaskPushNotificationConfig {
  taskId: string;
  peerId: string;
  url: string;
  events: A2ATaskPushEventKind[];
  enabled: boolean;
  maxAttempts: number;
  attemptCount: number;
  lastDeliveryStatus: A2ATaskPushDeliveryStatus;
  lastDeliveryError?: string;
  lastDeliveredAt?: string;
  nextRetryAt?: string;
  lastEventSequence: number;
  auth?: {
    scheme: "bearer";
    tokenPreview?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface A2ATaskPushDeliveryResult {
  taskId: string;
  peerId: string;
  url: string;
  eventSequence: number;
  eventKind: A2ATaskPushEventKind;
  status: A2ATaskPushDeliveryStatus;
  attemptCount: number;
  checkedAt: string;
  deliveredAt?: string;
  nextRetryAt?: string;
  error?: string;
  auditRef?: string;
}

export interface A2ATaskBindingRecord {
  a2aTaskId: string;
  contextId: string;
  peerId: string;
  workspaceId: string;
  sessionId?: string;
  localTaskId?: string;
  durableRunId?: string;
  state: A2ABridgeTaskState;
  lastEventSequence: number;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface A2ATaskExportPreviewRequest {
  goal: string;
  sourceSurface?: "chat" | "cowork" | "code" | "project" | "ops" | "library";
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  artifactRefs?: string[];
}

export interface A2ATaskExportPreviewResponse {
  exportId: string;
  checkedAt: string;
  status: "preview";
  governance: A2ABridgeGovernance;
  warnings: string[];
  task: A2ABridgeTask;
}

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  method: A2AJsonRpcMethod | string;
  params?: Record<string, unknown>;
  id?: string | number | null;
}

export interface A2AJsonRpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface A2AJsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result: unknown;
}

export interface A2AJsonRpcErrorResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  error: A2AJsonRpcError;
}

export type A2AJsonRpcResponse = A2AJsonRpcSuccessResponse | A2AJsonRpcErrorResponse;

export interface A2AOutboundPreviewRequest {
  peerId: string;
  method: A2AJsonRpcMethod;
  params: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface A2AOutboundPreviewResponse {
  checkedAt: string;
  peerId: string;
  method: A2AJsonRpcMethod;
  agentCardUrl?: string;
  jsonRpcUrl?: string;
  callable: boolean;
  governance: A2ABridgeGovernance;
  warnings: string[];
  envelope: A2AJsonRpcRequest;
}

export interface A2AOutboundSendResponse {
  checkedAt: string;
  peerId: string;
  method: A2AJsonRpcMethod;
  status: "blocked" | "sent" | "replayed";
  agentCardUrl?: string;
  jsonRpcUrl?: string;
  idempotencyKey: string;
  auditRef?: string;
  response?: A2AJsonRpcResponse;
  warnings: string[];
}
