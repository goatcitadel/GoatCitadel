import type { ChannelSetupDraft } from "./channel-wizard.js";

/** A credential-free receipt for one operator's staged channel installation. */
export interface ChannelOAuthInstallReceipt {
  installId: string;
  teamId: string;
  teamName?: string;
  appId: string;
  botUserId: string;
  scopes: string[];
  installerUserId?: string;
}
export type ChannelOAuthAttemptStatus =
  | "pending" | "exchanging" | "ready" | "adopted" | "failed" | "expired" | "cancelled";
export interface ChannelOAuthAttempt {
  attemptId: string;
  provider: "slack";
  workspaceId: string;
  draftId: string;
  draftRevision: number;
  connectionId?: string;
  revision: number;
  status: ChannelOAuthAttemptStatus;
  expiresAt: string;
  install?: ChannelOAuthInstallReceipt;
  adoptedDraftRevision?: number;
  failureCode?: "operator_denied" | "exchange_failed" | "unknown_exchange_outcome" | "invalid_install" | "binding_changed";
  createdAt: string;
  updatedAt: string;
}
export interface ChannelOAuthStartInput {
  workspaceId: string;
  draftId: string;
  expectedRevision: number;
}
export interface ChannelOAuthAttemptInput {
  workspaceId: string;
  attemptId: string;
}
export interface ChannelOAuthAdoptInput extends ChannelOAuthStartInput {
  attemptId: string;
}
export interface ChannelOAuthCancelInput extends ChannelOAuthAttemptInput {
  expectedRevision: number;
}
export interface ChannelOAuthReadiness {
  configured: boolean;
  mode: "hosted" | "self_owned" | "missing";
  scopes: string[];
  missing: string[];
}
export interface ChannelOAuthStartResponse extends ChannelOAuthReadiness {
  authorizationUrl?: string;
  state?: string;
  attempt?: ChannelOAuthAttempt;
}
export interface ChannelOAuthAdoptResponse {
  draft: ChannelSetupDraft;
  attempt: ChannelOAuthAttempt;
}
/** Navigation intent only. Canonical plan scope/revision is fetched before review. */
export interface ChannelPlanReviewHandoff {
  workspaceId: string;
  planId: string;
  reviewedRevision: number;
  draftId: string;
}