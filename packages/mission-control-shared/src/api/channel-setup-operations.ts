import type { ChannelSetupDiscoveryInput, ChannelSetupDiscoveryResult, TelegramChannelPairingList, TelegramChannelPairingApproveInput, TelegramChannelPairingRevokeInput, ChannelSetupAcknowledgementInput, ChannelSetupTestResult, ChannelSetupJourney, ChannelSetupDraftEvidence } from "@goatcitadel/contracts";
import { request } from "./client-core.js";
const connectionPath = (id: string) => `/api/v1/channels/connections/${encodeURIComponent(id)}`;
export function discoverTelegramSetupTargets(input: ChannelSetupDiscoveryInput): Promise<ChannelSetupDiscoveryResult> {
  return request("/api/v1/channels/telegram/discover-targets", { method: "POST", body: JSON.stringify(input) });
}
export function fetchTelegramChannelPairings(connectionId: string): Promise<TelegramChannelPairingList> {
  return request(`${connectionPath(connectionId)}/telegram/pairings`, { cache: "no-store" });
}
export function approveTelegramChannelPairing(connectionId: string, input: TelegramChannelPairingApproveInput): Promise<TelegramChannelPairingList> {
  return request(`${connectionPath(connectionId)}/telegram/pairings/approve`, { method: "POST", body: JSON.stringify(input) });
}
export function revokeTelegramChannelPairing(connectionId: string, actorId: string, input: TelegramChannelPairingRevokeInput): Promise<TelegramChannelPairingList> {
  return request(`${connectionPath(connectionId)}/telegram/pairings/${encodeURIComponent(actorId)}/revoke`, { method: "POST", body: JSON.stringify(input) });
}
export function acknowledgeChannelSetupTest(draftId: string, input: ChannelSetupAcknowledgementInput): Promise<ChannelSetupTestResult> {
  return request(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/test-acknowledgements`, { method: "POST", body: JSON.stringify(input) });
}
export function fetchChannelSetupJourney(connectionId: string): Promise<ChannelSetupJourney> {
  return request(`${connectionPath(connectionId)}/journey`, { cache: "no-store" });
}

export function fetchChannelSetupDraftEvidence(draftId: string, expectedRevision: number): Promise<ChannelSetupDraftEvidence> {
  const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
  return request(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/evidence?${query.toString()}`, { cache: "no-store" });
}
