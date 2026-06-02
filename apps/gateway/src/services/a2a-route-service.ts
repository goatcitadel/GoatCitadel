import { createHash, randomUUID } from "node:crypto";
import type {
  A2ABridgeArtifact,
  A2ABridgeMessage,
  A2ABridgeMessagePart,
  A2ABridgeRuntimeConfig,
  A2ABridgeTask,
  A2ABridgeTaskEvent,
  A2ABridgeTaskState,
  A2ABridgeStatusResponse,
  A2AJsonRpcErrorResponse,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2AOutboundPreviewRequest,
  A2AOutboundPreviewResponse,
  A2AOutboundSendResponse,
  A2ATaskBindingRecord,
  A2ATaskExportPreviewRequest,
  A2ATaskExportPreviewResponse,
  ChatSendMessageResponse,
  TaskRecord,
} from "@goatcitadel/contracts";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import type { Storage } from "@goatcitadel/storage";
import type { FastifyRequest } from "fastify";
import type { GatewayRuntimeConfig } from "../config.js";
import { timingSafeStringEqual } from "./crypto-equals.js";
import { type EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import {
  buildA2ABridgeStatus,
  buildA2ATaskExportPreview,
  buildPeerCredentialHealth,
  normalizeA2AConfig,
  readPeerCredentialSecret,
} from "./a2a-bridge-service.js";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import type { ChatTurnRuntimeService } from "./chat-turn-runtime-service.js";

export interface A2APeerAuthResult {
  peerId: string;
  label?: string;
  scopes: string[];
}

export interface A2APeerAuthFailure {
  statusCode: number;
  reason: string;
  message: string;
}

export interface A2ARouteServiceDependencies {
  config: GatewayRuntimeConfig;
  storage: Storage;
  tasks: Pick<
    TaskLifecycleService,
    "appendTaskActivity" | "createTask" | "getTask" | "invokeAgenticControl" | "listTaskDeliverables" | "updateTask"
  >;
  createChatSession: (input: {
    workspaceId?: string;
    title?: string;
    tags?: string[];
    mode?: "chat" | "cowork" | "code";
    origin?: "operator" | "prompt_pack" | "system";
    includeInHistory?: boolean;
  }) => { sessionId: string };
  chatTurnRuntime: Pick<ChatTurnRuntimeService, "agentSendChatMessage">;
  mutationIdempotencyStore?: MutationIdempotencyStore;
  evidenceEnvelopeService?: Pick<EvidenceEnvelopeService, "createEnvelope">;
}

export class A2ARouteService {
  public constructor(private readonly deps: A2ARouteServiceDependencies) {}

  public getStatus(input: { checkedAt: string; baseUrl?: string }): A2ABridgeStatusResponse {
    return buildA2ABridgeStatus({
      checkedAt: input.checkedAt,
      baseUrl: input.baseUrl,
      config: this.config,
    });
  }

  public getAgentCard(input: { checkedAt: string; baseUrl?: string }) {
    return this.getStatus(input).agentCard;
  }

  public getPublicAgentCard(input: { checkedAt: string; baseUrl?: string }) {
    const config = this.config;
    if (!config.enabled || !config.publicDiscoveryEnabled) {
      return undefined;
    }
    return this.getStatus(input).agentCard;
  }

  public previewTaskExport(
    input: A2ATaskExportPreviewRequest,
    options: { checkedAt: string },
  ): A2ATaskExportPreviewResponse {
    return buildA2ATaskExportPreview(input, { checkedAt: options.checkedAt, config: this.config });
  }

  public authenticatePeerRequest(
    request: Pick<FastifyRequest, "headers">,
    checkedAt = new Date().toISOString(),
  ): A2APeerAuthResult | A2APeerAuthFailure {
    const config = this.config;
    if (!config.enabled || !config.inbound.enabled || !config.bindings.includes("JSONRPC")) {
      return {
        statusCode: 503,
        reason: "a2a_inbound_disabled",
        message: "A2A inbound JSON-RPC is not enabled.",
      };
    }
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return {
        statusCode: 401,
        reason: "a2a_peer_token_required",
        message: "A2A peer bearer credentials are required.",
      };
    }
    const health = buildPeerCredentialHealth(config.inbound.peerCredentials, checkedAt);
    for (const credential of config.inbound.peerCredentials) {
      const status = health.find((item) => item.peerId === credential.peerId);
      if (status?.status !== "configured") {
        continue;
      }
      const configuredToken = readPeerCredentialSecret(credential);
      if (configuredToken && timingSafeStringEqual(token, configuredToken)) {
        return {
          peerId: credential.peerId,
          label: credential.label,
          scopes: credential.scopes ?? ["a2a:jsonrpc"],
        };
      }
    }
    return {
      statusCode: 403,
      reason: "a2a_peer_unknown_or_inactive",
      message: "A2A peer credentials are unknown, expired, revoked, or missing their configured secret.",
    };
  }

  public async handleJsonRpc(
    peer: A2APeerAuthResult,
    body: unknown,
    checkedAt = new Date().toISOString(),
  ): Promise<A2AJsonRpcResponse> {
    const request = parseJsonRpcRequest(body);
    if (!request.ok) {
      return jsonRpcError(null, request.code, request.message);
    }
    try {
      switch (request.value.method) {
        case "SendMessage":
          return jsonRpcResult(request.value.id, {
            task: await this.sendMessage(peer, request.value.params ?? {}, checkedAt, false),
          });
        case "SendStreamingMessage": {
          const task = await this.sendMessage(peer, request.value.params ?? {}, checkedAt, true);
          return jsonRpcResult(request.value.id, {
            task,
            events: this.buildEventsForTask(task, 0, checkedAt),
          });
        }
        case "GetTask":
          return jsonRpcResult(request.value.id, {
            task: this.getA2ATask(request.value.params ?? {}, checkedAt),
          });
        case "CancelTask":
          return jsonRpcResult(request.value.id, {
            task: await this.cancelA2ATask(peer, request.value.params ?? {}, checkedAt),
          });
        case "SubscribeToTask": {
          const task = this.getA2ATask(request.value.params ?? {}, checkedAt);
          const since = readNumber(request.value.params?.lastEventSequence) ?? 0;
          return jsonRpcResult(request.value.id, {
            task,
            events: this.buildEventsForTask(task, since, checkedAt),
          });
        }
        case "SetTaskPushNotificationConfig":
        case "GetTaskPushNotificationConfig":
        case "ListTaskPushNotificationConfig":
        case "DeleteTaskPushNotificationConfig":
          return jsonRpcError(request.value.id, -32020, "A2A push notifications are not implemented.");
        case "GetAuthenticatedExtendedCard":
          return jsonRpcError(request.value.id, -32021, "Authenticated extended Agent Cards are not implemented.");
        default:
          return jsonRpcError(request.value.id, -32601, "Unsupported A2A JSON-RPC method.");
      }
    } catch (error) {
      return mapJsonRpcServiceError(request.value.id, error);
    }
  }

  public getBinding(a2aTaskId: string): A2ATaskBindingRecord | undefined {
    return this.deps.storage.a2aTaskBindings.find(a2aTaskId);
  }

  public previewOutbound(
    input: A2AOutboundPreviewRequest,
    checkedAt = new Date().toISOString(),
  ): A2AOutboundPreviewResponse {
    const peer = this.findOutboundPeer(input.peerId);
    const envelope: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      id: input.idempotencyKey ?? `a2a-out-${randomUUID()}`,
      method: input.method,
      params: input.params,
    };
    const status = this.getStatus({ checkedAt });
    const warnings = [];
    if (!this.config.enabled || !this.config.outbound.enabled) {
      warnings.push("Outbound A2A is disabled; this preview will not send network traffic.");
    }
    if (!peer) {
      warnings.push("No configured outbound peer matches this peerId.");
    }
    return {
      checkedAt,
      peerId: input.peerId,
      method: input.method,
      agentCardUrl: peer?.agentCardUrl,
      callable: Boolean(this.config.enabled && this.config.outbound.enabled && peer?.enabled !== false),
      governance: status.governance,
      warnings,
      envelope,
    };
  }

  public async sendOutbound(
    input: A2AOutboundPreviewRequest,
    actorId: string,
    checkedAt = new Date().toISOString(),
  ): Promise<A2AOutboundSendResponse> {
    const preview = this.previewOutbound(input, checkedAt);
    const idempotencyKey = input.idempotencyKey?.trim() || hashStableJson(preview.envelope);
    const peer = this.findOutboundPeer(input.peerId);
    if (!preview.callable || !peer) {
      return {
        checkedAt,
        peerId: input.peerId,
        method: input.method,
        status: "blocked",
        agentCardUrl: peer?.agentCardUrl,
        idempotencyKey,
        warnings: [...preview.warnings, "Outbound send was blocked before the external boundary."],
      };
    }

    const run = await runIdempotentExternalSideEffect<A2AJsonRpcResponse>({
      mutationStore: this.deps.mutationIdempotencyStore,
      sideEffectRunStore: this.deps.storage.externalSideEffectRuns,
      boundary: "a2a_jsonrpc_outbound",
      catalogId: "a2a",
      connectionId: peer.peerId,
      actionId: input.method,
      actorScope: actorId,
      checkedAt,
      idempotencyKey,
      payload: preview.envelope,
      label: "A2A JSON-RPC outbound call",
      output: { peerId: peer.peerId, method: input.method },
      execute: async (claim) => {
        const discovered = await this.discoverOutboundJsonRpcUrl(peer, checkedAt);
        claim.markExternalCallStarted();
        const response = await fetchAllowlisted(discovered.jsonRpcUrl, {
          allowlist: this.deps.config.toolPolicy.sandbox.networkAllowlist,
          init: {
            method: "POST",
            headers: buildOutboundHeaders(peer),
            body: JSON.stringify(preview.envelope),
          },
        });
        const payload = (await response.json().catch(() => undefined)) as unknown;
        if (!response.ok) {
          throw new Error(`A2A peer returned HTTP ${response.status}.`);
        }
        return parseJsonRpcResponse(payload);
      },
    });

    if (run.status === "blocked") {
      return {
        checkedAt,
        peerId: input.peerId,
        method: input.method,
        status: "replayed",
        agentCardUrl: peer.agentCardUrl,
        idempotencyKey,
        auditRef: run.claim.sideEffectRunId,
        warnings: [run.message],
      };
    }
    if (run.status === "failed") {
      return {
        checkedAt,
        peerId: input.peerId,
        method: input.method,
        status: "blocked",
        agentCardUrl: peer.agentCardUrl,
        idempotencyKey,
        auditRef: run.claim.sideEffectRunId,
        warnings: ["Outbound A2A send failed; error details are stored in the external side-effect ledger."],
      };
    }
    return {
      checkedAt,
      peerId: input.peerId,
      method: input.method,
      status: "sent",
      agentCardUrl: peer.agentCardUrl,
      idempotencyKey,
      auditRef: run.claim.sideEffectRunId,
      response: run.value,
      warnings: [],
    };
  }

  private get config(): A2ABridgeRuntimeConfig {
    return normalizeA2AConfig(this.deps.config.assistant.a2a);
  }

  private async sendMessage(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt: string,
    streaming: boolean,
  ): Promise<A2ABridgeTask> {
    const message = normalizeInboundMessage(params);
    const contextId = readString(params.contextId) ?? message.contextId ?? `ctx-${peer.peerId}`;
    const idempotencyKey = buildInboundIdempotencyKey(peer.peerId, contextId, message, params);
    const existing = this.deps.storage.a2aTaskBindings.findByIdempotency(peer.peerId, idempotencyKey);
    if (existing) {
      return this.buildTaskFromBinding(existing, checkedAt);
    }

    const a2aTaskId = readString(params.taskId) ?? `a2a_${hashStableJson({ peerId: peer.peerId, idempotencyKey })}`;
    const workspaceId = readString(params.workspaceId) ?? "default";
    const session = this.deps.createChatSession({
      workspaceId,
      title: `A2A: ${peer.label ?? peer.peerId}`,
      tags: ["a2a", `a2a:${peer.peerId}`],
      origin: "system",
      mode: "chat",
      includeInHistory: false,
    });
    const task = this.deps.tasks.createTask({
      workspaceId,
      title: buildTaskTitle(message, peer.peerId),
      description: "Peer-authenticated A2A message mapped into GoatCitadel durable task truth.",
      status: "in_progress",
      priority: "normal",
      createdBy: `a2a:${peer.peerId}`,
      agenticContext: {
        runId: a2aTaskId,
        parentSessionId: session.sessionId,
        surface: "chat",
        status: "running",
        providerId: "a2a",
        model: peer.peerId,
      },
    });
    let binding = this.deps.storage.a2aTaskBindings.createOrGet(
      {
        a2aTaskId,
        contextId,
        peerId: peer.peerId,
        workspaceId,
        sessionId: session.sessionId,
        localTaskId: task.taskId,
        state: "working",
        lastEventSequence: streaming ? 1 : 0,
        idempotencyKey,
        metadata: {
          inboundMessage: message,
          streaming,
          source: "a2a_jsonrpc",
          createdByPeerLabel: peer.label,
        },
      },
      checkedAt,
    );

    this.deps.tasks.appendTaskActivity(task.taskId, {
      agentId: `a2a:${peer.peerId}`,
      activityType: "spawned",
      message: "A2A peer message accepted and bound to a GoatCitadel task.",
      metadata: {
        a2aTaskId,
        contextId,
        idempotencyKey,
      },
    });

    try {
      const response = await this.deps.chatTurnRuntime.agentSendChatMessage(session.sessionId, {
        content: partsToText(message.parts),
        parts: [],
        mode: "chat",
        useMemory: true,
        operatorId: `a2a:${peer.peerId}`,
        authActorId: `a2a:${peer.peerId}`,
        authActorSource: "a2a_peer",
        policyTaskId: task.taskId,
      });
      const durableRunId = readDurableRunId(response);
      if (durableRunId) {
        binding = this.deps.storage.a2aTaskBindings.update(binding.a2aTaskId, {
          durableRunId,
          metadata: {
            ...binding.metadata,
            chatTurnId: response.turnId,
            durableRunId,
          },
        });
      }
    } catch (error) {
      this.deps.tasks.updateTask(task.taskId, {
        status: "blocked",
        agenticContext: {
          ...(task.agenticContext ?? {}),
          status: "failed",
          failureClass: "other",
          diagnostics: [
            {
              signalId: `a2a-dispatch-${binding.a2aTaskId}`,
              code: "provider_fallback_loop",
              severity: "critical",
              title: "A2A dispatch failed",
              summary: error instanceof Error ? error.message : "A2A dispatch failed.",
              createdAt: checkedAt,
            },
          ],
        },
      });
      binding = this.deps.storage.a2aTaskBindings.update(binding.a2aTaskId, { state: "failed" });
    }

    return this.buildTaskFromBinding(binding, checkedAt);
  }

  private getA2ATask(params: Record<string, unknown>, checkedAt: string): A2ABridgeTask {
    const taskId = readString(params.taskId) ?? readString(params.id);
    if (!taskId) {
      throw new A2AJsonRpcServiceError(-32602, "taskId is required.");
    }
    const binding = this.deps.storage.a2aTaskBindings.find(taskId);
    if (!binding) {
      throw new A2AJsonRpcServiceError(-32004, "A2A task binding was not found.");
    }
    return this.buildTaskFromBinding(binding, checkedAt);
  }

  private async cancelA2ATask(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt: string,
  ): Promise<A2ABridgeTask> {
    const taskId = readString(params.taskId) ?? readString(params.id);
    if (!taskId) {
      throw new A2AJsonRpcServiceError(-32602, "taskId is required.");
    }
    const binding = this.deps.storage.a2aTaskBindings.find(taskId);
    if (!binding) {
      throw new A2AJsonRpcServiceError(-32004, "A2A task binding was not found.");
    }
    if (binding.localTaskId) {
      this.deps.tasks.updateTask(binding.localTaskId, { status: "blocked" });
      this.deps.tasks.appendTaskActivity(binding.localTaskId, {
        agentId: `a2a:${peer.peerId}`,
        activityType: "control",
        message: "A2A peer requested task cancellation.",
        metadata: { a2aTaskId: taskId },
      });
    }
    if (binding.durableRunId) {
      await Promise.resolve(
        this.deps.tasks.invokeAgenticControl(binding.durableRunId, {
          action: "cancel",
          reason: "A2A peer requested cancellation.",
          actorId: `a2a:${peer.peerId}`,
        }),
      ).catch(() => undefined);
    }
    const updated = this.deps.storage.a2aTaskBindings.update(
      taskId,
      {
        state: "canceled",
        lastEventSequence: binding.lastEventSequence + 1,
      },
      checkedAt,
    );
    return this.buildTaskFromBinding(updated, checkedAt);
  }

  private buildTaskFromBinding(binding: A2ATaskBindingRecord, checkedAt: string): A2ABridgeTask {
    const localTask = binding.localTaskId ? readTaskMaybe(this.deps.tasks, binding.localTaskId) : undefined;
    const statusState = localTask ? mapTaskStatusToA2AState(localTask.status, binding.state) : binding.state;
    const message = readInboundMessageFromBinding(binding);
    const artifacts = binding.localTaskId ? this.readArtifacts(binding.localTaskId) : [];
    return {
      id: binding.a2aTaskId,
      contextId: binding.contextId,
      status: {
        state: statusState,
        timestamp: localTask?.updatedAt ?? binding.updatedAt ?? checkedAt,
      },
      messages: message ? [message] : [],
      artifacts,
      metadata: {
        bridge: "goatcitadel-a2a",
        peerId: binding.peerId,
        workspaceId: binding.workspaceId,
        localTaskId: binding.localTaskId,
        sessionId: binding.sessionId,
        durableRunId: binding.durableRunId,
        idempotencyKey: binding.idempotencyKey,
        localTaskStatus: localTask?.status,
      },
    };
  }

  private buildEventsForTask(task: A2ABridgeTask, since: number, checkedAt: string): A2ABridgeTaskEvent[] {
    const events: A2ABridgeTaskEvent[] = [
      {
        sequence: Math.max(1, since + 1),
        taskId: task.id,
        contextId: task.contextId,
        kind: "task.status",
        timestamp: checkedAt,
        status: task.status,
      },
    ];
    const firstMessage = task.messages[0];
    if (firstMessage) {
      events.push({
        sequence: events[events.length - 1]!.sequence + 1,
        taskId: task.id,
        contextId: task.contextId,
        kind: "task.message",
        timestamp: checkedAt,
        message: firstMessage,
      });
    }
    for (const artifact of task.artifacts) {
      events.push({
        sequence: events[events.length - 1]!.sequence + 1,
        taskId: task.id,
        contextId: task.contextId,
        kind: "task.artifact",
        timestamp: checkedAt,
        artifact,
      });
    }
    const binding = this.deps.storage.a2aTaskBindings.find(task.id);
    if (binding && events.length > 0) {
      this.deps.storage.a2aTaskBindings.update(task.id, {
        lastEventSequence: events[events.length - 1]!.sequence,
      });
    }
    return events.filter((event) => event.sequence > since);
  }

  private readArtifacts(taskId: string): A2ABridgeArtifact[] {
    return this.deps.tasks.listTaskDeliverables(taskId, 100).map((deliverable, index) => ({
      artifactId: deliverable.deliverableId,
      name: deliverable.title || `artifact-${index + 1}`,
      uri: deliverable.path,
      parts: [
        {
          kind: "data",
          data: {
            deliverableType: deliverable.deliverableType,
            path: deliverable.path,
            description: deliverable.description,
          },
        },
      ],
      metadata: {
        localTaskId: taskId,
      },
    }));
  }

  private findOutboundPeer(peerId: string) {
    return this.config.outbound.peers.find((peer) => peer.peerId === peerId && peer.enabled !== false);
  }

  private async discoverOutboundJsonRpcUrl(
    peer: NonNullable<ReturnType<A2ARouteService["findOutboundPeer"]>>,
    checkedAt: string,
  ): Promise<{ jsonRpcUrl: string }> {
    const response = await fetchAllowlisted(peer.agentCardUrl, {
      allowlist: this.deps.config.toolPolicy.sandbox.networkAllowlist,
      init: {
        method: "GET",
        headers: buildOutboundHeaders(peer),
      },
    });
    if (!response.ok) {
      throw new Error(`A2A Agent Card discovery returned HTTP ${response.status}.`);
    }
    const card = (await response.json()) as {
      supportedInterfaces?: Array<{ protocolBinding?: string; enabled?: boolean; url?: string }>;
    };
    const jsonRpc = card.supportedInterfaces?.find(
      (item) => item.protocolBinding === "JSONRPC" && item.enabled !== false && item.url,
    );
    if (!jsonRpc?.url) {
      throw new Error("A2A peer does not expose a callable JSON-RPC interface.");
    }
    this.deps.evidenceEnvelopeService?.createEnvelope({
      eventKind: "external_writeback",
      metadata: {
        boundary: "a2a_agent_card_discovery",
        peerId: peer.peerId,
        agentCardUrlHash: hashStableJson(peer.agentCardUrl),
        jsonRpcUrlHash: hashStableJson(jsonRpc.url),
      },
      createdAt: checkedAt,
    });
    return { jsonRpcUrl: jsonRpc.url };
  }
}

