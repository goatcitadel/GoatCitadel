/* eslint-disable max-lines -- A2A protocol routing, binding truth, push delivery, and governed cancellation remain one release-bearing boundary. */
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
  TaskActivityRecord,
  TaskRecord,
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
    | "appendTaskActivity"
    | "createTask"
    | "getTask"
    | "invokeAgenticControl"
    | "listTaskDeliverables"
    | "persistDelegationActivityOnce"
    | "persistA2ADurableRunLink"
    | "publishDelegationActivity"
    | "publishA2ADurableRunLink"
    | "updateTask"
  >;
  createChatSession: (input: {
    stableKey?: string;
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

interface A2ATurnIdentity {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

interface StableA2ADispatchIdentity {
  activityId: string;
  attemptId: string;
  localTaskId: string;
  resourceAttemptId: string;
  sessionStableKey: string;
  turnIdentity: A2ATurnIdentity;
}

type A2AResourceInitializationClaimResult =
  | { binding: A2ATaskBindingRecord; status: "ready" }
  | { binding: A2ATaskBindingRecord; status: "waiting" }
  | {
      binding: A2ATaskBindingRecord;
      status: "owned";
      attemptId: string;
      claimToken: string;
    };

type A2ADispatchClaimResult =
  | { binding: A2ATaskBindingRecord; owned: false }
  | {
      binding: A2ATaskBindingRecord;
      owned: true;
      attemptId: string;
      claimToken: string;
      turnIdentity: A2ATurnIdentity;
    };

const A2A_DISPATCH_LEASE_MS = 60_000;
const A2A_RESOURCE_INITIALIZATION_LEASE_MS = 60_000;

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
    const a2aTaskId = readString(params.taskId) ?? `a2a_${hashStableJson({ peerId: peer.peerId, idempotencyKey })}`;
    const workspaceId = readString(params.workspaceId) ?? "default";
    const identity = buildStableA2ADispatchIdentity(peer.peerId, idempotencyKey);
    let binding =
      this.deps.storage.a2aTaskBindings.findByIdempotency(peer.peerId, idempotencyKey) ??
      this.deps.storage.a2aTaskBindings.find(a2aTaskId);
    if (binding) {
      this.assertInboundRequestOwnsBinding(peer, binding, { a2aTaskId, contextId, workspaceId, idempotencyKey });
    } else {
      binding = this.deps.storage.a2aTaskBindings.createOrGet(
        {
          a2aTaskId,
          contextId,
          peerId: peer.peerId,
          workspaceId,
          state: "submitted",
          lastEventSequence: streaming ? 1 : 0,
          idempotencyKey,
          metadata: {
            inboundMessage: message,
            streaming,
            source,
            createdByPeerLabel: peer.label,
            resourceInitialization: {
              status: "pending",
              attemptId: identity.resourceAttemptId,
            },
            dispatch: {
              status: "pending",
              attemptId: identity.attemptId,
              turnIdentity: identity.turnIdentity,
            },
          },
        },
        checkedAt,
      );
      this.assertInboundRequestOwnsBinding(peer, binding, { a2aTaskId, contextId, workspaceId, idempotencyKey });
    }

    const resources = this.ensureA2ABindingResources({
      binding,
      identity,
      message,
      peer,
      contextId,
      idempotencyKey,
    });
    binding = resources.binding;
    if (!resources.ready) {
      return this.buildTaskFromBinding(binding, checkedAt);
    }

    const claim = this.claimA2ADispatch(binding.a2aTaskId, identity);
    binding = claim.binding;
    if (!claim.owned) {
      return this.buildTaskFromBinding(binding, checkedAt);
    }
    const ownedBinding = claim.binding;
    if (!ownedBinding.sessionId || !ownedBinding.localTaskId) {
      throw new Error(`A2A task binding ${ownedBinding.a2aTaskId} lost canonical resource linkage.`);
    }
    const bindingId = ownedBinding.a2aTaskId;
    const canonicalMessage = readInboundMessageFromBinding(ownedBinding) ?? message;
    try {
      const response = await this.deps.chatTurnRuntime.agentSendChatMessage(
        ownedBinding.sessionId,
        {
          content: partsToText(canonicalMessage.parts),
          parts: [],
          mode: "chat",
          useMemory: true,
          operatorId: `a2a:${peer.peerId}`,
          authActorId: `a2a:${peer.peerId}`,
          authActorSource: "a2a_peer",
          policyTaskId: ownedBinding.localTaskId,
          policyRunId: bindingId,
        },
        {
          turnIdentity: claim.turnIdentity,
          assertDispatchOwnership: () => this.assertA2ADispatchOwnership(bindingId, claim.attemptId, claim.claimToken),
        },
      );
      const durableRunId = this.resolveA2ADurableRunId(response, claim.turnIdentity.turnId);
      if (!durableRunId) {
        throw new Error(`A2A dispatch ${bindingId} has no canonical durable-run linkage yet.`);
      }
      const completed = this.completeA2ADispatch({
        a2aTaskId: bindingId,
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        durableRunId,
        turnId: response.turnId ?? claim.turnIdentity.turnId,
      });
      binding = completed.binding;
      if (completed.linkedTask) {
        this.publishA2ADurableRunLinkSafely(completed.linkedTask);
      }
    } catch {
      // A thrown Chat dispatch is ambiguous: the provider or canonical turn may
      // already have advanced. Keep the owned attempt intact for DB-clock lease
      // takeover, which re-enters the same stable turn identity.
      binding = this.deps.storage.a2aTaskBindings.get(bindingId);
    }

    const nextTask = this.buildTaskFromBinding(binding, checkedAt);
    await this.pushNotifications.deliverForTask(peer, binding, nextTask, checkedAt);
    return nextTask;
  }

  private resolveA2ADurableRunId(
    response: Awaited<ReturnType<ChatTurnRuntimeService["agentSendChatMessage"]>>,
    canonicalTurnId: string,
  ): string | undefined {
    const responseRunId = readDurableRunId(response);
    if (responseRunId) {
      return responseRunId;
    }
    const turnIds = [...new Set([response.turnId?.trim(), canonicalTurnId.trim()].filter(Boolean))] as string[];
    for (const turnId of turnIds) {
      try {
        const persistedRunId = this.deps.storage.chatTurnTraces.get(turnId).durable?.runId?.trim();
        if (persistedRunId) {
          return persistedRunId;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private assertInboundRequestOwnsBinding(
    peer: A2APeerAuthResult,
    binding: A2ATaskBindingRecord,
    expected: { a2aTaskId: string; contextId: string; workspaceId: string; idempotencyKey: string },
  ): void {
    this.assertPeerOwnsBinding(peer, binding);
    if (
      binding.a2aTaskId !== expected.a2aTaskId ||
      binding.contextId !== expected.contextId ||
      binding.workspaceId !== expected.workspaceId ||
      binding.idempotencyKey !== expected.idempotencyKey
    ) {
      throw new A2AJsonRpcServiceError(-32023, "A2A task request conflicts with persisted binding identity.");
    }
  }

  private ensureA2ABindingResources(input: {
    binding: A2ATaskBindingRecord;
    identity: StableA2ADispatchIdentity;
    message: ReturnType<typeof normalizeInboundMessage>;
    peer: A2APeerAuthResult;
    contextId: string;
    idempotencyKey: string;
  }): { binding: A2ATaskBindingRecord; ready: boolean } {
    const claim = this.claimA2AResourceInitialization(input.binding.a2aTaskId, input.identity);
    if (claim.status === "waiting") {
      return { binding: claim.binding, ready: false };
    }
    if (claim.status === "ready") {
      this.validateA2ABindingResources(claim.binding);
      this.ensureA2AAcceptanceActivity(claim.binding, input.identity);
      return { binding: claim.binding, ready: true };
    }

    let sessionId = claim.binding.sessionId;
    let existingTask = claim.binding.localTaskId
      ? this.requireA2ALocalTask(claim.binding, claim.binding.localTaskId)
      : undefined;
    if (!sessionId && existingTask) {
      sessionId = existingTask.agenticContext?.parentSessionId?.trim();
      if (!sessionId) {
        throw new Error(`A2A task ${existingTask.taskId} has no canonical parent session.`);
      }
    }
    if (sessionId) {
      this.validateA2ASession(sessionId, claim.binding.workspaceId);
    } else {
      this.assertA2AResourceInitializationOwnership(claim.binding.a2aTaskId, claim.attemptId, claim.claimToken);
      sessionId = this.deps.createChatSession({
        stableKey: input.identity.sessionStableKey,
        workspaceId: claim.binding.workspaceId,
        title: `A2A: ${input.peer.label ?? input.peer.peerId}`,
        tags: ["a2a", `a2a:${input.peer.peerId}`],
        origin: "system",
        mode: "chat",
        includeInHistory: false,
      }).sessionId;
      this.validateA2ASession(sessionId, claim.binding.workspaceId);
    }

    this.assertA2AResourceInitializationOwnership(claim.binding.a2aTaskId, claim.attemptId, claim.claimToken);
    const ensuredTask = existingTask
      ? {
          task: this.validateA2ALocalTask(existingTask, {
            a2aTaskId: claim.binding.a2aTaskId,
            localTaskId: existingTask.taskId,
            sessionId,
            workspaceId: claim.binding.workspaceId,
          }),
          created: false,
        }
      : this.ensureA2ALocalTask({
          a2aTaskId: claim.binding.a2aTaskId,
          localTaskId: input.identity.localTaskId,
          message: input.message,
          peer: input.peer,
          sessionId,
          workspaceId: claim.binding.workspaceId,
        });
    existingTask = ensuredTask.task;
    const completed = this.completeA2AResourceInitialization({
      a2aTaskId: claim.binding.a2aTaskId,
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      localTaskId: existingTask.taskId,
      sessionId,
    });
    if (!completed.sessionId || !completed.localTaskId) {
      return { binding: completed, ready: false };
    }
    this.validateA2ABindingResources(completed);
    this.ensureA2AAcceptanceActivity(completed, input.identity);
    return { binding: completed, ready: true };
  }

  private ensureA2AAcceptanceActivity(binding: A2ATaskBindingRecord, identity: StableA2ADispatchIdentity): void {
    if (!binding.localTaskId) {
      return;
    }
    const persisted = this.deps.tasks.persistDelegationActivityOnce(
      identity.activityId,
      binding.localTaskId,
      {
        agentId: `a2a:${binding.peerId}`,
        activityType: "spawned",
        message: "A2A peer message accepted and bound to a GoatCitadel task.",
        metadata: {
          a2aTaskId: binding.a2aTaskId,
          contextId: binding.contextId,
          idempotencyKey: binding.idempotencyKey,
        },
      },
      binding.createdAt,
    );
    if (persisted.created) {
      this.publishA2AAcceptanceActivitySafely(persisted.activity);
    }
  }

  private publishA2AAcceptanceActivitySafely(activity: TaskActivityRecord): void {
    try {
      this.deps.tasks.publishDelegationActivity(activity);
    } catch (error) {
      process.stderr.write(
        `[a2a-route] acceptance activity committed but realtime publication failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  private claimA2AResourceInitialization(
    a2aTaskId: string,
    identity: StableA2ADispatchIdentity,
  ): A2AResourceInitializationClaimResult {
    return this.deps.storage.runImmediateTransaction(() => {
      const current = this.deps.storage.a2aTaskBindings.getForUpdate(a2aTaskId);
      if (current.sessionId && current.localTaskId) {
        return { binding: current, status: "ready" as const };
      }
      const databaseNow = this.deps.storage.a2aTaskBindings.readDatabaseNow();
      const initialization = readA2AResourceInitializationState(current);
      if (
        initialization.status === "owned" &&
        initialization.claimToken &&
        initialization.claimExpiresAt &&
        Date.parse(initialization.claimExpiresAt) > Date.parse(databaseNow)
      ) {
        return { binding: current, status: "waiting" as const };
      }
      const attemptId = initialization.attemptId ?? identity.resourceAttemptId;
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(Date.parse(databaseNow) + A2A_RESOURCE_INITIALIZATION_LEASE_MS).toISOString();
      const claimed = this.deps.storage.a2aTaskBindings.update(
        a2aTaskId,
        {
          metadata: {
            ...current.metadata,
            resourceInitialization: {
              status: "owned",
              attemptId,
              claimToken,
              claimedAt: databaseNow,
              claimExpiresAt,
            },
          },
        },
        databaseNow,
      );
      return { binding: claimed, status: "owned" as const, attemptId, claimToken };
    });
  }

  private assertA2AResourceInitializationOwnership(a2aTaskId: string, attemptId: string, claimToken: string): void {
    const current = this.deps.storage.a2aTaskBindings.get(a2aTaskId);
    const initialization = readA2AResourceInitializationState(current);
    if (
      initialization.status !== "owned" ||
      initialization.attemptId !== attemptId ||
      initialization.claimToken !== claimToken
    ) {
      throw new Error(`A2A resource initialization ownership for ${a2aTaskId} was lost.`);
    }
  }

  private completeA2AResourceInitialization(input: {
    a2aTaskId: string;
    attemptId: string;
    claimToken: string;
    sessionId: string;
    localTaskId: string;
  }): A2ATaskBindingRecord {
    return this.deps.storage.runImmediateTransaction(() => {
      const current = this.deps.storage.a2aTaskBindings.getForUpdate(input.a2aTaskId);
      if (current.sessionId && current.localTaskId) {
        return current;
      }
      const initialization = readA2AResourceInitializationState(current);
      if (
        initialization.status !== "owned" ||
        initialization.attemptId !== input.attemptId ||
        initialization.claimToken !== input.claimToken
      ) {
        return current;
      }
      if (
        (current.sessionId && current.sessionId !== input.sessionId) ||
        (current.localTaskId && current.localTaskId !== input.localTaskId)
      ) {
        throw new Error(`A2A task ${input.a2aTaskId} has conflicting canonical resource linkage.`);
      }
      const databaseNow = this.deps.storage.a2aTaskBindings.readDatabaseNow();
      return this.deps.storage.a2aTaskBindings.update(
        input.a2aTaskId,
        {
          sessionId: input.sessionId,
          localTaskId: input.localTaskId,
          state: "working",
          metadata: {
            ...current.metadata,
            resourceInitialization: {
              ...initialization.raw,
              status: "applied",
              attemptId: input.attemptId,
              claimToken: input.claimToken,
              completedAt: databaseNow,
            },
          },
        },
        databaseNow,
      );
    });
  }

  private validateA2ABindingResources(binding: A2ATaskBindingRecord): void {
    if (!binding.sessionId || !binding.localTaskId) {
      throw new Error(`A2A task binding ${binding.a2aTaskId} has incomplete canonical resource linkage.`);
    }
    this.validateA2ASession(binding.sessionId, binding.workspaceId);
    this.requireA2ALocalTask(binding, binding.localTaskId, binding.sessionId);
  }

  private validateA2ASession(sessionId: string, workspaceId: string): void {
    const meta = this.deps.storage.chatSessionMeta.get(sessionId);
    if (!meta || meta.workspaceId !== workspaceId) {
      throw new Error(`A2A session ${sessionId} conflicts with canonical workspace identity.`);
    }
  }

  private requireA2ALocalTask(binding: A2ATaskBindingRecord, localTaskId: string, sessionId?: string): TaskRecord {
    const task = this.deps.tasks.getTask(localTaskId, { workspaceId: binding.workspaceId });
    return this.validateA2ALocalTask(task, {
      a2aTaskId: binding.a2aTaskId,
      localTaskId,
      sessionId,
      workspaceId: binding.workspaceId,
    });
  }

  private validateA2ALocalTask(
    task: TaskRecord,
    expected: { a2aTaskId: string; localTaskId: string; sessionId?: string; workspaceId: string },
  ): TaskRecord {
    if (
      task.taskId !== expected.localTaskId ||
      task.workspaceId !== expected.workspaceId ||
      task.agenticContext?.runId !== expected.a2aTaskId ||
      (expected.sessionId && task.agenticContext?.parentSessionId !== expected.sessionId)
    ) {
      throw new Error(`Stable A2A task ${expected.localTaskId} conflicts with canonical task identity.`);
    }
    return task;
  }

  private ensureA2ALocalTask(input: {
    a2aTaskId: string;
    localTaskId: string;
    message: ReturnType<typeof normalizeInboundMessage>;
    peer: A2APeerAuthResult;
    sessionId: string;
    workspaceId: string;
  }): { task: TaskRecord; created: boolean } {
    const validate = (task: TaskRecord): TaskRecord => this.validateA2ALocalTask(task, input);
    const existing = this.deps.storage.tasks.find(input.localTaskId);
    if (existing) {
      return { task: validate(existing), created: false };
    }
    try {
      const task = this.deps.tasks.createTask(
        {
          workspaceId: input.workspaceId,
          title: buildTaskTitle(input.message, input.peer.peerId),
          description: "Peer-authenticated A2A message mapped into GoatCitadel durable task truth.",
          status: "in_progress",
          priority: "normal",
          createdBy: `a2a:${input.peer.peerId}`,
          agenticContext: {
            runId: input.a2aTaskId,
            parentSessionId: input.sessionId,
            surface: "chat",
            status: "running",
            providerId: "a2a",
            model: input.peer.peerId,
          },
        },
        { taskId: input.localTaskId },
      );
      return { task: validate(task), created: true };
    } catch (error) {
      const raced = this.deps.storage.tasks.find(input.localTaskId);
      if (!raced) {
        throw error;
      }
      return { task: validate(raced), created: false };
    }
  }

  private claimA2ADispatch(a2aTaskId: string, identity: StableA2ADispatchIdentity): A2ADispatchClaimResult {
    return this.deps.storage.runImmediateTransaction(() => {
      const current = this.deps.storage.a2aTaskBindings.getForUpdate(a2aTaskId);
      const databaseNow = this.deps.storage.a2aTaskBindings.readDatabaseNow();
      const dispatch = readA2ADispatchState(current);
      if (current.durableRunId || dispatch.status === "applied") {
        return { binding: current, owned: false as const };
      }
      if (!dispatch.status && current.state === "failed") {
        return { binding: current, owned: false as const };
      }
      if (
        dispatch.status === "owned" &&
        dispatch.claimToken &&
        dispatch.claimExpiresAt &&
        Date.parse(dispatch.claimExpiresAt) > Date.parse(databaseNow)
      ) {
        return { binding: current, owned: false as const };
      }
      const attemptId = dispatch.attemptId ?? identity.attemptId;
      const turnIdentity = dispatch.turnIdentity ?? identity.turnIdentity;
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(Date.parse(databaseNow) + A2A_DISPATCH_LEASE_MS).toISOString();
      const claimed = this.deps.storage.a2aTaskBindings.update(
        a2aTaskId,
        {
          state: current.state === "failed" ? "working" : current.state,
          metadata: {
            ...current.metadata,
            dispatch: {
              status: "owned",
              attemptId,
              turnIdentity,
              claimToken,
              claimedAt: databaseNow,
              claimExpiresAt,
            },
          },
        },
        databaseNow,
      );
      return { binding: claimed, owned: true as const, attemptId, turnIdentity, claimToken };
    });
  }

  private assertA2ADispatchOwnership(a2aTaskId: string, attemptId: string, claimToken: string): void {
    const current = this.deps.storage.a2aTaskBindings.get(a2aTaskId);
    const dispatch = readA2ADispatchState(current);
    if (dispatch.status !== "owned" || dispatch.attemptId !== attemptId || dispatch.claimToken !== claimToken) {
      throw new Error(`A2A dispatch ownership for ${a2aTaskId} was lost before provider dispatch.`);
    }
  }

  private completeA2ADispatch(input: {
    a2aTaskId: string;
    attemptId: string;
    claimToken: string;
    durableRunId: string;
    turnId: string;
  }): { binding: A2ATaskBindingRecord; linkedTask?: TaskRecord } {
    return this.deps.storage.runImmediateTransaction(() => {
      const current = this.deps.storage.a2aTaskBindings.getForUpdate(input.a2aTaskId);
      const dispatch = readA2ADispatchState(current);
      if (current.durableRunId || dispatch.status === "applied") {
        return { binding: current };
      }
      if (
        dispatch.status !== "owned" ||
        dispatch.attemptId !== input.attemptId ||
        dispatch.claimToken !== input.claimToken
      ) {
        return { binding: current };
      }
      const databaseNow = this.deps.storage.a2aTaskBindings.readDatabaseNow();
      if (!current.localTaskId) {
        throw new Error(`A2A task ${input.a2aTaskId} lost canonical local-task linkage before completion.`);
      }
      const linkedTask = this.deps.tasks.persistA2ADurableRunLink(current.localTaskId, input.durableRunId);
      const binding = this.deps.storage.a2aTaskBindings.update(
        input.a2aTaskId,
        {
          durableRunId: input.durableRunId,
          state: current.state === "failed" ? "working" : current.state,
          metadata: {
            ...current.metadata,
            chatTurnId: input.turnId,
            durableRunId: input.durableRunId,
            dispatch: {
              ...dispatch.raw,
              status: "applied",
              attemptId: input.attemptId,
              claimToken: input.claimToken,
              completedAt: databaseNow,
            },
          },
        },
        databaseNow,
      );
      return { binding, linkedTask };
    });
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
    let binding = this.deps.storage.a2aTaskBindings.find(taskId);
    if (!binding) {
      throw new A2AJsonRpcServiceError(-32004, "A2A task binding was not found.");
    }
    this.assertPeerOwnsBinding(peer, binding);
    if (this.isCanonicalA2ACancellationApplied(binding)) {
      binding = this.persistCanonicalA2ACancellation(binding.a2aTaskId, checkedAt);
      return this.buildTaskFromBinding(binding, checkedAt);
    }
    const claimedAttempt = this.deps.storage.runImmediateTransaction(() => {
      const lockedBinding = this.deps.storage.a2aTaskBindings.getForUpdate(taskId);
      if (this.isCanonicalA2ACancellationApplied(lockedBinding)) {
        const previous = readA2ACancellationState(lockedBinding);
        const reconciled = this.deps.storage.a2aTaskBindings.update(
          taskId,
          {
            state: "canceled",
            metadata: {
              ...lockedBinding.metadata,
              cancellation: {
                status: "applied",
                attempt: previous.attempt,
                controlId: previous.controlId,
                requestedAt: checkedAt,
                resultStatus: "canonical_reconciled",
                runtimeEffect: "runtime_cancel",
              },
            },
          },
          checkedAt,
        );
        return { binding: reconciled, terminal: true as const };
      }
      const previous = readA2ACancellationState(lockedBinding);
      const reusesPendingAttempt = previous.status === "pending" && Boolean(previous.controlId);
      const attempt = reusesPendingAttempt ? previous.attempt : previous.attempt + 1;
      const controlId =
        (reusesPendingAttempt ? previous.controlId : undefined) ??
        `a2a-cancel-${hashStableJson({
          peerId: peer.peerId,
          a2aTaskId: lockedBinding.a2aTaskId,
          durableRunId: lockedBinding.durableRunId,
          attempt,
        }).slice(0, 32)}`;
      const claimedBinding =
        reusesPendingAttempt && lockedBinding.state !== "canceled"
          ? lockedBinding
          : this.deps.storage.a2aTaskBindings.update(
              taskId,
              {
                ...(lockedBinding.state === "canceled" ? { state: "working" as const } : {}),
                metadata: {
                  ...lockedBinding.metadata,
                  cancellation: { status: "pending", attempt, controlId, requestedAt: checkedAt },
                },
              },
              checkedAt,
            );
      return { binding: claimedBinding, terminal: false as const, attempt, controlId };
    });
    binding = claimedAttempt.binding;
    if (claimedAttempt.terminal) {
      return this.buildTaskFromBinding(binding, checkedAt);
    }
    const { attempt, controlId } = claimedAttempt;
    const failOrConverge = (status: "pending" | "failed", message: string): A2ABridgeTask => {
      const reconciled = this.persistA2ACancellationOutcome({
        taskId,
        attempt,
        controlId,
        status,
        checkedAt,
        error: message,
      });
      if (isA2ACancellationApplied(reconciled)) {
        return this.buildTaskFromBinding(reconciled, checkedAt);
      }
      throw new A2AJsonRpcServiceError(-32025, `A2A task cancellation was not applied: ${message}`);
    };
    try {
      if (!binding.localTaskId) {
        throw new Error("A2A task binding has no canonical local task.");
      }
      if (binding.durableRunId) {
        const localTask = this.deps.tasks.getTask(binding.localTaskId, { workspaceId: binding.workspaceId });
        const linkedDurableRunId = localTask.agenticContext?.durableRunId?.trim();
        if (linkedDurableRunId && linkedDurableRunId !== binding.durableRunId) {
          throw new Error(
            `A2A task durable linkage conflicts with binding truth (${linkedDurableRunId} != ${binding.durableRunId}).`,
          );
        }
        if (!linkedDurableRunId) {
          const repairedTask = this.deps.storage.runImmediateTransaction(() =>
            this.deps.tasks.persistA2ADurableRunLink(binding.localTaskId!, binding.durableRunId!),
          );
          this.publishA2ADurableRunLinkSafely(repairedTask);
        }
      }
    } catch (error) {
      return failOrConverge(
        "failed",
        error instanceof Error ? error.message : "Canonical A2A cancellation preflight failed.",
      );
    }

    let controlResult: ReturnType<TaskLifecycleService["invokeAgenticControl"]>;
    try {
      controlResult = await Promise.resolve(
        this.deps.tasks.invokeAgenticControl(
          binding.a2aTaskId,
          {
            action: "cancel",
            controlId,
            reason: "A2A peer requested cancellation.",
            actorId: `a2a:${peer.peerId}`,
          },
          { workspaceId: binding.workspaceId },
        ),
      );
    } catch (error) {
      return failOrConverge(
        "pending",
        error instanceof Error ? error.message : "Canonical A2A cancellation outcome is ambiguous.",
      );
    }
    if (controlResult.status !== "applied" || controlResult.runtimeEffect !== "runtime_cancel") {
      return failOrConverge(
        "failed",
        `Canonical agentic control did not cancel the runtime (${controlResult.status}/${controlResult.runtimeEffect}): ${controlResult.message}`,
      );
    }
    const updated = this.persistA2ACancellationOutcome({
      taskId,
      attempt,
      controlId,
      status: "applied",
      checkedAt,
      resultStatus: controlResult.status,
      runtimeEffect: controlResult.runtimeEffect,
    });
    if (!isA2ACancellationApplied(updated)) {
      throw new A2AJsonRpcServiceError(
        -32025,
        "A2A task cancellation applied at runtime but lost binding transition ownership; inspect canonical task truth.",
      );
    }
    const task = this.buildTaskFromBinding(updated, checkedAt);
    await this.pushNotifications.deliverForTask(peer, updated, task, checkedAt);
    return task;
  }

  private isCanonicalA2ACancellationApplied(binding: A2ATaskBindingRecord): boolean {
    if (binding.durableRunId) {
      try {
        return this.deps.storage.durableRuns.getRun(binding.durableRunId).status === "cancelled";
      } catch {
        // Missing canonical durable truth cannot prove cancellation, and an
        // attached task projection is not allowed to override that authority.
        return false;
      }
    }
    if (binding.localTaskId) {
      try {
        const task = this.deps.tasks.getTask(binding.localTaskId, { workspaceId: binding.workspaceId });
        return task.agenticContext?.status === "cancelled";
      } catch {
        // Missing or cross-workspace task truth cannot prove cancellation.
        return false;
      }
    }
    return false;
  }

  private persistCanonicalA2ACancellation(a2aTaskId: string, checkedAt: string): A2ATaskBindingRecord {
    return this.deps.storage.runImmediateTransaction(() => {
      const current = this.deps.storage.a2aTaskBindings.getForUpdate(a2aTaskId);
      if (!this.isCanonicalA2ACancellationApplied(current)) {
        return current;
      }
      if (current.state === "canceled" && isA2ACancellationApplied(current)) {
        return current;
      }
      const previous = readA2ACancellationState(current);
      return this.deps.storage.a2aTaskBindings.update(
        a2aTaskId,
        {
          state: "canceled",
          metadata: {
            ...current.metadata,
            cancellation: {
              status: "applied",
              attempt: previous.attempt,
              controlId: previous.controlId,
              requestedAt: checkedAt,
              resultStatus: "canonical_reconciled",
              runtimeEffect: "runtime_cancel",
            },
          },
        },
        checkedAt,
      );
    });
  }

  private persistA2ACancellationOutcome(input: {
    taskId: string;
    attempt: number;
    controlId: string;
    status: "pending" | "failed" | "applied";
    checkedAt: string;
    error?: string;
    resultStatus?: string;
    runtimeEffect?: string;
  }): A2ATaskBindingRecord {
    return this.deps.storage.runImmediateTransaction(() => {
      const current = this.deps.storage.a2aTaskBindings.getForUpdate(input.taskId);
      if (isA2ACancellationApplied(current)) {
        return current;
      }
      const cancellation = readA2ACancellationState(current);
      if (cancellation.controlId !== input.controlId || cancellation.attempt !== input.attempt) {
        return current;
      }
      return this.deps.storage.a2aTaskBindings.update(
        input.taskId,
        {
          ...(input.status === "applied"
            ? { state: "canceled" as const, lastEventSequence: current.lastEventSequence + 1 }
            : {}),
          metadata: {
            ...current.metadata,
            cancellation: {
              status: input.status,
              attempt: input.attempt,
              controlId: input.controlId,
              requestedAt: input.checkedAt,
              ...(input.error ? { error: input.error } : {}),
              ...(input.resultStatus ? { resultStatus: input.resultStatus } : {}),
              ...(input.runtimeEffect ? { runtimeEffect: input.runtimeEffect } : {}),
            },
          },
        },
        input.checkedAt,
      );
    });
  }

  private publishA2ADurableRunLinkSafely(task: TaskRecord): void {
    try {
      this.deps.tasks.publishA2ADurableRunLink(task);
    } catch (error) {
      process.stderr.write(
        `[a2a-route] durable link committed but realtime publication failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
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

function buildStableA2ADispatchIdentity(peerId: string, idempotencyKey: string): StableA2ADispatchIdentity {
  const identityHash = hashStableJson({ boundary: "a2a_inbound_dispatch", peerId, idempotencyKey });
  return {
    activityId: `activity_a2a_${identityHash}`,
    attemptId: `dispatch_a2a_${identityHash}`,
    localTaskId: `task_a2a_${identityHash}`,
    resourceAttemptId: `resource_a2a_${identityHash}`,
    sessionStableKey: `a2a:${peerId}:${idempotencyKey}`,
    turnIdentity: {
      turnId: `turn_a2a_${identityHash}`,
      userMessageId: `msg_a2a_user_${identityHash}`,
      assistantMessageId: `msg_a2a_assistant_${identityHash}`,
    },
  };
}

function readA2AResourceInitializationState(binding: A2ATaskBindingRecord): {
  raw: Record<string, unknown>;
  status?: "pending" | "owned" | "applied" | "failed";
  attemptId?: string;
  claimToken?: string;
  claimExpiresAt?: string;
} {
  const value = binding.metadata.resourceInitialization;
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const rawStatus = readString(raw.status);
  const status =
    rawStatus === "pending" || rawStatus === "owned" || rawStatus === "applied" || rawStatus === "failed"
      ? rawStatus
      : undefined;
  if (rawStatus && !status) {
    throw new Error(`A2A task ${binding.a2aTaskId} has an invalid persisted resource initialization status.`);
  }
  const attemptId = readString(raw.attemptId);
  const claimToken = readString(raw.claimToken);
  const claimExpiresAt = readString(raw.claimExpiresAt);
  if (claimExpiresAt && !Number.isFinite(Date.parse(claimExpiresAt))) {
    throw new Error(`A2A task ${binding.a2aTaskId} has an invalid persisted resource initialization lease.`);
  }
  if (status === "owned" && (!attemptId || !claimToken || !claimExpiresAt)) {
    throw new Error(`A2A task ${binding.a2aTaskId} has incomplete persisted resource initialization ownership.`);
  }
  return { raw, status, attemptId, claimToken, claimExpiresAt };
}

function readA2ADispatchState(binding: A2ATaskBindingRecord): {
  raw: Record<string, unknown>;
  status?: "pending" | "owned" | "applied" | "failed";
  attemptId?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  turnIdentity?: A2ATurnIdentity;
} {
  const value = binding.metadata.dispatch;
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const rawStatus = readString(raw.status);
  const status =
    rawStatus === "pending" || rawStatus === "owned" || rawStatus === "applied" || rawStatus === "failed"
      ? rawStatus
      : undefined;
  if (rawStatus && !status) {
    throw new Error(`A2A task ${binding.a2aTaskId} has an invalid persisted dispatch status.`);
  }
  const turnValue = raw.turnIdentity;
  const turnRaw =
    turnValue && typeof turnValue === "object" && !Array.isArray(turnValue)
      ? (turnValue as Record<string, unknown>)
      : undefined;
  const turnId = readString(turnRaw?.turnId);
  const userMessageId = readString(turnRaw?.userMessageId);
  const assistantMessageId = readString(turnRaw?.assistantMessageId);
  const hasPartialTurnIdentity = Boolean(turnRaw && (turnId || userMessageId || assistantMessageId));
  if (hasPartialTurnIdentity && (!turnId || !userMessageId || !assistantMessageId)) {
    throw new Error(`A2A task ${binding.a2aTaskId} has an invalid persisted turn identity.`);
  }
  const attemptId = readString(raw.attemptId);
  const claimToken = readString(raw.claimToken);
  const claimExpiresAt = readString(raw.claimExpiresAt);
  if (claimExpiresAt && !Number.isFinite(Date.parse(claimExpiresAt))) {
    throw new Error(`A2A task ${binding.a2aTaskId} has an invalid persisted dispatch lease.`);
  }
  if (status === "owned" && (!attemptId || !claimToken || !claimExpiresAt)) {
    throw new Error(`A2A task ${binding.a2aTaskId} has incomplete persisted dispatch ownership.`);
  }
  return {
    raw,
    status,
    attemptId,
    claimToken,
    claimExpiresAt,
    turnIdentity:
      turnId && userMessageId && assistantMessageId ? { turnId, userMessageId, assistantMessageId } : undefined,
  };
}

function readA2ACancellationState(binding: A2ATaskBindingRecord): {
  status?: string;
  attempt: number;
  controlId?: string;
} {
  const raw = binding.metadata.cancellation;
  const cancellation = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    status: readString(cancellation.status),
    attempt: readNumber(cancellation.attempt) ?? 0,
    controlId: readString(cancellation.controlId),
  };
}

function isA2ACancellationApplied(binding: A2ATaskBindingRecord): boolean {
  return readA2ACancellationState(binding).status === "applied";
}

function normalizeOutboundTransport(value: A2AOutboundTransport | undefined): A2AOutboundTransport {
  return value === "GRPC" ? "GRPC" : "JSONRPC";
}
