import { useEffect, useRef, useState } from "react";
import {
  fetchChangePlan,
  fetchSettings,
  isApiRequestError,
  patchGatewayAuthSettings,
  type RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../library/session-drafts";
import { useFormDirty } from "../library/use-form-dirty";
import { useSettingsChange } from "./use-settings-change";
import { isManagedRuntimeRevisionConflict } from "./managed-runtime-state";
import {
  authMatches,
  authReady,
  authSnapshot,
  authValues,
  beginAuthAttempt,
  finishAuthAttempt,
  matchesAuthPlan,
  normalizeAuth,
  requireAuthPlan,
  useAuthAttempt,
  type GatewayAuthValues,
} from "./gateway-auth-state";

export interface GatewayAuthReviewValue {
  revision: number;
  current: NonNullable<RuntimeSettingsResponse["auth"]>;
  submitted: GatewayAuthValues;
}
export function useGatewayAuthSettings(options: {
  settings?: RuntimeSettingsResponse;
  available: boolean;
  active?: boolean;
  reload: () => Promise<unknown>;
}) {
  const installation = getGatewayApiBaseUrl();
  const key = `access:${installation}:auth`;
  const ready = options.available && authReady(options.settings);
  const active = options.active !== false;
  const draft = useSessionDraft(key, authValues(options.settings?.auth), options.settings?.revision, {
    label: "Gateway authentication",
    active,
    available: ready,
  });
  // Credentials never enter the session draft, change-status store, browser storage, or review copy.
  const [credentialState, setCredentialState] = useState({ installation, value: "" });
  const credential = credentialState.installation === installation ? credentialState.value : "";
  const clearCredential = () =>
    setCredentialState((previous) => (previous.installation === installation ? { installation, value: "" } : previous));
  const [review, setReview] = useState<GatewayAuthReviewValue | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAuthAttempt(key);
  const live = useRef({ mounted: false, epoch: 0, identity: "" });
  const identity = authSnapshot([
    installation,
    active,
    ready,
    options.settings?.auth,
    draft.value,
    draft.baseRevision,
    credential,
  ]);
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.epoch += 1;
  }
  useEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch += 1;
    };
  }, []);
  useEffect(() => {
    setCredentialState((previous) =>
      active && previous.installation === installation ? previous : { installation, value: "" },
    );
  }, [active, installation]);
  useFormDirty(`${key}:credential`, active && Boolean(credential), {
    label: "Unsubmitted Gateway credential (clears when this editor closes)",
    keepDraft: false,
    onDiscard: clearCredential,
  });
  const change = useSettingsChange<GatewayAuthValues>({
    key,
    operation: "gateway_auth_configuration",
    matchesPlan: (plan, submitted) => getGatewayApiBaseUrl() === installation && matchesAuthPlan(plan, submitted),
    matches: authMatches,
    read: async () => {
      if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway installation changed.");
      const result = await fetchSettings();
      if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway installation changed.");
      return result;
    },
    savedValue: (submitted) => ({ ...submitted, basicUsername: "", replaceCredential: false }),
    acceptSaved: draft.acceptSaved,
    reload: async () => {
      if (live.current.mounted) return options.reload();
    },
  });
  const normalized = normalizeAuth(draft.value);
  const missingCredential =
    normalized.mode === "token"
      ? !options.settings?.auth?.tokenConfigured
      : normalized.mode === "basic" && !options.settings?.auth?.basicConfigured;
  const inputError =
    normalized.mode !== "none" && (normalized.replaceCredential || missingCredential) && !credential.trim()
      ? "Enter the new credential. Credentials clear when the editor closes."
      : normalized.mode === "basic" && !options.settings?.auth?.basicConfigured && !normalized.basicUsername
        ? "Enter a Basic username for the first Basic authentication credential."
        : undefined;
  const locked = Boolean(attempt) || change.hasPending;
  const canReview = active && ready && !locked && !draft.hasRemoteChanges && !inputError && draft.isDirty;
  const reviewCurrent = Boolean(
    review &&
    canReview &&
    review.revision === draft.baseRevision &&
    authSnapshot(review.submitted) === authSnapshot(normalized) &&
    authSnapshot(review.current) === authSnapshot(options.settings?.auth),
  );
  function requestReview() {
    if (!canReview || !options.settings?.auth) return;
    setNotice(null);
    setReview({
      revision: Number(draft.baseRevision),
      current: structuredClone(options.settings.auth),
      submitted: normalized,
    });
  }
  async function confirm(): Promise<boolean> {
    if (!review || !reviewCurrent || !beginAuthAttempt(key)) return false;
    const intent = review,
      epoch = live.current.epoch;
    const current = () =>
      live.current.mounted && live.current.epoch === epoch && getGatewayApiBaseUrl() === installation;
    let secret = credential.trim(),
      dispatched = false,
      responseReceived = false,
      acknowledged = false;
    setReview(null);
    setNotice(null);
    try {
      const latest = await fetchSettings();
      if (!current()) return false;
      if (
        !authReady(latest) ||
        latest.revision !== intent.revision ||
        authSnapshot(latest.auth) !== authSnapshot(intent.current)
      ) {
        setNotice("Gateway authentication changed. Refresh and review the retained public draft.");
        await options.reload();
        return false;
      }
      dispatched = true;
      const updated = await patchGatewayAuthSettings({
        expectedRevision: intent.revision,
        mode: intent.submitted.mode,
        allowLoopbackBypass: intent.submitted.allowLoopbackBypass,
        ...(intent.submitted.basicUsername ? { basicUsername: intent.submitted.basicUsername } : {}),
        ...(intent.submitted.replaceCredential
          ? intent.submitted.mode === "token"
            ? { token: secret }
            : { basicPassword: secret }
          : {}),
      });
      responseReceived = true;
      secret = "";
      if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway installation changed.");
      const receipt = updated.changePlanReceipt;
      if (receipt) {
        const plan = await fetchChangePlan(receipt.planId, { workspaceId: "default" });
        if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway installation changed.");
        requireAuthPlan(plan, intent.submitted, intent.revision);
        if (
          plan.planId !== receipt.planId ||
          plan.revision < receipt.revision ||
          (plan.revision === receipt.revision &&
            (plan.status !== receipt.status ||
              authSnapshot(plan.requiredAction ?? null) !== authSnapshot(receipt.requiredAction ?? null)))
        ) {
          throw new Error("Authentication change receipt does not match its recorded plan.");
        }
      }
      const owner = !receipt || ["completed", "applied"].includes(receipt.status) ? await fetchSettings() : latest;
      if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway installation changed.");
      if (!receipt || ["completed", "applied"].includes(receipt.status)) {
        const { revision: _revision, changePlanReceipt: _receipt, ...auth } = updated;
        if (owner.revision !== updated.revision || authSnapshot(owner.auth) !== authSnapshot(auth))
          throw new Error("Authentication readback did not match the owner response.");
      }
      const saved = change.receive(
        { ...owner, auth: owner.auth, revision: owner.revision, changePlanReceipt: receipt },
        intent.submitted,
        intent.revision,
      );
      acknowledged = true;
      if (current()) {
        setNotice(
          saved
            ? "Authentication posture saved and confirmed. Credential presence is confirmed; credential values are not read back."
            : "Authentication change recorded. Complete its required action and refresh settlement.",
        );
        try {
          await options.reload();
        } catch {
          /* Preserve the recorded owner receipt when its follow-up read fails. */
        }
      }
      return saved;
    } catch (error) {
      const rejected =
        dispatched &&
        !responseReceived &&
        isApiRequestError(error) &&
        error.path === "/api/v1/auth/settings" &&
        error.method === "PATCH" &&
        isManagedRuntimeRevisionConflict(error, intent.revision);
      if (rejected) {
        acknowledged = true;
        if (current()) {
          setNotice("The Gateway rejected the stale settings revision. Refresh before reviewing again.");
          try {
            await options.reload();
          } catch {
            /* Keep the draft. */
          }
        }
      } else if (!dispatched && current())
        setNotice("Current Gateway authentication could not be verified. No authentication write was sent.");
      return false;
    } finally {
      if (dispatched && live.current.mounted) clearCredential();
      finishAuthAttempt(key, dispatched && !acknowledged);
    }
  }
  function updateCredential(value: string) {
    setCredentialState({ installation, value });
    draft.setValue((previous) => ({
      ...previous,
      replaceCredential: Boolean(value.trim()) || previous.replaceCredential,
    }));
  }
  return {
    key,
    ready,
    draft,
    credential,
    updateCredential,
    change,
    attempt,
    locked,
    canReview,
    review,
    reviewCurrent,
    notice,
    inputError,
    requestReview,
    confirm,
    cancel: () => setReview(null),
    discard: () => {
      draft.discard();
      clearCredential();
    },
    clearCredential,
  };
}
