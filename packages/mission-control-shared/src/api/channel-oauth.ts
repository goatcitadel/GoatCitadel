import type {
  ChannelOAuthAdoptInput, ChannelOAuthAdoptResponse, ChannelOAuthAttempt,
  ChannelOAuthAttemptInput, ChannelOAuthCancelInput, ChannelOAuthStartInput, ChannelOAuthStartResponse,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export function startStagedSlackOAuth(input: ChannelOAuthStartInput): Promise<ChannelOAuthStartResponse> {
  return request("/api/v1/integrations/slack/oauth/start", { method: "POST", body: JSON.stringify(input), cache: "no-store" });
}
export function fetchChannelOAuthAttempt(input: ChannelOAuthAttemptInput): Promise<ChannelOAuthAttempt> {
  const query = new URLSearchParams({ workspaceId: input.workspaceId, attemptId: input.attemptId });
  return request(`/api/v1/integrations/slack/oauth/status?${query}`, { cache: "no-store" });
}
export function adoptSlackOAuthInstall(input: ChannelOAuthAdoptInput): Promise<ChannelOAuthAdoptResponse> {
  return request("/api/v1/integrations/slack/oauth/adopt", { method: "POST", body: JSON.stringify(input), cache: "no-store" });
}
export function cancelChannelOAuthAttempt(input: ChannelOAuthCancelInput): Promise<ChannelOAuthAttempt> {
  return request("/api/v1/integrations/slack/oauth/cancel", { method: "POST", body: JSON.stringify(input), cache: "no-store" });
}