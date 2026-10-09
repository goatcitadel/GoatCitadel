import { CHANNEL_INGRESS_ACCEPTED_REVISION_KEY, ValidationError, ConflictError, type ChannelSetupEvidence, type ChannelSetupJourney, type ChannelSetupProofState } from "@goatcitadel/contracts";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import type { ChannelSetupHost } from "./channel-setup-service.js";

export async function getChannelSetupJourney(host: ChannelSetupHost, connectionId: string): Promise<ChannelSetupJourney> {
  const connection = await host.getIntegrationConnection(connectionId);
  if (connection.kind !== "channel") throw new ValidationError({ message: "Setup evidence belongs to channel connections." });
  const capabilities = host.getChannelCapabilities ? await host.getChannelCapabilities(connectionId) : describeChannelCapabilities(connection.key, connection.config);
  const runtime = host.getChannelRuntimeStatus ? await host.getChannelRuntimeStatus(connectionId) : { connectionId, channelKey: connection.key, enabled: connection.enabled, ready: false, inboundModes: capabilities.inboundModes, runtimePolicy: capabilities.runtimePolicy, runtimePosture: capabilities.runtimePosture, metadata: { readinessSource: "unavailable", authoritative: false } };
  const setupEvidence: ChannelSetupEvidence[] = host.storage.channelSetupEvidence ? await host.storage.channelSetupEvidence.list({ connectionId, limit: 30 }) : [];
  const seen = new Set(setupEvidence.map((evidence) => evidence.evidenceId));
  for (const evidence of [...setupEvidence]) {
    let priorId = evidence.priorEvidenceId;
    for (let depth = 0; priorId && depth < 5 && setupEvidence.length < 50; depth++) {
      if (seen.has(priorId) || !host.storage.channelSetupEvidence) break;
      const prior = await host.storage.channelSetupEvidence.get(priorId);
      if (!prior || prior.draftId !== evidence.draftId || prior.catalogId !== connection.catalogId) break;
      seen.add(prior.evidenceId); setupEvidence.push(prior); priorId = prior.priorEvidenceId;
    }
  }
  const events = host.storage.inboundChannelEvents ? await host.storage.inboundChannelEvents.listByConnection({ connectionId, channelKey: connection.key, limit: 100 }) : [];
  const currentEvents = events.filter((event) => event.payload[CHANNEL_INGRESS_ACCEPTED_REVISION_KEY] === connection.revision && (event.dispatchKind === "agent_turn" || event.dispatchKind === "voice_agent_turn") && event.status !== "suppressed");
  const latest = currentEvents[0];
  const deliveries = host.listChannelDeliveries ? await host.listChannelDeliveries(connectionId) : [];
  const admittedEvents = currentEvents.filter((event) => Boolean(event.turnId && event.durableRunId));
  const linkedReply = admittedEvents.map((event) => ({ event, delivery: deliveries.find((delivery) => delivery.deliveryId === event.deliveryId) })).find(({ delivery }) => delivery?.status === "sent");
  const currentActivation = setupEvidence.find((evidence) => evidence.phase === "activation" && evidence.connectionRevision === connection.revision);
  const steps = currentActivation?.probe?.steps ?? [];
  const issues = currentActivation?.issues ?? [];
  const outboundProof = currentActivation?.probe?.mode !== "dry_run" && steps.some((step) => step.key.endsWith("_sandbox_send") && step.status === "pass");
  const categoryState = (pattern: RegExp, receiptImpliesPass = false): ChannelSetupProofState => {
    const matched = steps.filter((step) => pattern.test(step.key));
    if (matched.some((step) => step.status === "fail") || issues.some((issue) => pattern.test(issue.key) && issue.level === "error")) return "failed";
    if (matched.some((step) => step.status === "warn")) return "unknown";
    return matched.some((step) => step.status === "pass") || (receiptImpliesPass && (outboundProof || Boolean(linkedReply))) ? "verified" : "pending";
  };
  const inboundSupported = capabilities.inboundModes.some((mode) => mode !== "none");
  const states: ChannelSetupJourney["states"] = {
    configuration: capabilities.setupReady ? "verified" : "pending",
    activation: !connection.enabled || connection.status === "paused" ? "pending" : connection.status === "error" ? "failed" : capabilities.runtimePosture.lifecycle === "persistent" ? runtime.ready ? "verified" : "pending" : connection.status === "connected" ? "verified" : "pending",
    outbound: linkedReply || outboundProof ? "verified" : "pending",
    inbound: !inboundSupported ? "unsupported" : admittedEvents.length ? "verified" : "pending",
    reply: !inboundSupported ? "unsupported" : linkedReply ? "verified" : latest?.status === "manual_reconciliation_required" ? "unknown" : latest?.status === "failed" ? "failed" : "pending",
    credentials: categoryState(/auth|credential/, true),
    destination: categoryState(/channel_access|sandbox_send|target/, true),
    access: !inboundSupported ? "unsupported" : admittedEvents.length ? "verified" : "pending",
    transport: capabilities.runtimePosture.lifecycle === "persistent" ? runtime.ready ? "verified" : "pending" : admittedEvents.length ? "verified" : categoryState(/sandbox_send/),
  };
  const latestDelivery = latest?.turnId && latest.durableRunId && latest.deliveryId ? deliveries.find((delivery) => delivery.deliveryId === latest.deliveryId) : undefined;
  const latestReplyState: ChannelSetupProofState = !inboundSupported ? "unsupported"
    : latestDelivery?.status === "sent" ? "verified"
    : latestDelivery && ["manual_reconciliation_required", "unknown_after_send", "degraded"].includes(latestDelivery.status) ? "unknown"
    : latestDelivery && ["failed", "blocked", "not_available"].includes(latestDelivery.status) ? "failed"
    : latest?.status === "manual_reconciliation_required" ? "unknown"
    : latest?.status === "failed" ? "failed" : "pending";
  if (!linkedReply) states.reply = latestReplyState;
  if ((await host.getIntegrationConnection(connectionId)).revision !== connection.revision) throw new ConflictError({ code: "WRITE_CONFLICT", message: "The channel changed while its setup evidence was loading. Reload the connection." });
  return { connectionId, connectionRevision: connection.revision, channelKey: connection.key, capabilities, runtime, setupEvidence, states,
    ...(latest ? { latestInbound: { eventId: latest.eventId, status: latest.status, acceptedAt: latest.acceptedAt, sessionId: latest.sessionId, turnId: latest.turnId, durableRunId: latest.durableRunId, deliveryId: latest.deliveryId } } : {}),
    latestReplyState,
    ...(latestDelivery ? { latestReply: latestDelivery } : {}),
  };
}
