import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, Trash2 } from "lucide-react";
import type { CitadelVaultSecretMetadata } from "@goatcitadel/contracts";
import {
  deleteCitadelVaultSecret,
  isApiRequestError,
  listCitadelVaultSecrets,
  revealCitadelVaultSecret,
  storeCitadelVaultSecret,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
import { DetailInspector } from "../../../components/DetailInspector";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

interface SecretsState {
  loading: boolean;
  error: string | null;
  items: CitadelVaultSecretMetadata[];
}

const EMPTY_SECRET = { name: "", value: "" };

function describeStoreError(error: unknown): string {
  if (isApiRequestError(error) && error.status === 503) {
    return "Vault unavailable — your OS keychain could not provide a key. Secrets are never written in plaintext.";
  }
  return getErrorMessage(error);
}

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
  const [secrets, setSecrets] = useState<SecretsState>({ loading: true, error: null, items: [] });
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const leave = useDraftLeave();
  const secretDraft = useSessionDraft(`vault-secret:${activeCitadelId}:new`, EMPTY_SECRET, undefined, { label: "New secret", active: formOpen, onSave: (): Promise<boolean> => store() });
  const draft = secretDraft.value;
  const setDraft = secretDraft.setValue;
  const acceptSavedSecret = secretDraft.acceptSaved;
  const revealGeneration = useRef(0);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  // Reveal failures are tracked separately from revealed plaintext so an error message is
  // never rendered inside the secret-value <code> block (which would look like the secret).
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setSecrets((current) => ({ ...current, loading: true, error: null }));
    try {
      const items = await listCitadelVaultSecrets(activeCitadelId);
      setSecrets({ loading: false, error: null, items });
    } catch (error) {
      setSecrets({ loading: false, error: getErrorMessage(error), items: [] });
    }
  }, [activeCitadelId]);

  useEffect(() => {
    let cancelled = false;
    setSecrets((current) => ({ ...current, loading: true, error: null }));
    void listCitadelVaultSecrets(activeCitadelId)
      .then((items) => {
        if (!cancelled) {
          setSecrets({ loading: false, error: null, items });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSecrets({ loading: false, error: getErrorMessage(error), items: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeCitadelId]);

  const store = useCallback(async () => {
    if (draft.name.trim().length === 0 || draft.value.length === 0) {
      return false;
    }
    setBusy(true); setStoreError(null);
    try {
      await storeCitadelVaultSecret(activeCitadelId, draft.name.trim(), draft.value);
      const clean = acceptSavedSecret(EMPTY_SECRET, undefined, draft);
      if (clean) setFormOpen(false);
      await load();
      return true;
    } catch (error) {
      setStoreError(describeStoreError(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [activeCitadelId, draft, load, acceptSavedSecret]);

  const clearRevealError = useCallback((secretId: string) => {
    setRevealErrors((current) => {
      if (current[secretId] === undefined) {
        return current;
      }
      const next = { ...current };
      delete next[secretId];
      return next;
    });
  }, []);

  const reveal = useCallback(
    async (secretId: string) => {
      try {
        const generation = revealGeneration.current;
        const value = await revealCitadelVaultSecret(activeCitadelId, secretId);
        if (generation !== revealGeneration.current) return;
        setRevealed((current) => ({ ...current, [secretId]: value }));
        clearRevealError(secretId);
      } catch (error) {
        // Record the failure separately and leave `revealed` unset so the button stays on
        // "Reveal" and the error is shown as an error, not as the secret value.
        setRevealErrors((current) => ({ ...current, [secretId]: describeStoreError(error) }));
      }
    },
    [activeCitadelId, clearRevealError],
  );

  const hide = useCallback(
    (secretId: string) => {
      setRevealed((current) => {
        const next = { ...current };
        delete next[secretId];
        return next;
      });
      clearRevealError(secretId);
    },
    [clearRevealError],
  );

  useEffect(() => {
    if (!Object.keys(revealed).length) return;
    const timer = globalThis.setTimeout(() => setRevealed({}), 30_000);
    return () => globalThis.clearTimeout(timer);
  }, [revealed]);
  const closeDetails = () => leave.request(() => {
    revealGeneration.current += 1; setRevealed({}); setRevealErrors({});
    setFormOpen(false); setSelectedSecretId(null);
  }, [secretDraft.key]);
  useEffect(() => () => { revealGeneration.current += 1; }, [activeCitadelId]);
  const selectedSecret = secrets.items.find((item) => item.secretId === selectedSecretId);

  const remove = useCallback(
    async (secretId: string) => {
      try {
        await deleteCitadelVaultSecret(activeCitadelId, secretId);
        hide(secretId);
        await load();
      } catch (error) {
        setSecrets((current) => ({ ...current, error: getErrorMessage(error) }));
      }
    },
    [activeCitadelId, hide, load],
  );

  return (
    <NativePageFrame
      icon={KeyRound}
      area="library"
      kicker={routeKicker(route)}
      title="Vault"
      description={`Secrets for ${activeCitadelName}, sealed at rest under a per-Citadel key in your OS keychain. Names are listed; values are revealed only on request.`}
      loading={secrets.loading && !secrets.items.length}
      error={secrets.error}
      onRetry={() => void load()}
    >
      <div className="mc-next-settings-button-row"><NativeButton onClick={() => leave.request(() => { revealGeneration.current += 1; setRevealed({}); setSelectedSecretId(null); setFormOpen(true); }, [secretDraft.key])}>Store secret{secretDraft.isDirty ? " · Unsaved" : ""}</NativeButton></div>
      <NativeGrid className="mc-next-calm-directory">
        <NativeCard
          title="Stored secrets"
          subtitle="The plaintext is never persisted — only the sealed envelope."
          stats={[{ label: "Secrets", value: String(secrets.items.length) }]}
        >
          {secrets.items.length === 0 ? (
            <EmptyState size="compact" title="No secrets stored yet." />
          ) : (
            <ul className="mc-next-vault-list">
              {secrets.items.map((secret) => (
                <li key={secret.secretId} className="mc-next-vault-item">
                  <div className="mc-next-vault-item-head">
                    <NativeButton variant="ghost" onClick={() => leave.request(() => { revealGeneration.current += 1; setRevealed({}); setFormOpen(false); setSelectedSecretId(secret.secretId); }, [secretDraft.key])}>{secret.secretName}</NativeButton>

                  </div>
                </li>
              ))}
            </ul>
          )}
        </NativeCard>

        <DetailInspector open={formOpen} title="Store a secret" subtitle={secretDraft.isDirty ? "Unsaved changes" : undefined} onClose={closeDetails}>

          {storeError ? <NoticeBanner tone="error" message={storeError} /> : null}
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
            disabled={busy || draft.name.trim().length === 0 || draft.value.length === 0}
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
            <NativeButton onClick={() => revealed[selectedSecret.secretId] === undefined ? void reveal(selectedSecret.secretId) : hide(selectedSecret.secretId)}>{revealed[selectedSecret.secretId] === undefined ? <><Eye size={16} /> Reveal</> : <><EyeOff size={16} /> Hide</>}</NativeButton>
            <NativeButton variant="destructive" aria-label={`Delete ${selectedSecret.secretName}`} onClick={() => setPendingDelete({ id: selectedSecret.secretId, name: selectedSecret.secretName })}><Trash2 size={16} />Delete secret</NativeButton>
          </div>
          {revealed[selectedSecret.secretId] !== undefined ? <code className="mc-next-vault-value">{revealed[selectedSecret.secretId]}</code> : null}
          {revealErrors[selectedSecret.secretId] ? <NoticeBanner tone="error" message={revealErrors[selectedSecret.secretId]} /> : null}
        </> : null}
      </DetailInspector>
      <ConfirmModal
        open={pendingDelete !== null}
        danger
        title="Delete secret?"
        message={`Delete "${pendingDelete?.name}"? This permanently removes the stored secret and cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void remove(pendingDelete.id);
          setPendingDelete(null);
        }}
      />

      <p className="mc-next-citadel-footnote">
        <Lock size={12} aria-hidden="true" />
        AES-256-GCM, sealed under a per-Citadel key in your OS keychain. Per-Chamber keys and rotation are the deferred
        follow-on.
      </p>
    </NativePageFrame>
  );
}
