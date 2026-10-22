import {
  ConflictError,
  SemanticValidationError,
  ValidationError,
  type ChangePlanRecord,
  type ChangePlanRuntimeConfigurationRequest,
  type WebSearchCredentialStatus,
  type WebSearchCredentialTargetId,
} from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
  EvolutionControlPlaneOwnerInputReceipt,
} from "./evolution-control-plane-adapter.js";
import type { EvolutionControlPlaneActor, EvolutionControlPlaneService } from "./evolution-control-plane-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

export const WEB_SEARCH_CREDENTIAL_OWNER_ID = "web_search_credential_temporary_secret";

type WebSearchCredentialChange = Extract<
  ChangePlanRuntimeConfigurationRequest["change"],
  { operation: "web_search_credential" }
>;

/** The Settings credential owner as the Change Plan adapter sees it. */
export interface WebSearchCredentialChangeOwner {
  status(targetId: WebSearchCredentialTargetId): WebSearchCredentialStatus;
  store(targetId: WebSearchCredentialTargetId, secret: string): Promise<WebSearchCredentialStatus>;
  clear(targetId: WebSearchCredentialTargetId): Promise<WebSearchCredentialStatus>;
  holdTemporary(planId: string, secret: string): void;
  hasTemporary(planId: string): boolean;
  consumeTemporary(planId: string): string;
  discardTemporary(planId: string): void;
}

export function isWebSearchCredentialChange(
  request: ChangePlanRuntimeConfigurationRequest,
): request is ChangePlanRuntimeConfigurationRequest & { change: WebSearchCredentialChange } {
  return request.change.operation === "web_search_credential";
}

export function prepareWebSearchCredential(
  context: EvolutionControlPlaneAdapterContext,
  change: WebSearchCredentialChange,
  settings: RuntimeSettings,
  owner: WebSearchCredentialChangeOwner | undefined,
) {
  const status = requireOwner(owner).status(change.targetId);
  const description = describeWebSearchCredential(change, status.label);
  return {
    target: {
      ownerId: "runtime_settings",
      resourceId: `web_search_credential:${change.targetId}`,
      expectedRevision: settings.revision,
    },
    title: description.title,
    summary: description.summary,
    impact: description.impact,
    risk: description.risk,
    status: change.action === "replace" ? ("awaiting_input" as const) : ("awaiting_confirmation" as const),
    requiredAction:
      change.action === "replace"
        ? context.actions.secureInput({
            targetId: `web-search:${change.targetId}`,
            title: `Enter the ${status.label} API key`,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            fields: [
              {
                fieldId: "apiKey",
                label: `${status.label} API key`,
                required: true,
                description:
                  "Checked live, then stored in the OS keychain. It is kept out of the Change Plan, Chat, and audit payloads.",
              },
            ],
          })
        : context.actions.confirmation({
            title: `Confirm ${description.title.toLowerCase()}`,
            confirmationText: description.summary,
          }),
  };
}

export async function applyWebSearchCredential(
  plan: ChangePlanRecord,
  change: WebSearchCredentialChange,
  owner: WebSearchCredentialChangeOwner | undefined,
): Promise<EvolutionControlPlaneAdapterOutcome> {
  const credentials = requireOwner(owner);
  if (change.action === "replace") {
    if (!credentials.hasTemporary(plan.planId)) {
      throw new SemanticValidationError("The temporary web-search key is unavailable. Enter it again.");
    }
    await credentials.store(change.targetId, credentials.consumeTemporary(plan.planId));
  } else {
    await credentials.clear(change.targetId);
  }
  const status = credentials.status(change.targetId);
  return {
    status: "verifying",
    evidenceRefs: [`web_search_credential:${change.targetId}:${status.keychainConfigured ? "stored" : "absent"}`],
    result: { summary: describeWebSearchCredential(change, status.label).completedSummary },
  };
}