class A2AJsonRpcServiceError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function parseJsonRpcRequest(
  value: unknown,
): { ok: true; value: A2AJsonRpcRequest } | { ok: false; code: number; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: -32600, message: "Invalid JSON-RPC request." };
  }
  const candidate = value as Partial<A2AJsonRpcRequest>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") {
    return { ok: false, code: -32600, message: "JSON-RPC 2.0 method is required." };
  }
  if (
    candidate.params !== undefined &&
    (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params))
  ) {
    return { ok: false, code: -32602, message: "JSON-RPC params must be an object." };
  }
  return { ok: true, value: candidate as A2AJsonRpcRequest };
}

function normalizeInboundMessage(params: Record<string, unknown>): A2ABridgeMessage {
  const rawMessage = readObject(params.message);
  const message = rawMessage ?? params;
  const rawParts = Array.isArray(message.parts) ? message.parts : undefined;
  const parts = rawParts ? rawParts.map(normalizePart).filter(isMessagePart) : undefined;
  const text = readString(message.text) ?? readString(params.text) ?? readString(params.content);
  return {
    role: readString(message.role) === "agent" ? "agent" : "user",
    messageId: readString(message.messageId) ?? readString(params.messageId) ?? readString(params.id),
    contextId: readString(message.contextId) ?? readString(params.contextId),
    parts: parts?.length ? parts : [{ kind: "text", text: text ?? "" }],
    metadata: readObject(message.metadata) ?? readObject(params.metadata),
  };
}

