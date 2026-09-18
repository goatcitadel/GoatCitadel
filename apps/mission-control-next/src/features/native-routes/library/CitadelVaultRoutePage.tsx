import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, Trash2 } from "lucide-react";
import {
  deleteCitadelVaultSecret,
  revealCitadelVaultSecret,
  storeCitadelVaultSecret,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { DetailInspector } from "../../../components/DetailInspector";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";
import { describeVaultError, useCitadelVaultReview } from "./useCitadelVaultReview";
import { CitadelVaultReview } from "./CitadelVaultReview";
import "./citadel-confirmation.css";

const EMPTY_SECRET = { name: "", value: "" };

/**
 * The Vault (spec §13 MVP). Secrets are sealed with AES-256-GCM under a per-Citadel
 * master key held in the OS keychain; the plaintext is never persisted. The list
 * shows names only — revealing a value is an explicit, per-secret action.
 */
export function CitadelVaultRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelId = activeWorkspaceId,
  activeCitadelName = activeWorkspaceName,
}: NativeRoutePagesProps) {
  const nameId = useId();
  const valueId = useId();
  const vault = useCitadelVaultReview(activeCitadelId);
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const leave = useDraftLeave();
  const secretDraft = useSessionDraft(`vault-secret:${activeCitadelId}:new`, EMPTY_SECRET, vault.snapshot?.revision, {
    label: "New secret", active: formOpen, available: Boolean(vault.snapshot), onSave: (): Promise<boolean> => store(),
  });
  const draft = secretDraft.value;
  const setDraft = secretDraft.setValue;
  const [pendingStore, setPendingStore] = useState<{ draft: typeof EMPTY_SECRET; revision: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string; revision: string } | null>(null);
  const revealGeneration = useRef(0);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});
  const busy = vault.busy;
  const reviewRequired = vault.reviewRequired || secretDraft.hasRemoteChanges;
  const canStore = vault.ready && !reviewRequired && !pendingStore;
  const items = vault.snapshot?.items ?? [];
  const selectedSecret = items.find((item) => item.secretId === selectedSecretId);

  const clearReveals = useCallback(() => {
    revealGeneration.current += 1; setRevealed({}); setRevealErrors({});
  }, []);
  useEffect(() => {
    clearReveals(); setFormOpen(false); setSelectedSecretId(null); setPendingDelete(null); setPendingStore(null);
    return () => { revealGeneration.current += 1; };
  }, [activeCitadelId, clearReveals]);

  const save = async (submitted: typeof EMPTY_SECRET, revision: string) => {
    const saved = await vault.run(revision, () => storeCitadelVaultSecret(activeCitadelId, submitted.name.trim(), submitted.value, revision));
    if (!vault.isCurrent()) return false;
    setPendingStore(null); clearReveals();
    if (!saved) return false;
    if (secretDraft.acceptSaved(EMPTY_SECRET, saved.revision, submitted)) setFormOpen(false);
    return true;
  };
  const store = async () => {
    const revision = secretDraft.baseRevision;
    if (!canStore || typeof revision !== "string" || !draft.name.trim() || !draft.value) return false;
    if (items.some((item) => item.secretName === draft.name.trim())) {
      setPendingStore({ draft: { ...draft }, revision });
      return false;
    }
    return await save(draft, revision);
  };
  const remove = async () => {
    if (!pendingDelete) return;
    const saved = await vault.run(pendingDelete.revision, () => deleteCitadelVaultSecret(activeCitadelId, pendingDelete.id, pendingDelete.revision));
    if (!vault.isCurrent()) return;
    setPendingDelete(null); setSelectedSecretId(null); clearReveals();
    if (saved && !secretDraft.isDirty) secretDraft.acceptSaved(EMPTY_SECRET, saved.revision);
  };
  const reveal = async (secretId: string) => {
    const generation = ++revealGeneration.current;
    try {
      const value = await revealCitadelVaultSecret(activeCitadelId, secretId);
      if (!vault.isCurrent() || generation !== revealGeneration.current) return;
      setRevealed({ [secretId]: value }); setRevealErrors({});
    } catch (error) {
      if (!vault.isCurrent() || generation !== revealGeneration.current) return;
      setRevealed({}); setRevealErrors({ [secretId]: describeVaultError(error) });
    }
  };
  useEffect(() => {
    if (!Object.keys(revealed).length) return;
    const timer = globalThis.setTimeout(clearReveals, 30_000);
    return () => globalThis.clearTimeout(timer);
  }, [clearReveals, revealed]);
  const closeDetails = () => leave.request(() => {
    clearReveals(); setFormOpen(false); setSelectedSecretId(null); setPendingStore(null);
  }, [secretDraft.key]);
  const currentReview = reviewRequired ? <CitadelVaultReview snapshot={vault.snapshot} loading={vault.loading} onReload={() => void vault.reload()} onAccept={() => {
    secretDraft.rebaseToCurrent(); vault.acceptReview();
  }} /> : null;

  return (
    <NativePageFrame
      icon={KeyRound}
      area="library"
      kicker={routeKicker(route)}
      title="Vault"
      description={`Secrets for ${activeCitadelName}, sealed at rest under a per-Citadel key in your OS keychain. Names are listed; values are revealed only on request.`}
      loading={vault.loading && !vault.snapshot && !reviewRequired}
      error={!vault.snapshot && !reviewRequired ? vault.error : null}
      onRetry={() => void vault.reload()}
    >
      {!formOpen ? currentReview : null}
      {vault.error && !formOpen ? <NoticeBanner tone="error" message={vault.error} /> : null}
      {vault.snapshot?.record?.lifecycleStatus === "archived" ? <NoticeBanner tone="warning" message="Restore this Citadel before changing its Vault." /> : null}
      <div className="mc-next-settings-button-row"><NativeButton disabled={busy || !vault.snapshot} onClick={() => leave.request(() => { clearReveals(); setSelectedSecretId(null); setFormOpen(true); }, [secretDraft.key])}>Store secret{secretDraft.isDirty ? " · Unsaved" : ""}</NativeButton></div>
      <NativeGrid className="mc-next-calm-directory">
        <NativeCard
          title="Stored secrets"
          subtitle="The plaintext is never persisted — only the sealed envelope."
          stats={[{ label: "Secrets", value: String(items.length) }]}
        >
          {items.length === 0 ? (
            <EmptyState size="compact" title="No secrets stored yet." />
          ) : (
            <ul className="mc-next-vault-list">
              {items.map((secret) => (
                <li key={secret.secretId} className="mc-next-vault-item">
                  <div className="mc-next-vault-item-head">
                    <NativeButton variant="ghost" onClick={() => leave.request(() => { clearReveals(); setFormOpen(false); setSelectedSecretId(secret.secretId); }, [secretDraft.key])}>{secret.secretName}</NativeButton>

                  </div>
                </li>
              ))}
            </ul>
          )}
        </NativeCard>

        <DetailInspector open={formOpen} title="Store a secret" subtitle={secretDraft.isDirty ? "Unsaved changes" : undefined} onClose={closeDetails}>

          {currentReview}
          {vault.error ? <NoticeBanner tone="error" message={vault.error} /> : null}
          <label className="mc-next-mason-field" htmlFor={nameId}>
            <span>Name</span>
            <input
              id={nameId}
              className="mc-next-settings-input"
              value={draft.name}
              placeholder="stripe-secret-key"
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="mc-next-mason-field" htmlFor={valueId}>
            <span>Value</span>
            <input
              id={valueId}
              type="password"
              className="mc-next-settings-input"
              value={draft.value}
              placeholder="sk-live-…"
              onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))}
            />
          </label>
          <NativeButton
            variant="default"
            disabled={!canStore || draft.name.trim().length === 0 || draft.value.length === 0}
            onClick={() => void store()}
          >
            <Lock size={16} />
            {busy ? "Sealing…" : "Seal & store"}
          </NativeButton>

