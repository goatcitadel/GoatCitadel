import { randomUUID } from "node:crypto";
import type {
  A2ABridgeArtifact,
  A2ABridgeAgentCard,
  A2ABridgeProtocolBinding,
  A2ABridgeRuntimeConfig,
  A2ABridgeTask,
  A2ABridgeTaskEvent,
  A2ABridgeStatusResponse,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2AOutboundPreviewRequest,
  A2AOutboundPreviewResponse,
  A2AOutboundSendResponse,
  A2AOutboundTransport,
  A2ATaskPushNotificationConfig,
  A2ATaskBindingRecord,
  A2ATaskExportPreviewRequest,
  A2ATaskExportPreviewResponse,
} from "@goatcitadel/contracts";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import type { Storage } from "@goatcitadel/storage";
import type { FastifyRequest } from "fastify";
import type { GatewayRuntimeConfig } from "../config.js";
import { timingSafeStringEqual } from "./crypto-equals.js";
import {
  projectA2AExternalValue,
  projectA2AJsonRpcResponseForExternal,
  projectA2ATaskEventForExternal,
  projectA2ATaskForExternal,
} from "./a2a-public-projection.js";
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
import { A2AJsonRpcServiceError } from "./a2a-json-rpc-error.js";
import { A2APushNotificationService } from "./a2a-push-notification-service.js";
import { A2AGrpcClient, type A2AGrpcClientPort } from "./a2a-grpc-client.js";
import { sendOutboundGrpc } from "./a2a-grpc-outbound-service.js";
import { buildA2AOutboundWardAction, resolveWardEffectForExternalAction } from "./citadel-ward-gate.js";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import {
  buildInboundIdempotencyKey,
  buildOutboundHeaders,
  buildTaskTitle,
  hashStableJson,
  httpJsonServiceError,
  isInboundPeerBinding,
  jsonRpcError,
  jsonRpcResult,
  mapJsonRpcServiceError,
  mapTaskStatusToA2AState,
  normalizeInboundMessage,
  parseJsonRpcRequest,
  parseJsonRpcResponse,
  partsToText,
  readBearerToken,
  readDurableRunId,
  readInboundMessageFromBinding,
  readNumber,
  readString,
  readTaskMaybe,
} from "./a2a-route-utils.js";

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
  pushDeliveryFetch?: typeof fetchAllowlisted;
  grpcClient?: A2AGrpcClientPort;
}

export class A2ARouteService {
  private readonly pushNotifications: A2APushNotificationService;
  private readonly grpcClient: A2AGrpcClientPort;