function normalizePart(value: unknown): A2ABridgeMessagePart | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = readString(record.kind) ?? readString(record.type);
  if (kind === "text") {
    return { kind: "text", text: readString(record.text) ?? "" };
  }
  if (kind === "data") {
    return { kind: "data", data: readObject(record.data) ?? {} };
  }
  if (kind === "file") {
    return {
      kind: "file",
      file: {
        name: readString(record.name),
        mimeType: readString(record.mimeType),
        uri: readString(record.uri),
        bytesBase64: readString(record.bytesBase64),
      },
    };
  }
  return undefined;
}

function isMessagePart(value: A2ABridgeMessagePart | undefined): value is A2ABridgeMessagePart {
  return Boolean(value);
}

function partsToText(parts: A2ABridgeMessagePart[]): string {
  const text = parts
    .map((part) =>
      part.kind === "text" ? part.text : part.kind === "data" ? JSON.stringify(part.data) : part.file.uri,
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || "[A2A message contained no text payload.]";
}

function buildTaskTitle(message: A2ABridgeMessage, peerId: string): string {
  const text = partsToText(message.parts).replace(/\s+/g, " ").trim();
  return `A2A ${peerId}: ${text.slice(0, 96) || "peer task"}`;
}

function buildInboundIdempotencyKey(
  peerId: string,
  contextId: string,
  message: A2ABridgeMessage,
  params: Record<string, unknown>,
): string {
  const explicit = message.messageId ?? readString(params.messageId) ?? readString(params.id);
  if (explicit) {
    return hashStableJson({ peerId, contextId, messageId: explicit });
  }
  return hashStableJson({ peerId, contextId, message });
}

function readInboundMessageFromBinding(binding: A2ATaskBindingRecord): A2ABridgeMessage | undefined {
  const value = binding.metadata.inboundMessage;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as A2ABridgeMessage;
}

function mapTaskStatusToA2AState(status: TaskRecord["status"], fallback: A2ABridgeTaskState): A2ABridgeTaskState {
  switch (status) {
    case "done":
      return "completed";
    case "blocked":
      return fallback === "canceled" ? "canceled" : "failed";
    case "planning":
    case "inbox":
    case "assigned":
      return "submitted";
    case "in_progress":
    case "testing":
    case "review":
      return "working";
    default:
      return fallback;
  }
}

function readTaskMaybe(tasks: Pick<TaskLifecycleService, "getTask">, taskId: string): TaskRecord | undefined {
  try {
    return tasks.getTask(taskId);
  } catch {
    return undefined;
  }
}

function readDurableRunId(response: ChatSendMessageResponse): string | undefined {
  const candidate = response as unknown as Record<string, unknown>;
  return (
    readString(candidate.durableRunId) ??
    readString(candidate.agenticRunId) ??
    readString(readObject(candidate.durable)?.runId) ??
    readString(readObject(candidate.agentic)?.runId)
  );
}

function jsonRpcResult(id: A2AJsonRpcRequest["id"], result: unknown): A2AJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  };
}

