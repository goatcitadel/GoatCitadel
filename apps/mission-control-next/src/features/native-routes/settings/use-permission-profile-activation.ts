import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  canonicalJsonString,
  type PermissionProfileSnapshotRecord,
  type PermissionSurface,
} from "@goatcitadel/contracts";
import {
  activatePermissionProfile,
  fetchSettings,
  reviewPermissionProfileSelection,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { usePermissionSelectionReview } from "./sections/usePermissionSelectionReview";
import {
  activationReviewMatches,
  isUncommittedActivationConflict,
  profileCanBeSelected,
  requireActivationReceipt,
  type ActivationRequest,
} from "./permission-activation-binding";

type Attempt = { phase: "checking" | "submitted" | "recorded" | "uncertain"; message: string };
// App-session presentation lock only; permission selection and conflicts belong to Gateway.
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
let version = 0;
function publish(key: string, attempt?: Attempt) {
  if (attempt) attempts.set(key, attempt);
  else attempts.delete(key);
  version += 1;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function locked(key: string) {
  return ["checking", "submitted", "uncertain"].includes(attempts.get(key)?.phase ?? "");
}

/** Existing-profile activation only; both Settings shells share this exact commit lifecycle. */
export function usePermissionProfileActivation(options: {
  key: string;
  workspaceId: string;
  profile?: PermissionProfileSnapshotRecord;
  available: boolean;
  deploymentProfile?: string;
  reload: () => Promise<unknown>;
}) {
  const { workspaceId, profile, available, deploymentProfile } = options;
  const identity = canonicalJsonString({ key: options.key, workspaceId, profile, available, deploymentProfile });
  const owner = useRef({ identity, generation: 0, mounted: true, lifetime: 0, action: 0 });
  if (owner.current.identity !== identity) {
    owner.current.identity = identity;
    owner.current.generation += 1;
  }
  const generation = owner.current.generation;
  const isCurrent = () => owner.current.mounted && owner.current.generation === generation;
  useEffect(() => {
    const lifecycle = owner.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.lifetime += 1;
    };
  }, []);
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const selection = usePermissionSelectionReview(identity);
  const [intent, setIntent] = useState<{ identity: string; input: ActivationRequest } | null>(null);
  const [feedback, setFeedback] = useState<{ identity: string; message: string } | null>(null);
  const currentIntent = intent?.identity === identity ? intent : null;
  const review =
    currentIntent && activationReviewMatches(selection.review, currentIntent.input, profile)
      ? selection.review
      : undefined;
  const attempt = attempts.get(workspaceId);
  const pending = ["checking", "submitted"].includes(attempt?.phase ?? "");
  const restriction =
    profile?.approvalMode === "bypass" && (!deploymentProfile || deploymentProfile === "remote_hardened")
      ? "Profiles that skip normal prompts are unavailable until deployment settings permit them."
      : undefined;
  const ready = available && profileCanBeSelected(profile, workspaceId) && !restriction;
  function clear() {
    if (attempts.get(workspaceId)?.phase === "submitted") return;
    owner.current.action += 1;
    selection.clear();
    setIntent(null);
  }
  async function request(surface: PermissionSurface = "chat") {
    if (!isCurrent() || !ready || !profile || locked(workspaceId)) return;
    const input: ActivationRequest = { operation: "activate", profileId: profile.profileId, workspaceId, surface };
    publish(workspaceId);
    setFeedback(null);
    setIntent({ identity, input });
    await selection.request(input);
  }
  async function refreshOwner(current = isCurrent) {
    if (current()) {
      try {
        await options.reload();
      } catch {
        /* An unavailable reread does not change the mutation outcome. */
      }
    }
  }
  async function confirm(): Promise<boolean> {
    if (!isCurrent() || !ready || !review || !currentIntent || locked(workspaceId)) return false;
    const reviewed = review;
    const input = currentIntent.input;
    const lifetime = owner.current.lifetime;
    const action = ++owner.current.action;
    const ownsAttempt = () => isCurrent() && owner.current.lifetime === lifetime && owner.current.action === action;
    let dispatched = false;
    publish(workspaceId, { phase: "checking", message: "Checking the reviewed permission selection…" });
    try {
      const settings = await fetchSettings();
      if (!ownsAttempt()) return false;
      if (
        reviewed.profile?.approvalMode === "bypass" &&
        (!settings.deploymentProfile || settings.deploymentProfile === "remote_hardened")
      ) {
        throw new Error("Current deployment settings do not permit this profile.");
      }
      const fresh = await reviewPermissionProfileSelection(input);
      if (!ownsAttempt()) return false;
      if (
        !activationReviewMatches(fresh, input, profile) ||
        canonicalJsonString(fresh) !== canonicalJsonString(reviewed)
      ) {
        throw new Error("Permission selections changed. Review the current selection before applying it again.");
      }
      dispatched = true;
      publish(workspaceId, { phase: "submitted", message: "Applying the reviewed permission selection…" });
      const receipt = await activatePermissionProfile({
        profileId: input.profileId,
        workspaceId,
        surface: input.surface,
        expectedProfileRevision: reviewed.profile!.revision,
        expectedSelectionRevision: reviewed.revision,
      });
      requireActivationReceipt(receipt, reviewed);
      publish(workspaceId, {
        phase: "recorded",
        message: "Permission selection recorded by the Gateway. Review the current effective policy below.",
      });
      if (ownsAttempt()) {
        selection.clear();
        setIntent(null);
      }
      await refreshOwner(ownsAttempt);
      return true;
    } catch (error) {
      if (dispatched && !isUncommittedActivationConflict(error)) {
        publish(workspaceId, {
          phase: "uncertain",
          message:
            "Permission selection outcome is uncertain. Further selections are locked in this app session. Refresh to inspect current policy.",
        });
      } else {
        publish(workspaceId);
        if (ownsAttempt())
          setFeedback({
            identity,
            message: dispatched
              ? "The Gateway rejected a stale permission selection. Refresh and review again."
              : describeApiError(error).summary,
          });
      }
      if (ownsAttempt()) {
        selection.clear();
        setIntent(null);
      }
      await refreshOwner(ownsAttempt);
      return false;
    } finally {
      if (!dispatched && attempts.get(workspaceId)?.phase === "checking") publish(workspaceId);
    }
  }
  return {
    review,
    request,
    clear,
    confirm,
    ready,
    pending,
    locked: locked(workspaceId),
    reviewing: selection.pending,
    uncertain: attempt?.phase === "uncertain",
    restriction,
    error:
      selection.error ??
      (selection.review && currentIntent && !review
        ? "The Gateway review does not match this profile and workspace. Refresh before trying again."
        : undefined),
    notice: attempt?.message ?? (feedback?.identity === identity ? feedback.message : undefined),
  };
}

export function __resetPermissionActivationsForTests() {
  attempts.clear();
  version += 1;
  for (const listener of listeners) listener();
}
