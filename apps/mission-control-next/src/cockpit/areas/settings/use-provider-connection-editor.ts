import { useRef, useState } from "react";
import {
  canonicalJsonString,
  type ChangePlanProviderConnectionRequest,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import { createChangePlan, fetchChangePlan, fetchLlmConfig } from "@goatcitadel/mission-control-shared/api/client";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import {
  classifyMutationAttempt,
  fetchMutationAttempt,
} from "@goatcitadel/mission-control-shared/api/mutation-attempts";
import { confirmSavedProviderConnection } from "./provider-connection-verify";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import {
  dispatchTrackedMutation,
  OTHER_GATEWAY,
  sentToConnectedGateway,
  UNSETTLED_ATTEMPT_MESSAGES,
  type TrackedAttempt,
} from "../../../features/native-routes/settings/mutation-attempt-tracking";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import {
  confirmReviewedSettingsPlan,
  submitReviewedProviderCredential,
} from "../../../features/native-routes/settings/sections/provider-connection-actions";
import {
  CHECKABLE_MESSAGE,
  CONNECTION_ROUTE_PATTERNS,
  canReviewConnectionPlan,
  providerSettingsChanged,
  matchesCurrentProviderConnectionPlan,
  providerCredentialRegistrationChanged,
  connectionPlanCompleted,
  connectionPlanStopped,
  getProviderConnectionCustody,
  matchesConnectionAttempt,
  providerCredentialRequest,
  providerEndpointRequest,
  readProviderConnectionAttempt,
  setProviderConnectionAttempt,
  useProviderConnectionAttempt,
  type ProviderConnectionAttempt,
} from "./provider-connection-state";

export function useProviderConnectionEditor(
  provider: ProviderModelCatalogOption,
  revision: number,
  reload: () => Promise<unknown>,
  available: boolean,
  custody: number,
) {
  const id = provider.providerId;
  const currentCustody = () => getProviderConnectionCustody() === custody;
  const attempt = useProviderConnectionAttempt(id);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<ChangePlanRecord | null>(null);
  const reading = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const safeEndpoint = providerEndpointRequest(id, provider.baseUrl) ? provider.baseUrl : "";
  const draft = useSessionDraft(`provider-endpoint:system:${id}`, safeEndpoint, revision, {
    label: `${provider.label} endpoint`,
    available,
  });
  const blocked = Boolean(
    attempt?.busy || attempt?.uncertain || (attempt?.plan && !attempt.verified && !connectionPlanStopped(attempt.plan)),
  );

  /** `stillConnected`: re-checked after the reads, so another Gateway's state is never adopted as the saved draft. */
  async function verifySaved(
    next: ProviderConnectionAttempt,
    stillConnected: () => boolean = currentCustody,
  ): Promise<void> {
    if (!currentCustody() || !connectionPlanCompleted(next.plan)) return;
    const stillOwnsRead = () => currentCustody() && stillConnected();
    const current = await confirmSavedProviderConnection(id, next, stillOwnsRead);
    if (!stillOwnsRead()) throw new Error("The connection to GoatCitadel changed while checking the saved result.");
    if (next.request.profile?.baseUrl)
      draft.acceptSaved(next.request.profile.baseUrl, current.revision, next.request.profile.baseUrl);
    await reload();
  }

  async function create(request: ChangePlanProviderConnectionRequest) {
    if (!currentCustody()) return;
    const existing = readProviderConnectionAttempt(id);
    if (
      !available ||
      reading.current ||
      existing?.busy ||
      existing?.uncertain ||
      blocked ||
      draft.hasRemoteChanges ||
      (existing?.plan && !existing.verified && !connectionPlanStopped(existing.plan))
    )
      return;
    const baseRevision = Number(draft.baseRevision);
    const pending = {
      request,
      baseRevision,
      planKey: `provider-connection:${crypto.randomUUID()}`,
      busy: true,
      uncertain: false,
      message: "Checking the current provider…",
    };
    let transport: TrackedAttempt | undefined;
    setProviderConnectionAttempt(id, pending);
    setError("");
    let submitted = false;
    try {
      const latest = await fetchLlmConfig();
      if (!currentCustody()) return;
      if (providerSettingsChanged(latest, baseRevision, id, provider.baseUrl)) {
        setProviderConnectionAttempt(id, undefined);
        await withFreshReads(reload);
        if (currentCustody())
          setError("Provider settings changed. Review the latest version before creating a change.");
        return;
      }
      if (providerCredentialRegistrationChanged(latest, id, request)) {
        setProviderConnectionAttempt(id, undefined);
        await reload();
        if (currentCustody())
          setError("The registered credential environment variable changed. Refresh and review it before continuing.");
        return;
      }
      submitted = true;
      const plan = await dispatchTrackedMutation(
        CONNECTION_ROUTE_PATTERNS,
        () =>
          createChangePlan({ workspaceId: "default", surface: "settings", request, idempotencyKey: pending.planKey }),
        (tracked) => {
          transport = tracked;
        },
      );
      if (!currentCustody()) return;
      if (!matchesConnectionAttempt(plan, pending))
        throw new Error("The returned plan does not match the reviewed provider and settings version.");
      const next = {
        ...pending,
        plan,
        message: "Change prepared. Review the instructions before applying it.",
      };
      setProviderConnectionAttempt(id, next);
      await verifySaved(next);
      if (!currentCustody()) return;
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
      if (canReviewConnectionPlan(plan)) setDialog(plan);
    } catch {
      if (!currentCustody()) return;
      if (submitted)
        setProviderConnectionAttempt(id, {
          ...readProviderConnectionAttempt(id)!,
          busy: false,
          uncertain: true,
          transport,
          message:
            "Change creation outcome is uncertain. Inspect provider activity before making another request." +
            (transport ? CHECKABLE_MESSAGE : ""),
        });
      else {
        setProviderConnectionAttempt(id, undefined);
        setError("Could not verify current provider settings. Refresh before trying again.");
      }
    }
  }

  async function refresh() {
    if (!currentCustody()) return;
    const current = readProviderConnectionAttempt(id);
    if (!current?.plan || current.busy || reading.current) return;
    reading.current = true;
    setRefreshing(true);
    setDialog(null);
    setError("");
    setProviderConnectionAttempt(id, { ...current, busy: true });
    try {
      const plan = await fetchChangePlan(current.plan.planId, { workspaceId: "default" });
      if (!currentCustody()) return;
      if (!matchesCurrentProviderConnectionPlan(plan, current.plan, current)) {
        throw new Error("GoatCitadel returned a different change than the one you reviewed.");
      }
      const next = {
        ...current,
        plan,
        busy: true,
        verified: false,
        message: current.uncertain ? current.message : plan.summary,
      };
      setProviderConnectionAttempt(id, next);
      await verifySaved(next);
      if (!currentCustody()) return;
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
    } catch {
      if (currentCustody()) setError("The change status could not load. Your last review is kept; nothing was sent.");
    } finally {
      finishRead();
    }
  }

  async function act(reviewed: ChangePlanRecord, credential?: string) {
    if (!currentCustody()) return;
    const current = readProviderConnectionAttempt(id);
    if (
      !current?.plan ||
      current.busy ||
      current.uncertain ||
      !available ||
      !canReviewConnectionPlan(reviewed) ||
      canonicalJsonString(reviewed) !== canonicalJsonString(current.plan)
    )
      return;
    setProviderConnectionAttempt(id, { ...current, busy: true });
    setError("");
    let submitted = false;
    let transport: TrackedAttempt | undefined;
    try {
      const latest = await fetchChangePlan(reviewed.planId, { workspaceId: "default" });
      if (!currentCustody()) return;
      if (
        !matchesConnectionAttempt(latest, current) ||
        canonicalJsonString(latest) !== canonicalJsonString(reviewed) ||
        !canReviewConnectionPlan(latest)
      ) {
        setDialog(null);
        setError("This change or its instructions changed. Refresh and review the current plan before continuing.");
        return;
      }
      submitted = true;
      const plan = await dispatchTrackedMutation(
        CONNECTION_ROUTE_PATTERNS,
        () =>
          credential === undefined
            ? confirmReviewedSettingsPlan(reviewed)
            : submitReviewedProviderCredential(reviewed, credential),
        (tracked) => {
          transport = tracked;
        },
      );
      if (!currentCustody()) return;
      if (!matchesConnectionAttempt(plan, current)) throw new Error("The action returned a different provider change.");
      const next = { ...current, plan, busy: true, verified: false, message: plan.summary };
      setProviderConnectionAttempt(id, next);
      setDialog(null);
      await verifySaved(next);
      if (!currentCustody()) return;
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
    } catch {
      if (!currentCustody()) return;
      setDialog(null);
      if (submitted)
        setProviderConnectionAttempt(id, {
          ...readProviderConnectionAttempt(id)!,
          busy: false,
          uncertain: true,
          transport,
          message:
            "The change outcome is uncertain. Inspect the current plan before another request; automatic retry is disabled." +
            (transport ? CHECKABLE_MESSAGE : ""),
        });
      else setError("Could not verify the current change. Refresh before continuing; no action was sent.");
    } finally {
      clearBusy();
    }
  }

  /**
   * Settles a lost write from the Gateway's record of that exact attempt, then from canonical plan evidence. A lost
   * create that the Gateway recorded as committed replays the same plan key, which returns that one plan. A released
   * create is never replayed (a replay could insert a plan the reviewed revision no longer matches); the lock is released
   * and a new review starts from current settings, where at most one active plan per provider can exist. A lost confirm
   * or secret submit re-reads the plan, whose revision and nonce refuse a duplicate. Anything still running, unknown,
   * absent or unreadable keeps the lock.
   */
  async function checkOutcome() {
    if (!currentCustody()) return;
    const current = readProviderConnectionAttempt(id);
    const transport = current?.transport;
    if (!current?.uncertain || !transport || current.busy || reading.current || !available) return;
    // The record of an attempt lives on the installation it was sent to; never check or replay it elsewhere.
    if (!sentToConnectedGateway(transport)) {
      setProviderConnectionAttempt(id, { ...current, message: OTHER_GATEWAY });
      return;
    }
    reading.current = true;
    setRefreshing(true);
    setError("");
    const checking = { ...current, busy: true };
    setProviderConnectionAttempt(id, checking);
    let replay: TrackedAttempt | undefined;
    try {
      const verdict = classifyMutationAttempt(
        await fetchMutationAttempt(transport.attemptKey, transport.method, transport.routePattern),
      );
      if (!currentCustody() || readProviderConnectionAttempt(id) !== checking) return;
      // The operator can switch Gateway while the check runs: never replay there, and never adopt what it returns.
      const switched = () => {
        if (sentToConnectedGateway(transport)) return false;
        setProviderConnectionAttempt(id, { ...current, message: OTHER_GATEWAY });
        return true;
      };
      if (switched()) return;
      if (verdict !== "committed" && verdict !== "failed_confirm_by_readback") {
        setProviderConnectionAttempt(id, {
          ...current,
          message: UNSETTLED_ATTEMPT_MESSAGES[verdict] ?? current.message,
        });
        return;
      }
      if (!current.plan && verdict === "failed_confirm_by_readback") {
        setProviderConnectionAttempt(id, undefined);
        await reload();
        if (!currentCustody()) return;
        setError(
          "GoatCitadel released this change after an error, so it did not run again. Your draft is kept; review it against the current settings before preparing it again.",
        );
        return;
      }
      const plan = current.plan
        ? await withFreshReads(() => fetchChangePlan(current.plan!.planId, { workspaceId: "default" }))
        : current.planKey
          ? await dispatchTrackedMutation(
              CONNECTION_ROUTE_PATTERNS,
              () =>
                createChangePlan({
                  workspaceId: "default",
                  surface: "settings",
                  request: current.request,
                  idempotencyKey: current.planKey,
                }),
              (tracked) => {
                replay = tracked;
              },
            )
          : undefined;
      if (!currentCustody() || readProviderConnectionAttempt(id) !== checking || switched()) return;
      if (!plan || !matchesConnectionAttempt(plan, current))
        throw new Error("GoatCitadel returned a different change than the one you reviewed.");
      const message =
        current.plan && verdict === "failed_confirm_by_readback"
          ? "GoatCitadel released this action after an error and the plan was re-read. Review its current step before acting again."
          : plan.summary;
      const next = { ...current, plan, transport: undefined, uncertain: false, busy: true, verified: false, message };
      setProviderConnectionAttempt(id, next);
      await withFreshReads(() => verifySaved(next, () => sentToConnectedGateway(transport)));
      if (!currentCustody() || switched()) return;
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
      if (canReviewConnectionPlan(plan)) setDialog(plan);
    } catch {
      if (!currentCustody()) return;
      const latest = readProviderConnectionAttempt(id);
      const ours = latest === checking || Boolean(latest && !latest.uncertain && !latest.verified);
      // After a Gateway switch, restore the original attempt so it can still be checked on its own Gateway.
      if (ours && !sentToConnectedGateway(transport))
        setProviderConnectionAttempt(id, { ...current, message: OTHER_GATEWAY });
      else if (latest === checking)
        setProviderConnectionAttempt(id, {
          ...current,
          ...(replay ? { transport: replay } : {}),
          message: "The outcome check failed, so this change stays locked. Check again, or inspect provider activity.",
        });
      else if (latest && !latest.uncertain && !latest.verified)
        setProviderConnectionAttempt(id, {
          ...latest,
          uncertain: true,
          message:
            "The change was found, but the saved provider settings do not show it yet. Refresh the change status before another request.",
        });
    } finally {
      finishRead();
    }
  }

  function clearBusy() {
    if (!currentCustody()) return;
    const saved = readProviderConnectionAttempt(id);
    if (saved?.busy) setProviderConnectionAttempt(id, { ...saved, busy: false });
  }

  function finishRead() {
    if (!currentCustody()) return;
    clearBusy();
    reading.current = false;
    setRefreshing(false);
  }

  function prepareEndpoint() {
    if (!currentCustody()) return;
    const request = providerEndpointRequest(id, draft.value);
    if (!request) {
      setError("Enter an HTTP or HTTPS endpoint without credentials, query parameters, or a fragment.");
      return;
    }
    if (!draft.isDirty) return;
    void create(request);
  }

  function prepareCredential(storage: "keychain" | "env", envVar: string) {
    if (!currentCustody()) return;
    const request = providerCredentialRequest(id, storage, envVar);
    if (!request) {
      setError(
        "Enter an environment variable name of up to 128 letters, numbers, or underscores, starting with a letter or underscore.",
      );
      return;
    }
    void create(request);
  }

  return {
    draft,
    attempt,
    blocked,
    error,
    dialog,
    setDialog,
    refreshing,
    refresh,
    checkOutcome,
    act,
    prepareEndpoint,
    prepareCredential,
  };
}
