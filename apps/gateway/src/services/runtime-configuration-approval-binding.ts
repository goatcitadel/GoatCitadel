import type {
  ApprovalLinkage,
  ApprovalReplayEvent,
  ApprovalRequest,
  ChatToolRunRecord,
  PendingApprovalAction,
} from "@goatcitadel/contracts";
import { PolicyViolationError } from "@goatcitadel/contracts";
import { RUNTIME_CONFIGURE_TOOL_NAME, type RuntimeConfigurationTargetId } from "@goatcitadel/policy-engine";

export interface RuntimeConfigurationApprovalBinding {
  approvalId: string;
  toolRunId: string;
  promptId: string;
}

export interface RuntimeConfigurationPromptAuthority {
  promptId: string;
  expiresAt: string;
}

export interface RuntimeConfigurationApprovalBindingEvidence {
  approval: ApprovalRequest;
  approvalEvents: readonly ApprovalReplayEvent[];
  pendingAction: PendingApprovalAction | undefined;
  toolRun: ChatToolRunRecord;
}

export interface RuntimeConfigurationApprovalBindingContext {
  binding: RuntimeConfigurationApprovalBinding;
  targetId: RuntimeConfigurationTargetId;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  actorId: string;
  authActorSource?: ApprovalLinkage["authActorSource"];
  runId?: string;
  currentPromptId: string;
  promptLineageValid: boolean;
  currentPolicyReasonCodes: readonly string[];
  currentRequiresApproval: boolean;
  currentMatchedGrantId?: string;
  currentWardEffect?: string;
  currentPermissionProfileId?: string;
  currentLocalOperatorOverrideId?: string;
}

const RUNTIME_CONFIGURATION_PROMPT_AUTHORITY_KEY = "runtimeConfigurationPromptAuthority";

/**
 * Proves that a secure configuration prompt is the continuation of the exact
 * runtime.configure action an operator already approved. The binding is only a
 * reference: current deny-wins policy is still evaluated separately at apply.
 */
export function assertRuntimeConfigurationApprovalBinding(
  context: RuntimeConfigurationApprovalBindingContext,
  evidence: RuntimeConfigurationApprovalBindingEvidence,
): void {
  const {
    binding,
    targetId,
    workspaceId,
    sessionId,
    turnId,
    actorId,
    authActorSource,
    runId,
    currentPromptId,
    promptLineageValid,
    currentPolicyReasonCodes,
    currentRequiresApproval,
    currentMatchedGrantId,
    currentWardEffect,
    currentPermissionProfileId,
    currentLocalOperatorOverrideId,
  } = context;
  const { approval, approvalEvents, pendingAction, toolRun } = evidence;
  const pendingPolicyContext = readRecord(pendingAction?.request.policyContext);
  const reject = (): never => {
    throw new PolicyViolationError({
      message: "The approved runtime configuration action no longer matches this secure prompt.",
      details: {
        targetId,
        diagnosticCode: "runtime_configuration_approval_binding_invalid",
      },
    });
  };

  if (
    !binding.approvalId ||
    !binding.toolRunId ||
    !binding.promptId ||
    !currentPromptId ||
    !currentRequiresApproval ||
    (!promptLineageValid && binding.promptId !== currentPromptId) ||
    approval.approvalId !== binding.approvalId ||
    approval.status !== "approved" ||
    approval.kind !== RUNTIME_CONFIGURE_TOOL_NAME
  ) {
    reject();
  }

  const linkage = approval.linkage;
  if (
    !linkage ||
    linkage.toolName !== RUNTIME_CONFIGURE_TOOL_NAME ||
    linkage.actionType !== "tool.invoke" ||
    linkage.workspaceId !== workspaceId ||
    linkage.sessionId !== sessionId ||
    linkage.authActorId !== actorId ||
    (authActorSource !== undefined && linkage.authActorSource !== authActorSource) ||
    (runId !== undefined && linkage.runId !== runId) ||
    readString(linkage.permissionProfileId) !== readString(currentPermissionProfileId) ||
    readString(linkage.localOperatorOverrideId) !== readString(currentLocalOperatorOverrideId)
  ) {
    reject();
  }

  const registrationEvent = approvalEvents.find((event) => event.eventType === "pending_action_registered");
  if (
    !registrationEvent ||
    !sameStringSet(readStringArray(registrationEvent.payload.reasonCodes), currentPolicyReasonCodes) ||
    readString(registrationEvent.payload.matchedGrantId) !== readString(currentMatchedGrantId) ||
    readString(registrationEvent.payload.wardEffect) !== readString(currentWardEffect)
  ) {
    reject();
  }

  if (
    !pendingAction ||
    pendingAction.approvalId !== binding.approvalId ||
    pendingAction.actionType !== "tool.invoke" ||
    pendingAction.resolutionStatus !== "executed" ||
    readString(pendingAction.request.toolName) !== RUNTIME_CONFIGURE_TOOL_NAME ||
    readString(pendingAction.request.workspaceId ?? pendingPolicyContext?.workspaceId) !== workspaceId ||
    readString(pendingAction.request.sessionId ?? pendingPolicyContext?.sessionId) !== sessionId ||
    (runId !== undefined && readString(pendingAction.request.runId ?? pendingPolicyContext?.runId) !== runId) ||
    readTargetId(pendingAction.request.args) !== targetId ||
    !isExecutedConfigurationMarker(readRecord(pendingAction.result?.result), targetId)
  ) {
    reject();
  }

  if (
    toolRun.toolRunId !== binding.toolRunId ||
    toolRun.approvalId !== binding.approvalId ||
    toolRun.toolName !== RUNTIME_CONFIGURE_TOOL_NAME ||
    toolRun.status !== "executed" ||
    toolRun.sessionId !== sessionId ||
    toolRun.turnId !== turnId ||
    readTargetId(toolRun.args) !== targetId ||
    !isExecutedConfigurationMarker(toolRun.result, targetId) ||
    readRuntimeConfigurationPromptAuthorityId(toolRun.result) !== binding.promptId
  ) {
    reject();
  }
}