</DetailInspector>
      </NativeGrid>

      {leave.dialog}
      <DetailInspector open={Boolean(selectedSecret)} title={selectedSecret?.secretName ?? "Secret"} subtitle="Vault value · hides after 30 seconds or closing" onClose={closeDetails}>
        {selectedSecret ? <>
          <dl className="mc-next-native-facts">{Object.entries(selectedSecret).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1")}</dt><dd>{String(value ?? "Unavailable")}</dd></div>)}</dl>
          <div className="mc-next-settings-button-row">
            <NativeButton onClick={() => revealed[selectedSecret.secretId] === undefined ? void reveal(selectedSecret.secretId) : clearReveals()}>{revealed[selectedSecret.secretId] === undefined ? <><Eye size={16} /> Reveal</> : <><EyeOff size={16} /> Hide</>}</NativeButton>
            <NativeButton disabled={!vault.ready || reviewRequired} variant="destructive" aria-label={`Delete ${selectedSecret.secretName}`} onClick={() => vault.snapshot && setPendingDelete({ id: selectedSecret.secretId, name: selectedSecret.secretName, revision: vault.snapshot.revision })}><Trash2 size={16} />Delete secret</NativeButton>
          </div>
          {revealed[selectedSecret.secretId] !== undefined ? <code className="mc-next-vault-value">{revealed[selectedSecret.secretId]}</code> : null}
          {revealErrors[selectedSecret.secretId] ? <NoticeBanner tone="error" message={revealErrors[selectedSecret.secretId]} /> : null}
        </> : null}
      </DetailInspector>
      <ConfirmModal
        className="mc-next-citadel-confirmation"
        pending={busy}
        open={pendingDelete !== null}
        danger
        title="Delete secret?"
        message={`Delete "${pendingDelete?.name}"? This permanently removes the stored secret and cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          void remove();
        }}
      />

      <ConfirmModal
        className="mc-next-citadel-confirmation"
        open={pendingStore !== null}
        danger
        pending={busy}
        title="Replace secret?"
        message={`Replace "${pendingStore?.draft.name.trim()}" with the value you entered? The previous value cannot be recovered.`}
        confirmLabel="Replace secret"
        onCancel={() => setPendingStore(null)}
        onConfirm={() => { if (pendingStore) void save(pendingStore.draft, pendingStore.revision); }}
      />
      <p className="mc-next-citadel-footnote">
        <Lock size={12} aria-hidden="true" />
        AES-256-GCM, sealed under a per-Citadel key in your OS keychain. Per-Chamber keys and rotation are the deferred
        follow-on.
      </p>
    </NativePageFrame>
  );
}
