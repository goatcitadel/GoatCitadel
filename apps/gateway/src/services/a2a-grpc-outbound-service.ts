import type {
  A2ABridgeRuntimeConfig,
  A2AJsonRpcResponse,
  A2AOutboundPreviewRequest,
  A2AOutboundPreviewResponse,
  A2AOutboundSendResponse,
  WardEffect,
} from "@goatcitadel/contracts";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import type { A2AGrpcClientPort } from "./a2a-grpc-client.js";
import { projectA2AJsonRpcResponseForExternal } from "./a2a-public-projection.js";
import { buildOutboundHeaders, hashStableJson } from "./a2a-route-utils.js";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";

type A2AOutboundPeer = A2ABridgeRuntimeConfig["outbound"]["peers"][number];

export interface A2AOutboundGrpcDependencies {
  config: GatewayRuntimeConfig;
  storage: Pick<Storage, "externalSideEffectRuns">;
  grpcClient: A2AGrpcClientPort;
  mutationIdempotencyStore?: MutationIdempotencyStore;
  evidenceEnvelopeService?: Pick<EvidenceEnvelopeService, "createEnvelope">;
}

export async function sendOutboundGrpc(input: {
  request: A2AOutboundPreviewRequest;
  actorId: string;
  checkedAt: string;
  preview: A2AOutboundPreviewResponse;
  idempotencyKey: string;
  peer: A2AOutboundPeer;
  /** Pre-evaluated Citadel Ward effect (the caller owns deny/require_approval). */
  wardEffect?: WardEffect;
  deps: A2AOutboundGrpcDependencies;
}): Promise<A2AOutboundSendResponse> {
  const { actorId, checkedAt, deps, idempotencyKey, peer, preview, request } = input;
  const run = await runIdempotentExternalSideEffect<A2AJsonRpcResponse>({
    mutationStore: deps.mutationIdempotencyStore,
    sideEffectRunStore: deps.storage.externalSideEffectRuns,
    boundary: "a2a_grpc_outbound",
    catalogId: "a2a",
    connectionId: peer.peerId,
    actionId: request.method,
    actorScope: actorId,
    checkedAt,
    wardEffect: input.wardEffect,
    idempotencyKey,
    payload: { ...preview.envelope, transport: "GRPC" },
    label: "A2A gRPC outbound call",
    output: { peerId: peer.peerId, method: request.method, transport: "GRPC" },
    execute: async (claim) => {
      const discovered = await discoverOutboundGrpcUrl(peer, checkedAt, deps);
      await claim.markExternalCallStarted();
      return projectA2AJsonRpcResponseForExternal(
        await deps.grpcClient.call({
          grpcUrl: discovered.grpcUrl,
          method: request.method,
          params: request.params,
          id: preview.envelope.id,
          peer,
          allowlist: deps.config.toolPolicy.sandbox.networkAllowlist,
        }),
      );
    },
  });

  if (run.status === "blocked") {
    // Governance refusals are honest blocks; only idempotency-duplicate
    // outcomes read as "replayed".
    const governanceRefusal = run.blockedReason === "external_side_effect_dry_run_required";
    return {
      checkedAt,
      peerId: request.peerId,
      method: request.method,
      transport: "GRPC",
      status: governanceRefusal ? "blocked" : "replayed",
      agentCardUrl: peer.agentCardUrl,
      grpcUrl: preview.grpcUrl,
      idempotencyKey,
      auditRef: run.claim.sideEffectRunId,
      warnings: [run.message],
    };
  }
  if (run.status === "failed") {
    return {
      checkedAt,
      peerId: request.peerId,
      method: request.method,
      transport: "GRPC",
      status: "blocked",
      agentCardUrl: peer.agentCardUrl,
      grpcUrl: preview.grpcUrl,
      idempotencyKey,
      auditRef: run.claim.sideEffectRunId,
      warnings: ["Outbound A2A gRPC send failed; error details are stored in the external side-effect ledger."],
    };
  }
  return {
    checkedAt,
    peerId: request.peerId,
    method: request.method,
    transport: "GRPC",
    status: "sent",
    agentCardUrl: peer.agentCardUrl,
    grpcUrl: preview.grpcUrl,
    idempotencyKey,
    auditRef: run.claim.sideEffectRunId,
    response: run.value,
    warnings: [],
  };
}

async function discoverOutboundGrpcUrl(
  peer: A2AOutboundPeer,
  checkedAt: string,
  deps: A2AOutboundGrpcDependencies,
): Promise<{ grpcUrl: string }> {
  let discoveryError: unknown;
  try {
    const response = await fetchAllowlisted(peer.agentCardUrl, {
      allowlist: deps.config.toolPolicy.sandbox.networkAllowlist,
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
    const grpc = card.supportedInterfaces?.find(
      (item) => item.protocolBinding === "GRPC" && item.enabled !== false && item.url,
    );
    if (grpc?.url) {
      await recordOutboundGrpcDiscovery(peer, grpc.url, checkedAt, "agent_card", deps);
      return { grpcUrl: grpc.url };
    }
  } catch (error) {
    discoveryError = error;
  }

  if (peer.grpcUrl?.trim()) {
    await recordOutboundGrpcDiscovery(peer, peer.grpcUrl, checkedAt, "configured_fallback", deps);
    return { grpcUrl: peer.grpcUrl.trim() };
  }
  throw new Error(
    discoveryError instanceof Error
      ? `A2A peer does not expose a callable gRPC interface and no grpcUrl fallback is configured: ${discoveryError.message}`
      : "A2A peer does not expose a callable gRPC interface and no grpcUrl fallback is configured.",
  );
}

async function recordOutboundGrpcDiscovery(
  peer: A2AOutboundPeer,
  grpcUrl: string,
  checkedAt: string,
  source: "agent_card" | "configured_fallback",
  deps: A2AOutboundGrpcDependencies,
): Promise<void> {
  await deps.evidenceEnvelopeService?.createEnvelope({
    eventKind: "external_writeback",
    metadata: {
      boundary: "a2a_grpc_discovery",
      source,
      peerId: peer.peerId,
      agentCardUrlHash: hashStableJson(peer.agentCardUrl),
      grpcUrlHash: hashStableJson(grpcUrl),
    },
    createdAt: checkedAt,
  });
}