export function sealRuntimeConfigurationPromptAuthority(
  result: Record<string, unknown>,
  authority: RuntimeConfigurationPromptAuthority,
): Record<string, unknown> {
  if (readRuntimeConfigurationPromptAuthorityId(result)) {
    throw new PolicyViolationError({
      message: "The approved runtime configuration action already issued a secure prompt.",
      details: { diagnosticCode: "runtime_configuration_approval_authority_consumed" },
    });
  }
  return {
    ...result,
    [RUNTIME_CONFIGURATION_PROMPT_AUTHORITY_KEY]: authority,
  };
}

export function readRuntimeConfigurationPromptAuthority(
  result: Record<string, unknown> | undefined,
): RuntimeConfigurationPromptAuthority | undefined {
  const authority = readRecord(result?.[RUNTIME_CONFIGURATION_PROMPT_AUTHORITY_KEY]);
  const promptId = readString(authority?.promptId);
  const expiresAt = readString(authority?.expiresAt);
  if (!promptId || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) return undefined;
  return { promptId, expiresAt };
}

export function readRuntimeConfigurationPromptAuthorityId(
  result: Record<string, unknown> | undefined,
): string | undefined {
  return readString(readRecord(result?.[RUNTIME_CONFIGURATION_PROMPT_AUTHORITY_KEY])?.promptId);
}

export function stripRuntimeConfigurationPromptAuthority(
  result: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!result || !(RUNTIME_CONFIGURATION_PROMPT_AUTHORITY_KEY in result)) return result;
  const { [RUNTIME_CONFIGURATION_PROMPT_AUTHORITY_KEY]: _authority, ...projected } = result;
  return projected;
}

function isExecutedConfigurationMarker(
  value: Record<string, unknown> | undefined,
  targetId: RuntimeConfigurationTargetId,
): boolean {
  return (
    value?.status === "configuration_required" && value.configurationRequired === true && value.targetId === targetId
  );
}

function readTargetId(value: unknown): string | undefined {
  return readString(readRecord(value)?.targetId);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter((entry): entry is string => Boolean(entry)) : [];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right.map((entry) => entry.trim()).filter(Boolean))].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((entry, index) => entry === normalizedRight[index])
  );
}