  public constructor(private readonly deps: A2ARouteServiceDependencies) {
    this.grpcClient = deps.grpcClient ?? new A2AGrpcClient();
    this.pushNotifications = new A2APushNotificationService({
      config: deps.config,
      storage: deps.storage,
      tasks: deps.tasks,
      mutationIdempotencyStore: deps.mutationIdempotencyStore,
      pushDeliveryFetch: deps.pushDeliveryFetch,
      buildTaskFromBinding: (binding, checkedAt) => this.buildTaskFromBinding(binding, checkedAt),
      buildEventsForTask: (task, since, checkedAt) => this.buildEventsForTask(task, since, checkedAt),
    });
  }

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
    if (
      !config.enabled ||
      !config.inbound.enabled ||
      !config.bindings.some((binding) => isInboundPeerBinding(binding))
    ) {
      return {
        statusCode: 503,
        reason: "a2a_inbound_disabled",
        message: "A2A inbound peer access is not enabled.",
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
    return projectA2AJsonRpcResponseForExternal(await this.handleJsonRpcRaw(peer, body, checkedAt));
  }

  private async handleJsonRpcRaw(
    peer: A2APeerAuthResult,
    body: unknown,
    checkedAt: string,
  ): Promise<A2AJsonRpcResponse> {
    const request = parseJsonRpcRequest(body);
    if (!request.ok) {
      return jsonRpcError(null, request.code, request.message);
    }
    try {
      const bindingError = this.resolveInboundBindingError("JSONRPC");
      if (bindingError) {
        return jsonRpcError(request.value.id, -32030, bindingError);
      }
      switch (request.value.method) {
        case "SendMessage":
          return jsonRpcResult(request.value.id, {
            task: await this.sendMessage(peer, request.value.params ?? {}, checkedAt, false, "a2a_jsonrpc"),
          });
        case "SendStreamingMessage": {
          const task = await this.sendMessage(peer, request.value.params ?? {}, checkedAt, true, "a2a_jsonrpc");
          return jsonRpcResult(request.value.id, {
            task,
            events: this.buildEventsForTask(task, 0, checkedAt),
          });
        }
        case "GetTask":
          return jsonRpcResult(request.value.id, {
            task: this.getA2ATask(peer, request.value.params ?? {}, checkedAt),
          });
        case "CancelTask":
          return jsonRpcResult(request.value.id, {
            task: await this.cancelA2ATask(peer, request.value.params ?? {}, checkedAt),
          });
        case "SubscribeToTask": {
          const task = this.getA2ATask(peer, request.value.params ?? {}, checkedAt);
          const since = readNumber(request.value.params?.lastEventSequence) ?? 0;
          return jsonRpcResult(request.value.id, {
            task,
            events: this.buildEventsForTask(task, since, checkedAt),
          });
        }
        case "SetTaskPushNotificationConfig":
          return jsonRpcResult(request.value.id, {
            config: await this.setTaskPushNotificationConfig(peer, request.value.params ?? {}, checkedAt),
          });
        case "GetTaskPushNotificationConfig":
          return jsonRpcResult(request.value.id, {
            config: this.getTaskPushNotificationConfig(peer, request.value.params ?? {}),
          });
        case "ListTaskPushNotificationConfig":
          return jsonRpcResult(request.value.id, {
            configs: this.listTaskPushNotificationConfigs(peer, request.value.params ?? {}),
          });
        case "DeleteTaskPushNotificationConfig":
          return jsonRpcResult(request.value.id, {
            deleted: this.deleteTaskPushNotificationConfig(peer, request.value.params ?? {}, checkedAt),
          });
        case "GetAuthenticatedExtendedCard":
          return jsonRpcResult(request.value.id, {
            agentCard: this.getAuthenticatedExtendedAgentCard(peer, { checkedAt }),
          });
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

  public getAuthenticatedExtendedAgentCard(
    peer: A2APeerAuthResult,
    input: { checkedAt: string; baseUrl?: string },
  ): A2ABridgeAgentCard & {
    authenticatedPeer: A2APeerAuthResult;
    checkedAt: string;
    boundary: "gateway_peer_authenticated";
  } {
    const bindingError = this.resolveInboundBindingError();
    if (bindingError) {
      throw httpJsonServiceError(503, "a2a_inbound_disabled", bindingError);
    }
    const status = this.getStatus({ checkedAt: input.checkedAt, baseUrl: input.baseUrl });
    return {
      ...status.agentCard,
      capabilities: {
        ...status.agentCard.capabilities,
        extendedAgentCard: true,
      },
      authenticatedPeer: {
        peerId: peer.peerId,
        label: peer.label,
        scopes: peer.scopes,
      },
      checkedAt: input.checkedAt,
      boundary: "gateway_peer_authenticated",
    };
  }

  public async sendHttpJsonMessage(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<A2ABridgeTask> {
    this.assertInboundBinding("HTTP_JSON");
    return this.sendMessage(peer, params, checkedAt, false, "a2a_http_json");
  }

  public getHttpJsonTask(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): A2ABridgeTask {
    this.assertInboundBinding("HTTP_JSON");
    return this.getA2ATask(peer, params, checkedAt);
  }

  public async cancelHttpJsonTask(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<A2ABridgeTask> {
    this.assertInboundBinding("HTTP_JSON");
    return this.cancelA2ATask(peer, params, checkedAt);
  }

  public getHttpJsonTaskEvents(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): { task: A2ABridgeTask; events: A2ABridgeTaskEvent[] } {
    this.assertInboundBinding("HTTP_JSON");
    const task = this.getA2ATask(peer, params, checkedAt);
    const since = readNumber(params.lastEventSequence) ?? 0;
    return {
      task,
      events: this.buildEventsForTask(task, since, checkedAt),
    };
  }

  public async sendGrpcMessage(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<A2ABridgeTask> {
    this.assertInboundBinding("GRPC");
    return this.sendMessage(peer, params, checkedAt, false, "a2a_grpc");
  }

  public async sendGrpcStreamingMessage(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<{ task: A2ABridgeTask; events: A2ABridgeTaskEvent[] }> {
    this.assertInboundBinding("GRPC");
    const task = await this.sendMessage(peer, params, checkedAt, true, "a2a_grpc");
    return {
      task,
      events: this.buildEventsForTask(task, 0, checkedAt),
    };
  }

  public getGrpcTask(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): A2ABridgeTask {
    this.assertInboundBinding("GRPC");
    return this.getA2ATask(peer, params, checkedAt);
  }

  public async cancelGrpcTask(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<A2ABridgeTask> {
    this.assertInboundBinding("GRPC");
    return this.cancelA2ATask(peer, params, checkedAt);
  }

  public getGrpcTaskEvents(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): { task: A2ABridgeTask; events: A2ABridgeTaskEvent[] } {
    this.assertInboundBinding("GRPC");
    const task = this.getA2ATask(peer, params, checkedAt);
    const since = readNumber(params.lastEventSequence) ?? 0;
    return {
      task,
      events: this.buildEventsForTask(task, since, checkedAt),
    };
  }

  public getGrpcAuthenticatedExtendedAgentCard(
    peer: A2APeerAuthResult,
    input: { checkedAt: string; baseUrl?: string },
  ) {
    this.assertInboundBinding("GRPC");
    return this.getAuthenticatedExtendedAgentCard(peer, input);
  }

  public async setTaskPushNotificationConfig(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<A2ATaskPushNotificationConfig> {
    return this.pushNotifications.setTaskPushNotificationConfig(peer, params, checkedAt);
  }

  public getTaskPushNotificationConfig(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
  ): A2ATaskPushNotificationConfig {
    return this.pushNotifications.getTaskPushNotificationConfig(peer, params);
  }

  public listTaskPushNotificationConfigs(
    peer: A2APeerAuthResult,
    params: Record<string, unknown> = {},
  ): A2ATaskPushNotificationConfig[] {
    return this.pushNotifications.listTaskPushNotificationConfigs(peer, params);
  }

  public deleteTaskPushNotificationConfig(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): { taskId: string; peerId: string; deleted: boolean } {
    return this.pushNotifications.deleteTaskPushNotificationConfig(peer, params, checkedAt);
  }

  public async setGrpcTaskPushNotificationConfig(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<A2ATaskPushNotificationConfig> {
    this.assertInboundBinding("GRPC");
    return this.setTaskPushNotificationConfig(peer, params, checkedAt);
  }

  public getGrpcTaskPushNotificationConfig(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
  ): A2ATaskPushNotificationConfig {
    this.assertInboundBinding("GRPC");
    return this.getTaskPushNotificationConfig(peer, params);
  }

  public listGrpcTaskPushNotificationConfigs(
    peer: A2APeerAuthResult,
    params: Record<string, unknown> = {},
  ): A2ATaskPushNotificationConfig[] {
    this.assertInboundBinding("GRPC");
    return this.listTaskPushNotificationConfigs(peer, params);
  }

  public deleteGrpcTaskPushNotificationConfig(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): { taskId: string; peerId: string; deleted: boolean } {
    this.assertInboundBinding("GRPC");
    return this.deleteTaskPushNotificationConfig(peer, params, checkedAt);
  }

  public previewOutbound(
    input: A2AOutboundPreviewRequest,
    checkedAt = new Date().toISOString(),
  ): A2AOutboundPreviewResponse {
    return projectA2AExternalValue(this.buildOutboundPreview(input, checkedAt));
  }

  private buildOutboundPreview(input: A2AOutboundPreviewRequest, checkedAt: string): A2AOutboundPreviewResponse {
    const peer = this.findOutboundPeer(input.peerId);
    const transport = normalizeOutboundTransport(input.transport);
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
      transport,
      agentCardUrl: peer?.agentCardUrl,
      grpcUrl: transport === "GRPC" ? peer?.grpcUrl : undefined,
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
    return projectA2AExternalValue(await this.sendOutboundRaw(input, actorId, checkedAt));
  }

  private async sendOutboundRaw(
    input: A2AOutboundPreviewRequest,
    actorId: string,
    checkedAt: string,
  ): Promise<A2AOutboundSendResponse> {
    const preview = this.buildOutboundPreview(input, checkedAt);
    const idempotencyKey = input.idempotencyKey?.trim() || hashStableJson(preview.envelope);
    const peer = this.findOutboundPeer(input.peerId);
    if (!preview.callable || !peer) {
      return {
        checkedAt,
        peerId: input.peerId,
        method: input.method,
        transport: preview.transport,
        status: "blocked",
        agentCardUrl: peer?.agentCardUrl,
        grpcUrl: preview.grpcUrl,
        idempotencyKey,
        warnings: [...preview.warnings, "Outbound send was blocked before the external boundary."],
      };
    }

    // Citadel Ward gate (Stage 1): a2a peers carry no workspace binding, so
    // outbound calls evaluate against the default personal citadel — a real
    // global hook (an operator ward on `a2a.outbound.*` gates every peer).
    // deny/require_approval block here, before either transport; require_dry_run
    // threads to the runner, which refuses pre-boundary.
    const wardAction = buildA2AOutboundWardAction(preview.transport === "GRPC" ? "grpc" : "jsonrpc", input.method);
    const ward = resolveWardEffectForExternalAction({
      storage: this.deps.storage,
      action: wardAction,
    });
    if (ward.effect === "deny" || ward.effect === "require_approval") {
      return {
        checkedAt,
        peerId: input.peerId,
        method: input.method,
        transport: preview.transport,
        status: "blocked",
        agentCardUrl: peer.agentCardUrl,
        grpcUrl: preview.grpcUrl,
        idempotencyKey,
        warnings: [
          ward.effect === "deny"
            ? `A Citadel Ward denies ${wardAction} (citadel ${ward.citadelId}).`
            : `A Citadel Ward requires approval for ${wardAction} (citadel ${ward.citadelId}); approval-gated a2a outbound is not wired, so the call is blocked.`,
        ],
      };
    }

    if (preview.transport === "GRPC") {
      return sendOutboundGrpc({
        request: input,
        actorId,
        checkedAt,
        preview,
        idempotencyKey,
        peer,
        wardEffect: ward.effect,
        deps: {
          config: this.deps.config,
          storage: this.deps.storage,
          grpcClient: this.grpcClient,
          mutationIdempotencyStore: this.deps.mutationIdempotencyStore,
          evidenceEnvelopeService: this.deps.evidenceEnvelopeService,
        },
      });
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
      wardEffect: ward.effect,
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
        const payload = await readBoundedResponseJson(response, {
          maxBytes: 256 * 1024,
          timeoutMs: 5_000,
          label: "A2A JSON-RPC response",
        });
        if (!response.ok) {
          throw new Error(`A2A peer returned HTTP ${response.status}.`);
        }
        return projectA2AJsonRpcResponseForExternal(parseJsonRpcResponse(payload));
      },
    });

    if (run.status === "blocked") {
      // Governance refusals are honest blocks; only idempotency-duplicate
      // outcomes read as "replayed".
      const governanceRefusal = run.blockedReason === "external_side_effect_dry_run_required";
      return {
        checkedAt,
        peerId: input.peerId,
        method: input.method,
        transport: "JSONRPC",
        status: governanceRefusal ? "blocked" : "replayed",
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
        transport: "JSONRPC",
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
      transport: "JSONRPC",
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

  private assertInboundBinding(binding: A2ABridgeProtocolBinding): void {
    const bindingError = this.resolveInboundBindingError(binding);
    if (bindingError) {
      throw httpJsonServiceError(503, "a2a_inbound_disabled", bindingError);
    }
  }

  private resolveInboundBindingError(binding?: A2ABridgeProtocolBinding): string | undefined {
    const config = this.config;
    if (!config.enabled || !config.inbound.enabled) {
      return "A2A inbound peer access is not enabled.";
    }
    if (binding && !config.bindings.includes(binding)) {
      return `A2A inbound ${binding} binding is not enabled.`;
    }
    if (!config.bindings.some((candidate) => isInboundPeerBinding(candidate))) {
      return "A2A inbound peer bindings are not enabled.";
    }
    return undefined;
  }

  private requirePeerTaskBinding(peer: A2APeerAuthResult, params: Record<string, unknown>): A2ATaskBindingRecord {
    const taskId = readString(params.taskId) ?? readString(params.id);
    if (!taskId) {
      throw new A2AJsonRpcServiceError(-32602, "taskId is required.");
    }
    const binding = this.deps.storage.a2aTaskBindings.find(taskId);
    if (!binding) {
      throw new A2AJsonRpcServiceError(-32004, "A2A task binding was not found.");
    }
    this.assertPeerOwnsBinding(peer, binding);
    return binding;
  }

  private assertPeerOwnsBinding(peer: A2APeerAuthResult, binding: A2ATaskBindingRecord): void {
    if (binding.peerId !== peer.peerId) {
      throw new A2AJsonRpcServiceError(-32022, "A2A task is not owned by the authenticated peer.");
    }
  }

  private async sendMessage(
    peer: A2APeerAuthResult,
    params: Record<string, unknown>,
    checkedAt: string,
    streaming: boolean,
    source: "a2a_jsonrpc" | "a2a_http_json" | "a2a_grpc",
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
          source,
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

    const nextTask = this.buildTaskFromBinding(binding, checkedAt);
    await this.pushNotifications.deliverForTask(peer, binding, nextTask, checkedAt);
    return nextTask;
  }

  private getA2ATask(peer: A2APeerAuthResult, params: Record<string, unknown>, checkedAt: string): A2ABridgeTask {
    const binding = this.requirePeerTaskBinding(peer, params);
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
    this.assertPeerOwnsBinding(peer, binding);
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
    const task = this.buildTaskFromBinding(updated, checkedAt);
    await this.pushNotifications.deliverForTask(peer, updated, task, checkedAt);
    return task;
  }

  private buildTaskFromBinding(binding: A2ATaskBindingRecord, checkedAt: string): A2ABridgeTask {
    const localTask = binding.localTaskId ? readTaskMaybe(this.deps.tasks, binding.localTaskId) : undefined;
    const statusState = localTask ? mapTaskStatusToA2AState(localTask.status, binding.state) : binding.state;
    const message = readInboundMessageFromBinding(binding);
    const artifacts = binding.localTaskId ? this.readArtifacts(binding.localTaskId) : [];
    const task: A2ABridgeTask = {
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
    return projectA2ATaskForExternal(task);
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
    return events.filter((event) => event.sequence > since).map(projectA2ATaskEventForExternal);
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
    const card = await readBoundedResponseJson<{
      supportedInterfaces?: Array<{ protocolBinding?: string; enabled?: boolean; url?: string }>;
    }>(response, {
      maxBytes: 256 * 1024,
      timeoutMs: 5_000,
      label: "A2A Agent Card",
    });
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

function normalizeOutboundTransport(value: A2AOutboundTransport | undefined): A2AOutboundTransport {
  return value === "GRPC" ? "GRPC" : "JSONRPC";
}
