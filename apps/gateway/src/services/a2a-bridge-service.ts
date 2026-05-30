import { createHash, randomUUID } from "node:crypto";
import type {
  A2ABridgeAgentCard,
  A2ABridgeGovernance,
  A2ABridgeStatusResponse,
  A2ATaskExportPreviewRequest,
  A2ATaskExportPreviewResponse,
} from "@goatcitadel/contracts";

const A2A_BRIDGE_PROTOCOL_VERSION = "goatcitadel-a2a-bridge-preview-1";
const A2A_PROTOCOL_VERSION = "1.0";
const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

export function buildA2ABridgeStatus(input: { checkedAt: string; baseUrl?: string }): A2ABridgeStatusResponse {
  const governance = buildA2ABridgeGovernance();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  return {
    status: "preview_ready",
    checkedAt: input.checkedAt,
    agentCard: buildA2AAgentCard({ baseUrl, governance }),
    previewRoutes: {
      agentCard: `${baseUrl}/api/v1/a2a/agent-card`,
      taskPreview: `${baseUrl}/api/v1/a2a/task-preview`,
    },
    governance,
  };
}

export function buildA2ATaskExportPreview(
  input: A2ATaskExportPreviewRequest,
  options: { checkedAt: string },
): A2ATaskExportPreviewResponse {
  const goal = input.goal.trim();
  const exportId = `a2a-preview-${randomUUID()}`;
  const contextId = input.sessionId?.trim() || input.taskId?.trim() || exportId;
  const artifactRefs = normalizeArtifactRefs(input.artifactRefs);
  return {
    exportId,
    checkedAt: options.checkedAt,
    status: "preview",
    governance: buildA2ABridgeGovernance(),
    warnings: [
      "Preview only: no A2A client request, webhook, or remote task mutation was sent.",
      "A replay-safe external side-effect runner is still required before A2A is callable.",
    ],
    task: {
      id: exportId,
      contextId,
      status: {
        state: "submitted",
        timestamp: options.checkedAt,
      },
      messages: [
        {
          role: "user",
          parts: [{ kind: "text", text: goal }],
        },
      ],
      artifacts: artifactRefs.map((ref, index) => ({
        artifactId: `artifact-${index + 1}`,
        name: ref,
        uri: ref,
        parts: [
          {
            kind: "data",
            data: {
              ref,
              source: "goatcitadel_artifact_ref",
            },
          },
        ],
      })),
      metadata: {
        bridge: "goatcitadel-a2a",
        sourceSurface: input.sourceSurface ?? "chat",
        workspaceId: input.workspaceId ?? "default",
        projectId: input.projectId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        payloadHash: hashPreviewPayload({
          goal,
          artifactRefs,
          projectId: input.projectId,
          sessionId: input.sessionId,
          taskId: input.taskId,
        }),
      },
    },
  };
}

function buildA2AAgentCard(input: { baseUrl?: string; governance: A2ABridgeGovernance }): A2ABridgeAgentCard {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  return {
    name: "GoatCitadel Mission Control",
    description:
      "Draft operator-governed A2A bridge preview for mapping GoatCitadel tasks, artifacts, and runtime proof into an agent interoperability envelope.",
    version: A2A_BRIDGE_PROTOCOL_VERSION,
    publicationStatus: "draft_operator_preview",
    discoveryPublished: false,
    supportedInterfaces: [
      {
        url: `${baseUrl}/api/v1/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        enabled: false,
        reason: "Inbound JSON-RPC is not enabled until policy, approvals, durable task lifecycle, and audit are wired.",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
      extendedAgentCard: false,
      extensions: [],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "goatcitadel.task_export_preview",
        name: "Task Export Preview",
        description:
          "Builds a reviewable A2A-style task envelope from a GoatCitadel goal, session, project, task, and artifact references without sending it externally.",
        tags: ["task-export", "artifacts", "operator-review", "governed-preview"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
      },
    ],
    security: [{ operatorBearer: [] }],
    governance: input.governance,
  };
}

function buildA2ABridgeGovernance(): A2ABridgeGovernance {
  return {
    exposure: "operator_api_only",
    callable: false,
    approvalRequired: true,
    outboundNetworkEnabled: false,
    inboundJsonRpcEnabled: false,
    replayPolicy: "preview_only",
    audit: "gateway_route",
    reasons: [
      "A2A bridge preview stays behind operator-authenticated gateway routes.",
      "Outbound A2A client calls, inbound JSON-RPC handlers, streaming, and push notifications remain disabled.",
      "Future callable A2A work must pass through gateway-owned policy, approvals, durable execution, and audit.",
    ],
  };
}

function normalizeArtifactRefs(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

function hashPreviewPayload(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_BASE_URL;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}