function jsonRpcError(
  id: A2AJsonRpcRequest["id"] | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): A2AJsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      data,
    },
  };
}

function mapJsonRpcServiceError(id: A2AJsonRpcRequest["id"], error: unknown): A2AJsonRpcResponse {
  if (error instanceof A2AJsonRpcServiceError) {
    return jsonRpcError(id, error.code, error.message);
  }
  return jsonRpcError(id, -32603, "A2A method failed.");
}

function parseJsonRpcResponse(value: unknown): A2AJsonRpcResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return jsonRpcError(null, -32603, "A2A peer returned a malformed JSON-RPC response.");
  }
  const candidate = value as Partial<A2AJsonRpcResponse>;
  if (candidate.jsonrpc !== "2.0") {
    return jsonRpcError(null, -32603, "A2A peer returned a malformed JSON-RPC response.");
  }
  return candidate as A2AJsonRpcResponse;
}

function buildOutboundHeaders(peer: { token?: string; tokenEnv?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const token = peer.token?.trim() || (peer.tokenEnv?.trim() ? process.env[peer.tokenEnv.trim()]?.trim() : undefined);
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function readBearerToken(value: unknown): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function hashStableJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableJson(value)))
    .digest("hex")
    .slice(0, 32);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJson(item)]),
  );
}