export function resumeWebSearchCredential(
  context: EvolutionControlPlaneAdapterContext,
  plan: ChangePlanRecord,
  change: WebSearchCredentialChange,
  receipt: EvolutionControlPlaneOwnerInputReceipt,
  owner: WebSearchCredentialChangeOwner | undefined,
): EvolutionControlPlaneAdapterOutcome {
  if (
    change.action !== "replace" ||
    receipt.actionKind !== "secure_input" ||
    receipt.ownerId !== WEB_SEARCH_CREDENTIAL_OWNER_ID ||
    receipt.ownerResourceId !== change.targetId
  ) {
    throw new ConflictError({ message: "Web-search key secure-input receipt does not match this Change Plan." });
  }
  if (!requireOwner(owner).hasTemporary(plan.planId)) {
    throw new SemanticValidationError("The temporary web-search key is unavailable. Enter it again.");
  }
  return {
    status: "awaiting_confirmation",
    evidenceRefs: receipt.evidenceRefs,
    requiredAction: context.actions.confirmation({
      title: "Confirm web-search key",
      confirmationText: `Check the ${change.targetId} key live and store it in the OS keychain.`,
    }),
    result: { summary: "The key is in temporary secure custody and ready for confirmation." },
  };
}

export function observeWebSearchCredential(
  change: WebSearchCredentialChange,
  owner: WebSearchCredentialChangeOwner | undefined,
): { applied: boolean; reason: string; evidenceRefs: string[] } {
  const status = requireOwner(owner).status(change.targetId);
  const applied = change.action === "replace" ? status.keychainConfigured : !status.keychainConfigured;
  return {
    applied,
    reason: applied
      ? "The OS keychain matches the approved web-search key change."
      : "The OS keychain does not match the approved web-search key change.",
    evidenceRefs: applied ? [`web_search_credential:${change.targetId}:${change.action}`] : [],
  };
}

export function describeWebSearchCredential(change: WebSearchCredentialChange, label: string = change.targetId) {
  return change.action === "replace"
    ? {
        title: `Save the ${label} API key`,
        summary: `Check a new ${label} API key live and store it in the OS keychain.`,
        completedSummary: `The ${label} API key is stored in the OS keychain.`,
        impact: `Future ${label} requests use the keychain key; the environment variable stays a fallback.`,
        risk: "caution" as const,
      }
    : {
        title: `Remove the ${label} API key`,
        summary: `Delete the ${label} API key from the OS keychain.`,
        completedSummary: `The ${label} API key is no longer in the OS keychain.`,
        impact: `${label} falls back to its environment variable, if one is set.`,
        risk: "safe" as const,
      };
}

/** Settings secure-input step: hold the key, then move the plan to exact confirmation. */
export async function submitEvolutionWebSearchCredential(
  evolution: Pick<EvolutionControlPlaneService, "get" | "resumeOwnerInput">,
  owner: WebSearchCredentialChangeOwner,
  input: {
    actor: EvolutionControlPlaneActor;
    planId: string;
    expectedRevision: number;
    actionId: string;
    actionNonce: string;
    apiKey: string;
  },
): Promise<ChangePlanRecord> {
  const plan = await evolution.get(input.actor, input.planId);
  if (plan.request.kind !== "runtime_configuration" || !isWebSearchCredentialChange(plan.request)) {
    throw new ValidationError({ message: "This Change Plan does not own a web-search key flow." });
  }
  const change = plan.request.change;
  const action = plan.requiredAction;
  if (
    plan.revision !== input.expectedRevision ||
    action?.kind !== "secure_input" ||
    action.actionId !== input.actionId ||
    action.actionNonce !== input.actionNonce ||
    action.targetId !== `web-search:${change.targetId}`
  ) {
    throw new ConflictError({ message: "Web-search key secure-input action is stale or does not match this plan." });
  }
  owner.holdTemporary(plan.planId, input.apiKey);
  try {
    return await evolution.resumeOwnerInput(input.actor, plan.planId, plan.revision, input.actionNonce, {
      actionId: input.actionId,
      actionKind: "secure_input",
      ownerId: WEB_SEARCH_CREDENTIAL_OWNER_ID,
      ownerResourceId: change.targetId,
      evidenceRefs: [`web-search:${change.targetId}:temporary-key-captured`],
    });
  } catch (error) {
    owner.discardTemporary(plan.planId);
    throw error;
  }
}

function requireOwner(owner: WebSearchCredentialChangeOwner | undefined): WebSearchCredentialChangeOwner {
  if (!owner) throw new SemanticValidationError("The web-search credential owner is unavailable.");
  return owner;
}
