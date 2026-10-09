import { useRef, useState } from "react";
import { canonicalJsonString, type ChangePlanProviderConnectionRequest, type ChangePlanRecord } from "@goatcitadel/contracts";
import { createChangePlan, fetchChangePlan, fetchLlmConfig, fetchProviderSecretStatus } from "@goatcitadel/mission-control-shared/api/client";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { classifyMutationAttempt, fetchMutationAttempt } from "@goatcitadel/mission-control-shared/api/mutation-attempts";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { dispatchTrackedMutation, OTHER_GATEWAY, sentToConnectedGateway, UNSETTLED_ATTEMPT_MESSAGES, type TrackedAttempt } from "../../../features/native-routes/settings/mutation-attempt-tracking";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import { confirmReviewedSettingsPlan, submitReviewedProviderCredential } from "../../../features/native-routes/settings/sections/provider-connection-actions";
import { canReviewConnectionPlan, connectionPlanCompleted, connectionPlanStopped, matchesConnectionAttempt,
  providerCredentialRequest, providerEndpointRequest, readProviderConnectionAttempt, setProviderConnectionAttempt, useProviderConnectionAttempt,
  type ProviderConnectionAttempt } from "./provider-connection-state";

/** The Gateway routes this owner writes through; a lost write on any of them can be settled from its attempt record. */
const CONNECTION_ROUTE_PATTERNS = [
  "/api/v1/change-plans",
  "/api/v1/change-plans/:planId/confirmations",
  "/api/v1/change-plans/:planId/provider-secret",
] as const;
const CHECKABLE_MESSAGE = " Check its outcome to settle it from the Gateway's record of this attempt.";

