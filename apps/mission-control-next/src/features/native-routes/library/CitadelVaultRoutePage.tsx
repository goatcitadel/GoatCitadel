import { useCallback, useEffect, useId, useState } from "react";
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
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

interface SecretsState {
  loading: boolean;
  error: string | null;
  items: CitadelVaultSecretMetadata[];
}

interface DraftState {
  name: string;
  value: string;
  busy: boolean;
  error: string | null;
}

const INITIAL_DRAFT: DraftState = { name: "", value: "", busy: false, error: null };

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
export function CitadelVaultRoutePage({ route, activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
  const nameId = useId();
  const valueId = useId();
  const [secrets, setSecrets] = useState<SecretsState>({ loading: true, error: null, items: [] });
  const [draft, setDraft] = useState<DraftState>(INITIAL_DRAFT);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setSecrets((current) => ({ ...current, loading: true, error: null }));
    try {
      const items = await listCitadelVaultSecrets(activeWorkspaceId);
      setSecrets({ loading: false, error: null, items });
    } catch (error) {
      setSecrets({ loading: false, error: getErrorMessage(error), items: [] });
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    setSecrets((current) => ({ ...current, loading: true, error: null }));
    void listCitadelVaultSecrets(activeWorkspaceId)
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
  }, [activeWorkspaceId]);

  const store = useCallback(async () => {
    if (draft.name.trim().length === 0 || draft.value.length === 0) {
      return;
    }
    setDraft((current) => ({ ...current, busy: true, error: null }));
    try {
      await storeCitadelVaultSecret(activeWorkspaceId, draft.name.trim(), draft.value);
      setDraft(INITIAL_DRAFT);
      await load();
    } catch (error) {
      setDraft((current) => ({ ...current, busy: false, error: describeStoreError(error) }));
    }
  }, [activeWorkspaceId, draft.name, draft.value, load]);

  const reveal = useCallback(
    async (secretId: string) => {
      try {
        const value = await revealCitadelVaultSecret(activeWorkspaceId, secretId);
        setRevealed((current) => ({ ...current, [secretId]: value }));
      } catch (error) {
        setRevealed((current) => ({ ...current, [secretId]: describeStoreError(error) }));
      }
    },
    [activeWorkspaceId],
  );

  const hide = useCallback((secretId: string) => {
    setRevealed((current) => {
      const next = { ...current };
      delete next[secretId];
      return next;
    });
  }, []);

  const remove = useCallback(
    async (secretId: string) => {
      try {
        await deleteCitadelVaultSecret(activeWorkspaceId, secretId);
        hide(secretId);
        await load();
      } catch (error) {
        setSecrets((current) => ({ ...current, error: getErrorMessage(error) }));
      }
    },
    [activeWorkspaceId, hide, load],
  );

  return (
    <NativePageFrame
      icon={KeyRound}
      area="library"
      kicker={routeKicker(route)}
      title="Vault"
      description={`Secrets for ${activeWorkspaceName}, sealed at rest under a per-Citadel key in your OS keychain. Names are listed; values are revealed only on request.`}
      loading={secrets.loading}
      error={secrets.error}
      onRetry={() => void load()}    >
      <NativeGrid>
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
                    <strong>{secret.secretName}</strong>
                    <div className="mc-next-vault-item-actions">
                      {revealed[secret.secretId] === undefined ? (
                        <NativeButton variant="default" onClick={() => void reveal(secret.secretId)}>
                          <Eye className="h-4 w-4" />
                          Reveal
                        </NativeButton>
                      ) : (
                        <NativeButton variant="default" onClick={() => hide(secret.secretId)}>
                          <EyeOff className="h-4 w-4" />
                          Hide
                        </NativeButton>
                      )}
                      <NativeButton
                        variant="outline"
                        className="danger"
                        onClick={() => setPendingDelete({ id: secret.secretId, name: secret.secretName })}
                        aria-label={`Delete ${secret.secretName}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </NativeButton>
                    </div>
                  </div>
                  {revealed[secret.secretId] !== undefined ? (
                    <code className="mc-next-vault-value">{revealed[secret.secretId]}</code>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </NativeCard>

        <NativeCard title="Store a secret" subtitle="It is sealed before it leaves the request and never written in plaintext.">
          {draft.error ? <NoticeBanner tone="error" message={draft.error} /> : null}
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
            disabled={draft.busy || draft.name.trim().length === 0 || draft.value.length === 0}
            onClick={() => void store()}
          >
            <Lock className="h-4 w-4" />
            {draft.busy ? "Sealing…" : "Seal & store"}
          </NativeButton>
        </NativeCard>
      </NativeGrid>

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
        <Lock className="h-3 w-3" aria-hidden="true" />
        AES-256-GCM, sealed under a per-Citadel key in your OS keychain. Per-Chamber keys and rotation are the deferred
        follow-on.
      </p>
    </NativePageFrame>
  );
}
