import { useRef, useState } from "react";
import { canonicalJsonString, type ChangePlanProviderConnectionRequest, type ChangePlanRecord } from "@goatcitadel/contracts";
import { createChangePlan, fetchChangePlan, fetchLlmConfig, fetchProviderSecretStatus } from "@goatcitadel/mission-control-shared/api/client";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { confirmReviewedSettingsPlan, submitReviewedProviderCredential } from "../../../features/native-routes/settings/sections/provider-connection-actions";
import { canReviewConnectionPlan, connectionPlanCompleted, connectionPlanStopped, matchesConnectionAttempt,
  providerCredentialRequest, providerEndpointRequest, readProviderConnectionAttempt, setProviderConnectionAttempt, useProviderConnectionAttempt,
  type ProviderConnectionAttempt } from "./provider-connection-state";

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

  async function verifySaved(next: ProviderConnectionAttempt): Promise<void> {
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
    if (next.request.profile?.baseUrl) draft.acceptSaved(next.request.profile.baseUrl, current.revision, next.request.profile.baseUrl);
    await reload();
  }

  async function create(request: ChangePlanProviderConnectionRequest) {
    const existing = readProviderConnectionAttempt(id);
    if (!available || reading.current || existing?.busy || existing?.uncertain || blocked || draft.hasRemoteChanges
      || (existing?.plan && !existing.verified && !connectionPlanStopped(existing.plan))) return;
    const baseRevision = Number(draft.baseRevision);
    const pending = { request, baseRevision, busy: true, uncertain: false, message: "Checking the current provider…" };
    setProviderConnectionAttempt(id, pending); setError("");
    let submitted = false;
    try {
      const latest = await fetchLlmConfig();
      if (latest.revision !== baseRevision || latest.providers.find((item) => item.providerId === id)?.baseUrl !== provider.baseUrl) {
        setProviderConnectionAttempt(id, undefined);
        await reload(); setError("Provider settings changed. Review the current revision before creating a change."); return;
      }
      if (request.credentialStorage === "env"
        && latest.providerConfigs?.find((item) => item.providerId === id)?.apiKeyEnv?.trim() !== request.credentialEnvVar) {
        setProviderConnectionAttempt(id, undefined);
        await reload(); setError("The registered credential environment variable changed. Refresh and review its current owner before continuing."); return;
      }
      submitted = true;
      const plan = await createChangePlan({ workspaceId: "default", surface: "settings", request });
      if (!matchesConnectionAttempt(plan, pending)) throw new Error("The returned plan does not match the reviewed provider and settings revision.");
      const next = { ...pending, plan, message: "Change prepared. Review the Gateway instructions before applying it." };
      setProviderConnectionAttempt(id, next);
      await verifySaved(next);
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
      if (canReviewConnectionPlan(plan)) setDialog(plan);
    } catch {
      if (submitted) setProviderConnectionAttempt(id, { ...readProviderConnectionAttempt(id)!, busy: false, uncertain: true,
        message: "Change creation outcome is uncertain. Inspect provider activity before making another request." });
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
    try {
      const latest = await fetchChangePlan(reviewed.planId, { workspaceId: "default" });
      if (!matchesConnectionAttempt(latest, current) || canonicalJsonString(latest) !== canonicalJsonString(reviewed) || !canReviewConnectionPlan(latest)) {
        setDialog(null); setError("This change or its instructions changed. Refresh and review the current plan before continuing."); return;
      }
      submitted = true;
      const plan = credential === undefined ? await confirmReviewedSettingsPlan(reviewed) : await submitReviewedProviderCredential(reviewed, credential);
      if (!matchesConnectionAttempt(plan, current)) throw new Error("The action returned a different provider change.");
      const next = { ...current, plan, busy: true, verified: false, message: plan.summary };
      setProviderConnectionAttempt(id, next); setDialog(null);
      await verifySaved(next);
      setProviderConnectionAttempt(id, { ...next, busy: false, verified: connectionPlanCompleted(plan) });
    } catch {
      setDialog(null);
      if (submitted) setProviderConnectionAttempt(id, { ...readProviderConnectionAttempt(id)!, busy: false, uncertain: true,
        message: "The change outcome is uncertain. Inspect the current plan before another request; automatic retry is disabled." });
      else setError("Could not verify the current change. Refresh before continuing; no action was sent.");
    } finally {
      const saved = readProviderConnectionAttempt(id);
      if (saved?.busy) setProviderConnectionAttempt(id, { ...saved, busy: false });
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

  return { draft, attempt, blocked, error, dialog, setDialog, refreshing, refresh, act, prepareEndpoint, prepareCredential };
}