export function useProviderConnectionEditor(provider: ProviderModelCatalogOption, revision: number, reload: () => Promise<unknown>, available: boolean) {
  const id = provider.providerId;
  const attempt = useProviderConnectionAttempt(id);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<ChangePlanRecord | null>(null);
  const reading = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const safeEndpoint = providerEndpointRequest(id, provider.baseUrl) ? provider.baseUrl : "";
  const draft = useSessionDraft(`provider-endpoint:system:${id}`, safeEndpoint, revision,
    { label: `${provider.label} endpoint`, available });
  const blocked = Boolean(attempt?.busy || attempt?.uncertain || (attempt?.plan && !attempt.verified && !connectionPlanStopped(attempt.plan)));

  /** `stillConnected`: re-checked after the reads, so another Gateway's state is never adopted as the saved draft. */
  async function verifySaved(next: ProviderConnectionAttempt, stillConnected: () => boolean = () => true): Promise<void> {
    if (!connectionPlanCompleted(next.plan)) return;
    const current = await fetchLlmConfig();
    const saved = current.providers.find((item) => item.providerId === id);
    if (!Number.isSafeInteger(current.revision) || current.revision <= next.baseRevision || !saved
      || (next.request.profile?.baseUrl && saved.baseUrl !== next.request.profile.baseUrl)) {
      throw new Error("The current provider does not confirm the completed change.");
    }
    if (next.request.credentialAction === "replace_api_key") {
      const status = await fetchProviderSecretStatus(id);
      const storage = next.request.credentialStorage ?? "keychain";
      if (status.providerId !== id || !status.hasSecret || status.source !== storage || saved.apiKeySource !== storage
        || (storage === "env" && saved.apiKeyRef !== next.request.credentialEnvVar)) {
        throw new Error("The credential owner has not confirmed the selected storage target.");
      }
    }
    if (!stillConnected()) throw new Error("The Gateway connection changed during the readback.");
    if (next.request.profile?.baseUrl) draft.acceptSaved(next.request.profile.baseUrl, current.revision, next.request.profile.baseUrl);
    await reload();
  }

  async function create(request: ChangePlanProviderConnectionRequest) {
    const existing = readProviderConnectionAttempt(id);
    if (!available || reading.current || existing?.busy || existing?.uncertain || blocked || draft.hasRemoteChanges
      || (existing?.plan && !existing.verified && !connectionPlanStopped(existing.plan))) return;
    const baseRevision = Number(draft.baseRevision);
    const pending = { request, baseRevision, planKey: `provider-connection:${crypto.randomUUID()}`, busy: true, uncertain: false,
      message: "Checking the current provider…" };
    let transport: TrackedAttempt | undefined;
    setProviderConnectionAttempt(id, pending); setError("");
    let submitted = false;
    try {
      const latest = await fetchLlmConfig();
      if (latest.revision !== baseRevision || latest.providers.find((item) => item.providerId === id)?.baseUrl !== provider.baseUrl) {
        setProviderConnectionAttempt(id, undefined);
        await withFreshReads(reload); setError("Provider settings changed. Review the current revision before creating a change."); return;
      }
      if (request.credentialStorage === "env"
        && latest.providerConfigs?.find((item) => item.providerId === id)?.apiKeyEnv?.trim() !== request.credentialEnvVar) {
        setProviderConnectionAttempt(id, undefined);
        await reload(); setError("The registered credential environment variable changed. Refresh and review its current owner before continuing."); return;
      }
      submitted = true;
      const plan = await dispatchTrackedMutation(CONNECTION_ROUTE_PATTERNS,
        () => createChangePlan({ workspaceId: "default", surface: "settings", request, idempotencyKey: pending.planKey }),
        (tracked) => { transport = tracked; });
      if (!matchesConnectionAttempt(plan, pending)) throw new Error("The returned plan does not match the reviewed provider and settings revision.");
      const next = { ...pending, plan, message: "Change prepared. Review the Gateway instructions before applying it." };
      setProviderConnectionAttempt(id, next);
      await verifySaved(next);
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
      if (canReviewConnectionPlan(plan)) setDialog(plan);
    } catch {
      if (submitted) setProviderConnectionAttempt(id, { ...readProviderConnectionAttempt(id)!, busy: false, uncertain: true, transport,
        message: "Change creation outcome is uncertain. Inspect provider activity before making another request." + (transport ? CHECKABLE_MESSAGE : "") });
      else { setProviderConnectionAttempt(id, undefined); setError("Could not verify current provider settings. Refresh before trying again."); }
    }
  }

  async function refresh() {
    const current = readProviderConnectionAttempt(id);
    if (!current?.plan || current.busy || reading.current) return;
    reading.current = true; setRefreshing(true); setDialog(null); setError("");
    setProviderConnectionAttempt(id, { ...current, busy: true });
    try {
      const plan = await fetchChangePlan(current.plan.planId, { workspaceId: "default" });
      if (plan.planId !== current.plan.planId || plan.revision < current.plan.revision || !matchesConnectionAttempt(plan, current)) {
        throw new Error("The Gateway returned different change evidence.");
      }
      const next = { ...current, plan, busy: true, verified: false, message: current.uncertain ? current.message : plan.summary };
      setProviderConnectionAttempt(id, next); await verifySaved(next);
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
    } catch { setError("Current change evidence is unavailable. The last reviewed state is retained; no action was sent."); }
    finally {
      const saved = readProviderConnectionAttempt(id);
      if (saved?.busy) setProviderConnectionAttempt(id, { ...saved, busy: false });
      reading.current = false; setRefreshing(false);
    }
  }

  async function act(reviewed: ChangePlanRecord, credential?: string) {
    const current = readProviderConnectionAttempt(id);
    if (!current?.plan || current.busy || current.uncertain || !available || !canReviewConnectionPlan(reviewed)
      || canonicalJsonString(reviewed) !== canonicalJsonString(current.plan)) return;
    setProviderConnectionAttempt(id, { ...current, busy: true }); setError("");
    let submitted = false;
    let transport: TrackedAttempt | undefined;
    try {
      const latest = await fetchChangePlan(reviewed.planId, { workspaceId: "default" });
      if (!matchesConnectionAttempt(latest, current) || canonicalJsonString(latest) !== canonicalJsonString(reviewed) || !canReviewConnectionPlan(latest)) {
        setDialog(null); setError("This change or its instructions changed. Refresh and review the current plan before continuing."); return;
      }
      submitted = true;
      const plan = await dispatchTrackedMutation(CONNECTION_ROUTE_PATTERNS,
        () => credential === undefined ? confirmReviewedSettingsPlan(reviewed) : submitReviewedProviderCredential(reviewed, credential),
        (tracked) => { transport = tracked; });
      if (!matchesConnectionAttempt(plan, current)) throw new Error("The action returned a different provider change.");
      const next = { ...current, plan, busy: true, verified: false, message: plan.summary };
      setProviderConnectionAttempt(id, next); setDialog(null);
      await verifySaved(next);
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
    } catch {
      setDialog(null);
      if (submitted) setProviderConnectionAttempt(id, { ...readProviderConnectionAttempt(id)!, busy: false, uncertain: true, transport,
        message: "The change outcome is uncertain. Inspect the current plan before another request; automatic retry is disabled." + (transport ? CHECKABLE_MESSAGE : "") });
      else setError("Could not verify the current change. Refresh before continuing; no action was sent.");
    } finally {
      const saved = readProviderConnectionAttempt(id);
      if (saved?.busy) setProviderConnectionAttempt(id, { ...saved, busy: false });
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
    const current = readProviderConnectionAttempt(id);
    const transport = current?.transport;
    if (!current?.uncertain || !transport || current.busy || reading.current || !available) return;
    // The record of an attempt lives on the installation it was sent to; never check or replay it elsewhere.
    if (!sentToConnectedGateway(transport)) {
      setProviderConnectionAttempt(id, { ...current, message: OTHER_GATEWAY });
      return;
    }
    reading.current = true; setRefreshing(true); setError("");
    const checking = { ...current, busy: true };
    setProviderConnectionAttempt(id, checking);
    let replay: TrackedAttempt | undefined;
    try {
      const verdict = classifyMutationAttempt(await fetchMutationAttempt(transport.attemptKey, transport.method, transport.routePattern));
      if (readProviderConnectionAttempt(id) !== checking) return;
      // The operator can switch Gateway while the check runs: never replay there, and never adopt what it returns.
      const switched = () => {
        if (sentToConnectedGateway(transport)) return false;
        setProviderConnectionAttempt(id, { ...current, message: OTHER_GATEWAY });
        return true;
      };
      if (switched()) return;
      if (verdict !== "committed" && verdict !== "failed_confirm_by_readback") {
        setProviderConnectionAttempt(id, { ...current, message: UNSETTLED_ATTEMPT_MESSAGES[verdict] ?? current.message });
        return;
      }
      if (!current.plan && verdict === "failed_confirm_by_readback") {
        setProviderConnectionAttempt(id, undefined);
        await reload();
        setError("The Gateway released this change after an error, so it was not replayed. Your draft is kept; review it against the current settings before preparing it again.");
        return;
      }
      const plan = current.plan
        ? await withFreshReads(() => fetchChangePlan(current.plan!.planId, { workspaceId: "default" }))
        : current.planKey
          ? await dispatchTrackedMutation(CONNECTION_ROUTE_PATTERNS,
            () => createChangePlan({ workspaceId: "default", surface: "settings", request: current.request, idempotencyKey: current.planKey }),
            (tracked) => { replay = tracked; })
          : undefined;
      if (readProviderConnectionAttempt(id) !== checking || switched()) return;
      if (!plan || !matchesConnectionAttempt(plan, current)) throw new Error("The Gateway returned different change evidence.");
      const message = current.plan && verdict === "failed_confirm_by_readback"
        ? "The Gateway released this action after an error and the plan was re-read. Review its current step before acting again."
        : plan.summary;
      const next = { ...current, plan, transport: undefined, uncertain: false, busy: true, verified: false, message };
      setProviderConnectionAttempt(id, next);
      await withFreshReads(() => verifySaved(next, () => sentToConnectedGateway(transport)));
      if (switched()) return;
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
      if (canReviewConnectionPlan(plan)) setDialog(plan);
    } catch {
      const latest = readProviderConnectionAttempt(id);
      const ours = latest === checking || Boolean(latest && !latest.uncertain && !latest.verified);
      // After a Gateway switch, restore the original attempt so it can still be checked on its own Gateway.
      if (ours && !sentToConnectedGateway(transport)) setProviderConnectionAttempt(id, { ...current, message: OTHER_GATEWAY });
      else if (latest === checking) setProviderConnectionAttempt(id, { ...current, ...(replay ? { transport: replay } : {}),
        message: "The outcome check failed, so this change stays locked. Check again, or inspect provider activity." });
      else if (latest && !latest.uncertain && !latest.verified) setProviderConnectionAttempt(id, { ...latest, uncertain: true,
        message: "The plan was recovered, but current provider evidence does not confirm it yet. Inspect provider activity before another request." });
    } finally {
      const saved = readProviderConnectionAttempt(id);
      if (saved?.busy) setProviderConnectionAttempt(id, { ...saved, busy: false });
      reading.current = false; setRefreshing(false);
    }
  }

  function prepareEndpoint() {
    const request = providerEndpointRequest(id, draft.value);
    if (!request) { setError("Enter an HTTP or HTTPS endpoint without credentials, query parameters, or a fragment."); return; }
    if (!draft.isDirty) return;
    void create(request);
  }

  function prepareCredential(storage: "keychain" | "env", envVar: string) {
    const request = providerCredentialRequest(id, storage, envVar);
    if (!request) { setError("Enter an environment variable name of up to 128 letters, numbers, or underscores, starting with a letter or underscore."); return; }
    void create(request);
  }

  return { draft, attempt, blocked, error, dialog, setDialog, refreshing, refresh, checkOutcome, act, prepareEndpoint, prepareCredential };
}
