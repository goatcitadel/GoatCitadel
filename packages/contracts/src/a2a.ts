export type A2ABridgeStatus = "preview_ready" | "blocked";
export type A2ABridgeProtocolBinding = "JSONRPC";
export type A2ABridgeTaskState = "submitted" | "working" | "input_required" | "completed" | "failed" | "canceled";

export interface A2ABridgeGovernance {
  exposure: "operator_api_only";
  callable: false;
  approvalRequired: true;
  outboundNetworkEnabled: false;
  inboundJsonRpcEnabled: false;
  replayPolicy: "preview_only";
  audit: "gateway_route" | "evidence_envelope";
  reasons: string[];
}

export interface A2ABridgeAgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

export interface A2ABridgeAgentInterface {
  url: string;
  protocolBinding: A2ABridgeProtocolBinding;
  protocolVersion: "1.0";
  enabled: false;
  reason: string;
}

export interface A2ABridgeAgentCard {
  name: string;
  description: string;
  version: string;
  publicationStatus: "draft_operator_preview";
  discoveryPublished: false;
  supportedInterfaces: A2ABridgeAgentInterface[];
  capabilities: {
    streaming: false;
    pushNotifications: false;
    stateTransitionHistory: true;
    extendedAgentCard: false;
    extensions: [];
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ABridgeAgentCardSkill[];
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
  };
  governance: A2ABridgeGovernance;
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

export interface A2ABridgeMessagePart {
  kind: "text" | "data";
  text?: string;
  data?: Record<string, unknown>;
}

export interface A2ABridgeMessage {
  role: "user" | "agent";
  parts: A2ABridgeMessagePart[];
}

export interface A2ABridgeTaskArtifact {
  artifactId: string;
  name: string;
  uri?: string;
  parts: A2ABridgeMessagePart[];
}

export interface A2ABridgeTaskPreview {
  id: string;
  contextId: string;
  status: {
    state: A2ABridgeTaskState;
    timestamp: string;
  };
  messages: A2ABridgeMessage[];
  artifacts: A2ABridgeTaskArtifact[];
  metadata: Record<string, unknown>;
}

export interface A2ATaskExportPreviewResponse {
  exportId: string;
  checkedAt: string;
  status: "preview";
  task: A2ABridgeTaskPreview;
  governance: A2ABridgeGovernance;
  warnings: string[];
}
