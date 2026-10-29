import type {
  ChannelSetupDiscoveryInput,
  ChannelSetupDiscoveryResult,
  DiscordSetupCheckInput,
  DiscordSetupCheckResult,
  SlackSetupCheckInput,
  SlackSetupCheckResult,
  WhatsAppSetupCheckInput,
  WhatsAppSetupCheckResult,
  WhatsAppSetupSubscribeResult,
  ChannelSetupCheckDraftRef,
  TelegramChannelPairingList,
  TelegramChannelPairingApproveInput,
  TelegramChannelPairingRevokeInput,
  ChannelSetupAcknowledgementInput,
  ChannelSetupTestResult,
  ChannelSetupJourney,
  ChannelSetupDraftEvidence,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";
const connectionPath = (id: string) => `/api/v1/channels/connections/${encodeURIComponent(id)}`;
export function discoverTelegramSetupTargets(input: ChannelSetupDiscoveryInput): Promise<ChannelSetupDiscoveryResult> {
  return request("/api/v1/channels/telegram/discover-targets", { method: "POST", body: JSON.stringify(input) });
}
export function checkDiscordSetup(input: DiscordSetupCheckInput): Promise<DiscordSetupCheckResult> {
  return request("/api/v1/channels/discord/setup-check", { method: "POST", body: JSON.stringify(input) });
}
export function checkSlackSetup(input: SlackSetupCheckInput): Promise<SlackSetupCheckResult> {
  return request("/api/v1/channels/slack/setup-check", { method: "POST", body: JSON.stringify(input) });
}
export function checkWhatsAppSetup(input: WhatsAppSetupCheckInput): Promise<WhatsAppSetupCheckResult> {
  return request("/api/v1/channels/whatsapp/setup-check", { method: "POST", body: JSON.stringify(input) });
}
export function subscribeWhatsAppSetupApp(input: ChannelSetupCheckDraftRef): Promise<WhatsAppSetupSubscribeResult> {
  return request("/api/v1/channels/whatsapp/setup-subscribe", { method: "POST", body: JSON.stringify(input) });
}
export function fetchTelegramChannelPairings(connectionId: string): Promise<TelegramChannelPairingList> {
  return request(`${connectionPath(connectionId)}/telegram/pairings`, { cache: "no-store" });
}
export function approveTelegramChannelPairing(
  connectionId: string,
  input: TelegramChannelPairingApproveInput,
): Promise<TelegramChannelPairingList> {
  return request(`${connectionPath(connectionId)}/telegram/pairings/approve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export function revokeTelegramChannelPairing(
  connectionId: string,
  actorId: string,
  input: TelegramChannelPairingRevokeInput,
): Promise<TelegramChannelPairingList> {
  return request(`${connectionPath(connectionId)}/telegram/pairings/${encodeURIComponent(actorId)}/revoke`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export function acknowledgeChannelSetupTest(
  draftId: string,
  input: ChannelSetupAcknowledgementInput,
): Promise<ChannelSetupTestResult> {
  return request(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/test-acknowledgements`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export function fetchChannelSetupJourney(connectionId: string): Promise<ChannelSetupJourney> {
  return request(`${connectionPath(connectionId)}/journey`, { cache: "no-store" });
}

export function fetchChannelSetupDraftEvidence(
  draftId: string,
  expectedRevision: number,
): Promise<ChannelSetupDraftEvidence> {
  const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
  return request(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/evidence?${query.toString()}`, {
    cache: "no-store",
  });
}
