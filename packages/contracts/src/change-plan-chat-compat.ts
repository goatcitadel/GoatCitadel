import {
  CHANGE_PLAN_KINDS,
  CHANGE_PLAN_STATUSES,
  changePlanScopeForKind,
  isChangePlanKind,
  isChangePlanRequest,
  isChangePlanResult,
  isChangePlanStatus,
  type ChangePlanCancelInput,
  type ChangePlanCapabilityCandidateRequest,
  type ChangePlanChannelConnectionRequest,
  type ChangePlanConfirmInput,
  type ChangePlanInstallationDefaultModelRequest,
  type ChangePlanKind,
  type ChangePlanProductSourceUpdateRequest,
  type ChangePlanRecord,
  type ChangePlanRequest,
  type ChangePlanResult,
  type ChangePlanScope,
  type ChangePlanSessionModelRequest,
  type ChangePlanStatus,
} from "./change-plan.js";

/** Compatibility aliases for the original Chat-scoped vertical. */
export const CHAT_CHANGE_PLAN_KINDS = CHANGE_PLAN_KINDS;
export const CHAT_CHANGE_PLAN_STATUSES = CHANGE_PLAN_STATUSES;
export type ChatChangePlanKind = ChangePlanKind;
export type ChatChangePlanStatus = ChangePlanStatus;
export type ChatChangePlanScope = ChangePlanScope;
export type ChatChangePlanRequest = ChangePlanRequest;
export type ChatChangePlanResult = ChangePlanResult;
export type ChatChangePlanSessionModelRequest = ChangePlanSessionModelRequest;
export type ChatChangePlanInstallationDefaultModelRequest = ChangePlanInstallationDefaultModelRequest;
export type ChatChangePlanChannelConnectionRequest = ChangePlanChannelConnectionRequest;
export type ChatChangePlanCapabilityCandidateRequest = ChangePlanCapabilityCandidateRequest;
export type ChatChangePlanProductSourceUpdateRequest = ChangePlanProductSourceUpdateRequest;
export type ChatChangePlanRecord = ChangePlanRecord & {
  readonly sessionId: string;
  /** The compatibility API always issued expiring plans. */
  readonly expiresAt: string;
};
export interface ChatChangePlanCreateInput {
  readonly sessionId: string;
  readonly requesterActorId?: string;
  readonly request: ChatChangePlanRequest;
}
export type ChatChangePlanConfirmInput = ChangePlanConfirmInput;
export type ChatChangePlanCancelInput = ChangePlanCancelInput;
export const chatChangePlanScopeForKind = changePlanScopeForKind;
export const isChatChangePlanStatus = isChangePlanStatus;
export const isChatChangePlanKind = isChangePlanKind;
export const isChatChangePlanRequest = isChangePlanRequest;
export const isChatChangePlanResult = isChangePlanResult;
